import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import ButtonGrid from './components/ButtonGrid'
import Timeline, { type TimelineButton } from './components/Timeline'
import NodeEditor from './components/NodeEditor'
import ActionInspector from './components/ActionInspector'
import AddActionModal from './components/AddActionModal'
import LibraryPanel from './components/LibraryPanel'
import type { ActionTemplate } from './components/AddActionModal'
import {
  CompanionConfig,
  ButtonControl,
  CompanionAction,
  ExecutionMode,
  TriggerKey,
  intToColor,
  parseBankKey
} from './types'
import { useCompanionSatellite } from './hooks/useCompanionSatellite'
import './styles.css'

function generateId(): string {
  return Math.random().toString(36).slice(2, 12)
}

export default function App() {
  const [config, setConfig] = useState<CompanionConfig | null>(null)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [isLiveDb, setIsLiveDb] = useState(false)
  const [selectedButtonKey, setSelectedButtonKey] = useState<string | null>(null)
  const [selectedAction, setSelectedAction] = useState<{
    id: string
    triggerKey: TriggerKey
    stepKey: string
  } | null>(null)
  const [dirty, setDirty] = useState(false)
  const [showLibrary, setShowLibrary] = useState(true)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [timelineVisibleMs, setTimelineVisibleMs] = useState(5000)
  const timelineVisibleMsRef = useRef(5000)
  const [activeView, setActiveView] = useState<'timeline' | 'nodes'>('timeline')
  const [labelEditing, setLabelEditing] = useState(false)
  const [labelDraft, setLabelDraft] = useState('')
  const animFrameRef = useRef<number | null>(null)
  const playStartRef = useRef<{ wallTime: number; startMs: number } | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [addingAction, setAddingAction] = useState<{
    stepKey: string; triggerKey: TriggerKey; delay: number
  } | null>(null)
  const [companionUpdate, setCompanionUpdate] = useState<{ filePath: string; content: string } | null>(null)
  const isLiveDbRef = useRef(isLiveDb)
  const dirtyRef = useRef(dirty)
  useEffect(() => { isLiveDbRef.current = isLiveDb }, [isLiveDb])
  useEffect(() => { dirtyRef.current = dirty }, [dirty])

  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  // Undo history
  const historyRef = useRef<CompanionConfig[]>([])

  const [companionHost, setCompanionHost] = useState('127.0.0.1')
  const [companionPort, setCompanionPort] = useState(8000)
  const [showHostInput, setShowHostInput] = useState(false)
  const [hostDraft, setHostDraft] = useState('127.0.0.1')
  const [recentConnections, setRecentConnections] = useState<{ host: string; port: number }[]>([])
  const [connectDraft, setConnectDraft] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  // Load settings on startup — do NOT auto-connect, show connection screen instead
  useEffect(() => {
    window.api.getSettings().then((s: any) => {
      const rawHost = s?.companionHost || '127.0.0.1'
      // Strip any port embedded in the host string from old settings format
      const lastColon = rawHost.lastIndexOf(':')
      let h = rawHost
      let p = s?.companionPort || 8000
      if (lastColon > 0) {
        const maybePort = parseInt(rawHost.slice(lastColon + 1), 10)
        if (!isNaN(maybePort) && maybePort > 0 && maybePort < 65536) {
          h = rawHost.slice(0, lastColon)
          if (!s?.companionPort) p = maybePort
        }
      }
      setCompanionHost(h)
      setCompanionPort(p)
      setHostDraft(p === 8000 ? h : `${h}:${p}`)
      setRecentConnections(s?.recentConnections || [])
    })
  }, [])

  const parseHostPort = (raw: string): { host: string; port: number } => {
    const trimmed = raw.trim() || '127.0.0.1'
    const lastColon = trimmed.lastIndexOf(':')
    if (lastColon > 0) {
      const maybePort = parseInt(trimmed.slice(lastColon + 1), 10)
      if (!isNaN(maybePort) && maybePort > 0 && maybePort < 65536)
        return { host: trimmed.slice(0, lastColon), port: maybePort }
    }
    return { host: trimmed, port: 8000 }
  }

  const handleConnect = useCallback(async (host: string, port: number) => {
    setConnectError(null)
    setConnecting(true)
    const display = port === 8000 ? host : `${host}:${port}`
    setCompanionHost(host)
    setCompanionPort(port)
    setHostDraft(display)
    await window.api.setSettings({ companionHost: host, companionPort: port })

    // Add to recent (non-local only, deduplicated, max 8)
    if (host !== '127.0.0.1' && host !== 'localhost') {
      setRecentConnections(prev => {
        const next = [{ host, port }, ...prev.filter(c => !(c.host === host && c.port === port))].slice(0, 8)
        window.api.setSettings({ recentConnections: next })
        return next
      })
    }

    let result: any
    try { result = await window.api.loadFromCompanion() } catch (e: any) { result = { error: String(e) } }
    setConnecting(false)
    if ('error' in result) { setConnectError(`Could not connect: ${result.error}`); return }
    try { loadConfigRef.current(JSON.parse(result.content), result.filePath, true) }
    catch (e) { setConnectError('Failed to parse config') }
  }, [])

  const removeRecent = useCallback((idx: number) => {
    setRecentConnections(prev => {
      const next = prev.filter((_, i) => i !== idx)
      window.api.setSettings({ recentConnections: next })
      return next
    })
  }, [])

  const clearRecent = useCallback(() => {
    setRecentConnections([])
    window.api.setSettings({ recentConnections: [] })
  }, [])

  const applyHost = useCallback(async (raw: string) => {
    const { host, port } = parseHostPort(raw)
    const display = port === 8000 ? host : `${host}:${port}`
    setHostDraft(display)
    setShowHostInput(false)
    setConfig(null)
    setFilePath(null)
    setIsLiveDb(false)
    await handleConnect(host, port)
  }, [handleConnect])

  // Satellite API — live button bitmaps + Companion detection
  const satellite = useCompanionSatellite(
    useCallback(() => {}, []),
    useCallback(() => {}, []),
    companionHost,
    companionPort
  )

  // Subscribe button grid to satellite when config, connection, or subscriptions change
  const allBankKeys = useMemo(() => {
    if (!config) return []
    return Object.keys(config.controls).filter(k => config.controls[k].type === 'button')
  }, [config])

  useEffect(() => {
    if (satellite.isConnected && satellite.subscriptionsEnabled)
      satellite.subscribeToPage(allBankKeys)
  }, [satellite.isConnected, satellite.subscriptionsEnabled, allBankKeys, satellite.subscribeToPage])

  // Debounced auto-save: after any change when live, write to Companion SQLite silently
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSave = useCallback(() => {
    if (!isLiveDbRef.current) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(() => {
      const cfg = configRef.current
      if (!cfg) return
      window.api.saveSilent(JSON.stringify(cfg)).then((result: any) => {
        if (!result?.createdButtons || Object.keys(result.createdButtons).length === 0) return
        // Assign the real Companion v5 IDs to newly-created buttons
        setConfig(prev => {
          if (!prev) return prev
          const updated = { ...prev, controls: { ...prev.controls } }
          for (const [bankKey, v5id] of Object.entries(result.createdButtons as Record<string, string>)) {
            const ctrl = updated.controls[bankKey]
            if (ctrl?.type === 'button') {
              updated.controls[bankKey] = { ...ctrl, _v5id: v5id, _empty: undefined } as any
            }
          }
          return updated
        })
      }).catch(() => {})
    }, 300)
  }, [])

  // Keep a ref to loadConfig so the startup effect can call the latest version
  const loadConfigRef = useRef<(parsed: CompanionConfig, path: string, live: boolean) => void>(() => {})

  const loadConfig = useCallback((parsed: CompanionConfig, path: string, live: boolean) => {
    setConfig(parsed)
    setFilePath(path)
    setIsLiveDb(live)
    setSelectedButtonKey(null)
    setSelectedAction(null)
    setDirty(false)
    setSaveStatus(null)
    setCompanionUpdate(null)
    try {
      localStorage.setItem('ct_last_config', JSON.stringify({ parsed, path, live }))
    } catch (_) {}
  }, [])
  useEffect(() => { loadConfigRef.current = loadConfig }, [loadConfig])


  // Subscribe to live Companion change events from the main process
  useEffect(() => {
    const unsub = window.api.onCompanionChange((data) => {
      if (!isLiveDbRef.current) return
      if (dirtyRef.current) {
        setCompanionUpdate(data)
      } else {
        try {
          const parsed: CompanionConfig = JSON.parse(data.content)
          setConfig(parsed)
          setFilePath(data.filePath)
          setSaveStatus('Synced ↺')
          setTimeout(() => setSaveStatus(null), 2000)
        } catch (_) {}
      }
    })
    return unsub
  }, [])

  // Load directly from Companion's live database
  const handleLoadFromCompanion = useCallback(async () => {
    const result = await window.api.loadFromCompanion()
    if ('error' in result) {
      alert('Could not read Companion database: ' + result.error)
      return
    }
    try {
      const parsed: CompanionConfig = JSON.parse(result.content)
      loadConfig(parsed, result.filePath, true)
    } catch (e) {
      alert('Failed to parse Companion database: ' + String(e))
    }
  }, [loadConfig])

  // Open a .companionconfig file
  const handleOpen = useCallback(async () => {
    const result = await window.api.openFile()
    if (!result) return
    try {
      const parsed: CompanionConfig = JSON.parse(result.content)
      loadConfig(parsed, result.filePath, false)
    } catch (e) {
      alert('Failed to parse config file: ' + String(e))
    }
  }, [loadConfig])

  // Expose loadConfig for test/screenshot injection
  useEffect(() => {
    (window as any).__injectConfig = (cfg: CompanionConfig) => loadConfig(cfg, '__test__', false)
  }, [loadConfig])

  // Save back — to Companion DB if live, otherwise to the file
  const handleSave = useCallback(async () => {
    if (!config) return
    const content = JSON.stringify(config, null, 2)

    if (isLiveDb) {
      const result = await window.api.saveToCompanion(content)
      if (!result || 'cancelled' in result) return
      if ('error' in result) {
        alert('Save failed: ' + result.error)
      } else {
        setDirty(false)
        setSaveStatus('Saved to Companion ✓')
        setTimeout(() => setSaveStatus(null), 3000)
      }
    } else {
      const savedPath = await window.api.saveFile(filePath ?? '', content)
      if (savedPath) {
        setFilePath(savedPath)
        setDirty(false)
        setSaveStatus('Saved ✓')
        setTimeout(() => setSaveStatus(null), 3000)
      }
    }
  }, [config, filePath, isLiveDb])

  const handleSaveAs = useCallback(async () => {
    if (!config) return
    const content = JSON.stringify(config, null, 2)
    const savedPath = await window.api.saveFileAs(content)
    if (savedPath) {
      setFilePath(savedPath)
      setIsLiveDb(false)
      setDirty(false)
    }
  }, [config])

  // Config mutation helper — saves current state to undo history before each change
  const updateButton = useCallback(
    (key: string, updater: (ctrl: ButtonControl) => ButtonControl) => {
      if (configRef.current) {
        historyRef.current = [...historyRef.current.slice(-20), configRef.current]
      }
      setConfig((prev) => {
        if (!prev) return prev
        const ctrl = prev.controls[key]
        if (!ctrl || ctrl.type !== 'button') return prev
        return {
          ...prev,
          controls: {
            ...prev.controls,
            [key]: updater(ctrl as ButtonControl)
          }
        }
      })
      setDirty(true)
      autoSave()
    },
    [autoSave]
  )

  const handleLabelCommit = useCallback((text: string) => {
    setLabelEditing(false)
    if (!selectedButtonKey) return
    updateButton(selectedButtonKey, ctrl => ({ ...ctrl, style: { ...ctrl.style, text } }))
  }, [selectedButtonKey, updateButton])

  const handleActionSelect = useCallback(
    (actionId: string | null, triggerKey: TriggerKey, stepKey: string) => {
      setSelectedAction(actionId ? { id: actionId, triggerKey, stepKey } : null)
    },
    []
  )

  const handleActionMove = useCallback(
    (stepKey: string, triggerKey: TriggerKey, actionId: string, newDelay: number) => {
      if (!selectedButtonKey) return
      updateButton(selectedButtonKey, (ctrl) => {
        const step = ctrl.steps[stepKey]
        const actions = step.action_sets[triggerKey] ?? []
        return {
          ...ctrl,
          steps: {
            ...ctrl.steps,
            [stepKey]: {
              ...step,
              action_sets: {
                ...step.action_sets,
                [triggerKey]: actions.map((a) =>
                  a.id === actionId ? { ...a, delay: newDelay } : a
                )
              }
            }
          }
        }
      })
    },
    [selectedButtonKey, updateButton]
  )

  const handleActionAdd = useCallback(
    (stepKey: string, triggerKey: TriggerKey, delay: number) => {
      if (!selectedButtonKey) return
      // Open modal to pick connection + action
      setAddingAction({ stepKey, triggerKey, delay })
    },
    [selectedButtonKey]
  )

  const handleModalAdd = useCallback(
    (template: ActionTemplate) => {
      if (!selectedButtonKey || !addingAction) return
      const { stepKey, triggerKey, delay } = addingAction
      const newAction: CompanionAction = {
        id: generateId(),
        action: template.definitionId,
        instance: template.connectionId,
        options: template.options,
        delay
      }
      updateButton(selectedButtonKey, (ctrl) => {
        const step = ctrl.steps[stepKey]
        const existing = step.action_sets[triggerKey] ?? []
        return {
          ...ctrl,
          steps: {
            ...ctrl.steps,
            [stepKey]: {
              ...step,
              action_sets: {
                ...step.action_sets,
                [triggerKey]: [...existing, newAction]
              }
            }
          }
        }
      })
      setSelectedAction({ id: newAction.id, triggerKey, stepKey })
      setAddingAction(null)
    },
    [selectedButtonKey, addingAction, updateButton]
  )

  const handleActionDelete = useCallback(
    (stepKey: string, triggerKey: TriggerKey, actionId: string) => {
      if (!selectedButtonKey) return
      updateButton(selectedButtonKey, (ctrl) => {
        const step = ctrl.steps[stepKey]
        const actions = step.action_sets[triggerKey] ?? []
        return {
          ...ctrl,
          steps: {
            ...ctrl.steps,
            [stepKey]: {
              ...step,
              action_sets: {
                ...step.action_sets,
                [triggerKey]: actions.filter((a) => a.id !== actionId)
              }
            }
          }
        }
      })
      if (selectedAction?.id === actionId) setSelectedAction(null)
    },
    [selectedButtonKey, updateButton, selectedAction]
  )

  const handleActionDrop = useCallback(
    (stepKey: string, triggerKey: TriggerKey, delay: number, template: { connectionId: string; definitionId: string; options: Record<string, unknown> }) => {
      if (!selectedButtonKey) return
      const newAction: CompanionAction = {
        id: generateId(),
        instance: template.connectionId,
        action: template.definitionId,
        delay,
        options: (template.options as Record<string, unknown>) ?? {}
      }
      updateButton(selectedButtonKey, (ctrl) => {
        const s = ctrl.steps[stepKey] ?? { action_sets: {} }
        return {
          ...ctrl,
          steps: {
            ...ctrl.steps,
            [stepKey]: {
              ...s,
              action_sets: {
                ...s.action_sets,
                [triggerKey]: [...(s.action_sets[triggerKey] ?? []), newAction]
              }
            }
          }
        }
      })
      setSelectedAction({ id: newAction.id, triggerKey: triggerKey as TriggerKey, stepKey })
    },
    [selectedButtonKey, updateButton]
  )

  const handleActionChange = useCallback(
    (updated: CompanionAction) => {
      if (!selectedButtonKey || !selectedAction) return
      updateButton(selectedButtonKey, (ctrl) => {
        const step = ctrl.steps[selectedAction.stepKey]
        const actions = step.action_sets[selectedAction.triggerKey] ?? []
        return {
          ...ctrl,
          steps: {
            ...ctrl.steps,
            [selectedAction.stepKey]: {
              ...step,
              action_sets: {
                ...step.action_sets,
                [selectedAction.triggerKey]: actions.map((a) =>
                  a.id === updated.id ? updated : a
                )
              }
            }
          }
        }
      })
    },
    [selectedButtonKey, selectedAction, updateButton]
  )

  const selectedControl = useMemo(() => {
    if (!config || !selectedButtonKey) return null
    const ctrl = config.controls[selectedButtonKey]
    return ctrl?.type === 'button' ? (ctrl as ButtonControl) : null
  }, [config, selectedButtonKey])

  const timelineButtons = useMemo((): TimelineButton[] => {
    if (!config || !selectedButtonKey) return []
    const ctrl = config.controls[selectedButtonKey]
    if (!ctrl || ctrl.type !== 'button') return []
    const bc = ctrl as ButtonControl
    const ref = parseBankKey(selectedButtonKey)
    if (!ref) return []
    const pageLabel = config.page?.[ref.page]?.name || `Page ${ref.page}`
    return [{
      key: selectedButtonKey,
      label: bc.style?.text?.trim() || `Slot ${ref.slot}`,
      pageSlot: `${pageLabel} · ${ref.slot}`,
      control: bc
    }]
  }, [config, selectedButtonKey])

  const selectedActionData = useMemo(() => {
    if (!selectedControl || !selectedAction) return null
    const step = selectedControl.steps[selectedAction.stepKey]
    if (!step) return null
    const actions = step.action_sets[selectedAction.triggerKey] ?? []
    return actions.find((a) => a.id === selectedAction.id) ?? null
  }, [selectedControl, selectedAction])

  // Gap (ms) from the selected action to the next one in the same action set
  const waitAfterMs = useMemo<number | null>(() => {
    if (!selectedControl || !selectedAction || !selectedActionData) return null
    const step = selectedControl.steps[selectedAction.stepKey]
    if (!step) return null
    const sorted = [...(step.action_sets[selectedAction.triggerKey] ?? [])]
      .sort((a, b) => a.delay - b.delay)
    const idx = sorted.findIndex(a => a.id === selectedAction.id)
    if (idx === -1 || idx === sorted.length - 1) return null  // no next action
    return sorted[idx + 1].delay - selectedActionData.delay
  }, [selectedControl, selectedAction, selectedActionData])

  const handleSetWaitAfter = useCallback((ms: number) => {
    if (!selectedButtonKey || !selectedAction) return
    updateButton(selectedButtonKey, (ctrl) => {
      const s = ctrl.steps[selectedAction.stepKey]
      if (!s) return ctrl
      const actions = s.action_sets[selectedAction.triggerKey] ?? []
      const sorted = [...actions].sort((a, b) => a.delay - b.delay)
      const idx = sorted.findIndex(a => a.id === selectedAction.id)
      if (idx === -1 || idx === sorted.length - 1) return ctrl
      const selected = sorted[idx]
      const nextAction = sorted[idx + 1]
      const targetDelay = selected.delay + Math.max(0, ms)
      const delta = targetDelay - nextAction.delay
      if (delta === 0) return ctrl
      const shiftIds = new Set(sorted.slice(idx + 1).map(a => a.id))
      return {
        ...ctrl,
        steps: {
          ...ctrl.steps,
          [selectedAction.stepKey]: {
            ...s,
            action_sets: {
              ...s.action_sets,
              [selectedAction.triggerKey]: actions.map(a =>
                shiftIds.has(a.id) ? { ...a, delay: Math.max(0, a.delay + delta) } : a
              )
            }
          }
        }
      }
    })
  }, [selectedButtonKey, selectedAction, updateButton])

  // Open the Add Action modal at the computed delay so the user picks a real action
  const handleAddActionAfter = useCallback((ms: number) => {
    if (!selectedAction || !selectedButtonKey) return
    const ctrl = configRef.current?.controls[selectedButtonKey]
    if (!ctrl || ctrl.type !== 'button') return
    const actions = (ctrl as ButtonControl).steps[selectedAction.stepKey]?.action_sets[selectedAction.triggerKey] ?? []
    const actionData = actions.find(a => a.id === selectedAction.id)
    if (!actionData) return
    setAddingAction({
      stepKey: selectedAction.stepKey,
      triggerKey: selectedAction.triggerKey,
      delay: actionData.delay + Math.max(0, ms)
    })
  }, [selectedAction, selectedButtonKey])

  // Cmd+Z undo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        const prev = historyRef.current[historyRef.current.length - 1]
        if (!prev) return
        historyRef.current = historyRef.current.slice(0, -1)
        setConfig(prev)
        setDirty(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const stopAnimation = useCallback(() => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    playStartRef.current = null
  }, [])

  const handlePause = useCallback(() => {
    stopAnimation()
    setIsPlaying(false)
    setIsPaused(true)
  }, [stopAnimation])

  const handleStop = useCallback(() => {
    stopAnimation()
    setIsPlaying(false)
    setIsPaused(false)
    setPlayheadMs(0)
  }, [stopAnimation])

  const startPlayFrom = useCallback((startMs: number, selectedControl: ButtonControl | null, selectedButtonKey: string | null) => {
    if (!selectedControl) return
    const allDelays = Object.values(selectedControl.steps).flatMap(s =>
      Object.values(s.action_sets).flatMap(acts => (acts ?? []).map(a => a.delay))
    )
    // Tail = time for playhead to visually clear the last 100px action block
    // pxPerMs ≈ (containerWidth≈800) / visibleMs  →  tail = 100 * visibleMs / 800
    const tail = Math.max(300, Math.round(timelineVisibleMsRef.current / 8))
    const maxMs = Math.max(0, ...allDelays) + tail
    if (startMs >= maxMs) { setPlayheadMs(0); return }

    setIsPlaying(true)
    setIsPaused(false)
    playStartRef.current = { wallTime: performance.now(), startMs }

    if (satellite.isConnected && selectedButtonKey) {
      satellite.pressButton(selectedButtonKey, true)
      setTimeout(() => satellite.pressButton(selectedButtonKey, false), 50)
    }

    const tick = () => {
      const ref = playStartRef.current
      if (!ref) return
      const elapsed = performance.now() - ref.wallTime
      const currentMs = ref.startMs + elapsed
      setPlayheadMs(currentMs)
      if (currentMs < maxMs) {
        animFrameRef.current = requestAnimationFrame(tick)
      } else {
        setPlayheadMs(maxMs)
        setIsPlaying(false)
        setIsPaused(false)
        playStartRef.current = null
      }
    }
    animFrameRef.current = requestAnimationFrame(tick)
  }, [satellite])

  const handlePlay = useCallback(() => {
    if (!selectedButtonKey || !selectedControl) return
    if (isPlaying) { handlePause(); return }
    // Resume from current position (whether paused or freshly started)
    startPlayFrom(isPaused ? playheadMs : playheadMs, selectedControl, selectedButtonKey)
  }, [selectedButtonKey, selectedControl, isPlaying, isPaused, playheadMs, startPlayFrom, handlePause])

  // Arrow key scrubbing when not playing
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isPlaying) return
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return
      // Don't steal arrow keys from inputs
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      e.preventDefault()
      const step = e.shiftKey ? 500 : e.ctrlKey || e.metaKey ? 100 : 50
      setPlayheadMs(ms => Math.max(0, ms + (e.key === 'ArrowRight' ? step : -step)))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isPlaying])

  // Space = play/pause, Escape = stop
  const handlePlayRef = useRef(handlePlay)
  const handleStopRef = useRef(handleStop)
  handlePlayRef.current = handlePlay
  handleStopRef.current = handleStop
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === ' ') { e.preventDefault(); handlePlayRef.current() }
      if (e.key === 'Escape') { e.preventDefault(); handleStopRef.current() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Stop playback and close label editor when button changes
  useEffect(() => { stopAnimation(); setIsPlaying(false); setIsPaused(false); setLabelEditing(false) }, [selectedButtonKey]) // eslint-disable-line

  const instances = config?.instances ?? {}

  // Collect all known action definition IDs across all controls for autocomplete
  const knownActionIds = useMemo(() => {
    if (!config) return []
    const ids = new Set<string>()
    for (const ctrl of Object.values(config.controls)) {
      if (ctrl.type !== 'button') continue
      for (const step of Object.values((ctrl as ButtonControl).steps)) {
        for (const actions of Object.values(step.action_sets)) {
          for (const a of (actions ?? [])) ids.add(a.action)
        }
      }
    }
    return [...ids].filter(Boolean).sort()
  }, [config])

  // Step management
  const handleStepAdd = useCallback(() => {
    if (!selectedButtonKey) return
    updateButton(selectedButtonKey, (ctrl) => {
      const nextKey = String(Object.keys(ctrl.steps).length)
      return {
        ...ctrl,
        steps: {
          ...ctrl.steps,
          [nextKey]: { action_sets: { down: [], up: [] }, options: { runWhileHeld: [] } }
        }
      }
    })
  }, [selectedButtonKey, updateButton])

  const handleStepRemove = useCallback((stepKey: string) => {
    if (!selectedButtonKey) return
    updateButton(selectedButtonKey, (ctrl) => {
      const remaining = Object.entries(ctrl.steps).filter(([k]) => k !== stepKey)
      const reindexed: Record<string, typeof ctrl.steps[string]> = {}
      remaining.forEach(([, v], i) => { reindexed[String(i)] = v })
      return { ...ctrl, steps: reindexed }
    })
  }, [selectedButtonKey, updateButton])

  const handleTriggerAdd = useCallback((stepKey: string, holdMs: number) => {
    if (!selectedButtonKey) return
    updateButton(selectedButtonKey, (ctrl) => {
      const step = ctrl.steps[stepKey]
      if (!step || String(holdMs) in step.action_sets) return ctrl
      return {
        ...ctrl,
        steps: {
          ...ctrl.steps,
          [stepKey]: {
            ...step,
            action_sets: { ...step.action_sets, [String(holdMs)]: [] }
          }
        }
      }
    })
  }, [selectedButtonKey, updateButton])

  const handleActionDelayChange = useCallback(
    (stepKey: string, triggerKey: TriggerKey, actionId: string, newDelay: number) => {
      if (!selectedButtonKey) return
      updateButton(selectedButtonKey, (ctrl) => {
        const step = ctrl.steps[stepKey]
        const actions = step.action_sets[triggerKey] ?? []
        return {
          ...ctrl,
          steps: {
            ...ctrl.steps,
            [stepKey]: {
              ...step,
              action_sets: {
                ...step.action_sets,
                [triggerKey]: actions.map(a =>
                  a.id === actionId ? { ...a, delay: newDelay } : a
                )
              }
            }
          }
        }
      })
    },
    [selectedButtonKey, updateButton]
  )

  const handleExecutionModeChange = useCallback(
    (stepKey: string, triggerKey: TriggerKey, mode: ExecutionMode) => {
      if (!selectedButtonKey) return
      updateButton(selectedButtonKey, (ctrl) => {
        const step = ctrl.steps[stepKey]
        const actions = step.action_sets[triggerKey] ?? []
        return {
          ...ctrl,
          steps: {
            ...ctrl.steps,
            [stepKey]: {
              ...step,
              action_sets: {
                ...step.action_sets,
                // Update execution_mode on every action_group in this track
                [triggerKey]: actions.map(a =>
                  (a.instance === 'internal' && a.action === 'action_group')
                    ? { ...a, options: { ...a.options, execution_mode: mode } }
                    : a
                )
              }
            }
          }
        }
      })
    },
    [selectedButtonKey, updateButton]
  )

  const handleTriggerRemove = useCallback((stepKey: string, triggerKey: TriggerKey) => {
    if (!selectedButtonKey) return
    updateButton(selectedButtonKey, (ctrl) => {
      const step = ctrl.steps[stepKey]
      if (!step) return ctrl
      const { [triggerKey]: _removed, ...rest } = step.action_sets
      return {
        ...ctrl,
        steps: { ...ctrl.steps, [stepKey]: { ...step, action_sets: rest } }
      }
    })
    if (selectedAction?.triggerKey === triggerKey && selectedAction?.stepKey === stepKey) {
      setSelectedAction(null)
    }
  }, [selectedButtonKey, updateButton, selectedAction])

  const buttonStyle = selectedControl?.style
  const bgColor = buttonStyle ? intToColor(buttonStyle.bgcolor ?? 0) : '#1a1a1a'
  const fgColor = buttonStyle ? intToColor(buttonStyle.color ?? 0xffffff) : '#fff'

  const titleLabel = isLiveDb || satellite.isConnected
    ? 'Companion (live)'
    : filePath
      ? filePath.split('/').pop()!
      : 'Companion Timeline'

  return (
    <div className="app" onKeyDown={e => e.key === 'Escape' && setAddingAction(null)}>
      {companionUpdate && (
        <div className="sync-banner">
          <span>Companion was updated — you have unsaved edits.</span>
          <button className="sync-banner-btn" onClick={() => {
            try {
              const parsed: CompanionConfig = JSON.parse(companionUpdate.content)
              loadConfig(parsed, companionUpdate.filePath, true)
            } catch (_) {}
          }}>Reload from Companion</button>
          <button className="sync-banner-dismiss" onClick={() => setCompanionUpdate(null)}>Dismiss</button>
        </div>
      )}
      {addingAction && (
        <AddActionModal
          onAdd={handleModalAdd}
          onClose={() => setAddingAction(null)}
        />
      )}
      <div className="titlebar">
        <div className="titlebar-drag" />
        <div className="titlebar-title">
          {(isLiveDb || satellite.isConnected) && <span className="live-badge">LIVE</span>}
          {titleLabel}
          {dirty && !isLiveDb && <span className="dirty-dot" />}
          {saveStatus && <span className="save-status">{saveStatus}</span>}
          <span className="app-version" title={`Built ${__BUILD_DATE__}`}>v{__APP_VERSION__} · build {__BUILD_NUMBER__}</span>
        </div>
        <div className="titlebar-actions">
          <button
            className={`toolbar-btn host-btn ${companionHost !== '127.0.0.1' ? 'host-btn--remote' : ''}`}
            onClick={() => { setConfig(null); setConnectError(null) }}
            title={`Connected to ${hostDraft} — click to change`}
          >
            {companionHost === '127.0.0.1' ? '⌂ Local' : `⇄ ${hostDraft}`}
          </button>
          <button
            className="toolbar-btn"
            onClick={handleStop}
            disabled={!isPlaying && !isPaused}
            title="Stop and reset to start [Esc]"
          >■</button>
          <button
            className={`toolbar-btn ${isPlaying ? 'toolbar-btn--playing' : isPaused ? 'toolbar-btn--active' : ''}`}
            onClick={handlePlay}
            disabled={!selectedButtonKey || !selectedControl}
            title={isPlaying ? 'Pause [Space]' : isPaused ? 'Resume [Space]' : 'Play from playhead [Space] · Arrow keys to nudge · Shift+Arrow = 500ms · Cmd+Arrow = 100ms'}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button
            className="toolbar-btn toolbar-btn--test"
            onMouseDown={() => selectedButtonKey && satellite.isConnected && satellite.pressButton(selectedButtonKey, true)}
            onMouseUp={() => selectedButtonKey && satellite.isConnected && satellite.pressButton(selectedButtonKey, false)}
            onMouseLeave={() => selectedButtonKey && satellite.isConnected && satellite.pressButton(selectedButtonKey, false)}
            disabled={!selectedButtonKey || !satellite.isConnected}
            title={satellite.isConnected ? 'Hold to test this button in Companion' : 'Not connected to Companion'}
          >
            ▶ Test
          </button>
          <button
            className={`toolbar-btn ${showLibrary ? 'toolbar-btn--active' : ''}`}
            onClick={() => setShowLibrary(v => !v)}
            title="Toggle action library"
          >⊞ Library</button>
          {isLiveDb && (
            <button className="toolbar-btn" onClick={handleLoadFromCompanion} title="Re-read Companion database and discard local changes">↺ Reload</button>
          )}
          <button className="toolbar-btn" onClick={handleOpen}>Open File…</button>
          {!isLiveDb && (
            <button className="toolbar-btn" onClick={handleSave} disabled={!config}>Save</button>
          )}
          <button className="toolbar-btn" onClick={handleSaveAs} disabled={!config}>Save As…</button>
        </div>
      </div>

      {!config ? (
        <div className="welcome">
          <div className="welcome-card connection-card">
            <div className="welcome-icon">⏱</div>
            <h1>Companion Timeline</h1>
            <p className="conn-subtitle">Choose a Companion to connect to:</p>

            <button
              className="conn-option conn-option--local"
              onClick={() => handleConnect('127.0.0.1', 8000)}
              disabled={connecting}
            >
              <span className="conn-option-icon">⌂</span>
              <span className="conn-option-label">Local Companion</span>
              <span className="conn-option-addr">127.0.0.1</span>
              {satellite.isConnected && companionHost === '127.0.0.1' && (
                <span className="conn-live-dot" title="Connected" />
              )}
            </button>

            {recentConnections.length > 0 && (
              <>
                <div className="conn-section-label">
                  Recent
                  <button className="conn-clear-btn" onClick={clearRecent}>Clear all</button>
                </div>
                {recentConnections.map((conn, i) => (
                  <div key={i} className="conn-option-row">
                    <button
                      className="conn-option"
                      onClick={() => handleConnect(conn.host, conn.port)}
                      disabled={connecting}
                    >
                      <span className="conn-option-icon">⇄</span>
                      <span className="conn-option-label">
                        {conn.host}{conn.port !== 8000 ? `:${conn.port}` : ''}
                      </span>
                    </button>
                    <button className="conn-remove-btn" onClick={() => removeRecent(i)} title="Remove">×</button>
                  </div>
                ))}
              </>
            )}

            <div className="conn-section-label">Connect to address</div>
            <form
              className="conn-manual"
              onSubmit={e => {
                e.preventDefault()
                const { host, port } = parseHostPort(connectDraft || '127.0.0.1')
                handleConnect(host, port)
              }}
            >
              <input
                className="conn-input"
                placeholder="192.168.1.x or 192.168.1.x:8000"
                value={connectDraft}
                onChange={e => setConnectDraft(e.target.value)}
                disabled={connecting}
              />
              <button type="submit" className="conn-go-btn" disabled={connecting || !connectDraft.trim()}>
                {connecting ? '…' : 'Connect'}
              </button>
            </form>

            {connectError && <div className="conn-error">{connectError}</div>}

            <div className="conn-divider" />
            <button className="welcome-open-btn welcome-open-btn--secondary" onClick={handleOpen}>
              Open Config File…
            </button>
          </div>
        </div>
      ) : (
        <div className="workspace">
          <div className="sidebar-panel">
            <div className="sidebar-header">Buttons</div>
            <ButtonGrid
              config={config}
              selectedKey={selectedButtonKey}
              buttonStates={satellite.buttonStates}
              onSelect={(key) => {
                if (key === selectedButtonKey) return
                setSelectedButtonKey(key)
                setSelectedAction(null)
                setPlayheadMs(0)
              }}
            />
          </div>

          {showLibrary && (
            <LibraryPanel />
          )}

          <div className="main-panel">
            {selectedControl && (
              <div className="button-header" style={{ backgroundColor: bgColor, color: fgColor }}>
                <span className="button-header-key">{selectedButtonKey}</span>
                {labelEditing ? (
                  <input
                    className="button-header-label-input"
                    autoFocus
                    value={labelDraft}
                    onChange={e => setLabelDraft(e.target.value)}
                    onBlur={e => handleLabelCommit(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.currentTarget.blur() }
                      if (e.key === 'Escape') { setLabelEditing(false) }
                    }}
                  />
                ) : (
                  <span
                    className="button-header-text button-header-text--editable"
                    title="Click to edit label"
                    onClick={() => { setLabelDraft(buttonStyle?.text ?? ''); setLabelEditing(true) }}
                  >
                    {buttonStyle?.text || '(no label)'}
                  </span>
                )}
              </div>
            )}
            <div className="view-tabs">
              <button
                className={`view-tab ${activeView === 'timeline' ? 'view-tab--active' : ''}`}
                onClick={() => setActiveView('timeline')}
              >Timeline</button>
              <button
                className={`view-tab ${activeView === 'nodes' ? 'view-tab--active' : ''}`}
                onClick={() => setActiveView('nodes')}
              >Node</button>
            </div>
            {activeView === 'timeline' ? (
              <Timeline
                buttons={timelineButtons}
                selectedKey={selectedButtonKey}
                instances={instances}
                selectedActionId={selectedAction?.id ?? null}
                playheadMs={playheadMs}
                onPlayheadChange={setPlayheadMs}
                onActionSelect={handleActionSelect}
                onActionMove={handleActionMove}
                onActionAdd={handleActionAdd}
                onActionDrop={handleActionDrop}
                onActionDelete={handleActionDelete}
                onStepAdd={handleStepAdd}
                onStepRemove={handleStepRemove}
                onTriggerAdd={handleTriggerAdd}
                onTriggerRemove={handleTriggerRemove}
                onActionDelayChange={handleActionDelayChange}
                onExecutionModeChange={handleExecutionModeChange}
                onVisibleMsChange={ms => { timelineVisibleMsRef.current = ms; setTimelineVisibleMs(ms) }}
              />
            ) : (
              <NodeEditor
                control={selectedControl}
                instances={instances}
                selectedActionId={selectedAction?.id ?? null}
                onActionSelect={handleActionSelect}
                onActionDrop={handleActionDrop}
                onStepAdd={handleStepAdd}
                onStepRemove={handleStepRemove}
              />
            )}
          </div>

          {selectedActionData && selectedAction ? (
            <div className="inspector-panel">
              <ActionInspector
                action={selectedActionData}
                triggerKey={selectedAction.triggerKey}
                stepKey={selectedAction.stepKey}
                instances={instances}
                knownActionIds={knownActionIds}
                waitAfterMs={waitAfterMs}
                onChange={handleActionChange}
                onSetWaitAfter={handleSetWaitAfter}
                onAddActionAfter={handleAddActionAfter}
                onDelete={() =>
                  handleActionDelete(
                    selectedAction.stepKey,
                    selectedAction.triggerKey,
                    selectedAction.id
                  )
                }
              />
            </div>
          ) : (
            <div className="inspector-panel inspector-panel--empty">
              <p>Select an action to inspect</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
