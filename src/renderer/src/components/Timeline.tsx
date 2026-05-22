import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react'
import {
  ButtonControl,
  CompanionAction,
  ExecutionMode,
  TriggerKey,
  triggerLabel,
  CompanionInstance
} from '../types'

interface Props {
  buttonKey: string
  control: ButtonControl
  instances: Record<string, CompanionInstance>
  selectedActionId: string | null
  onActionSelect: (actionId: string | null, triggerKey: TriggerKey, stepKey: string) => void
  onActionMove: (stepKey: string, triggerKey: TriggerKey, actionId: string, newDelay: number) => void
  onActionAdd: (stepKey: string, triggerKey: TriggerKey, delay: number) => void
  onActionDelete: (stepKey: string, triggerKey: TriggerKey, actionId: string) => void
  onStepAdd: () => void
  onStepRemove: (stepKey: string) => void
  onTriggerAdd: (stepKey: string, holdMs: number) => void
  onTriggerRemove: (stepKey: string, triggerKey: TriggerKey) => void
  onActionDelayChange: (stepKey: string, triggerKey: TriggerKey, actionId: string, newDelay: number) => void
  onExecutionModeChange: (stepKey: string, triggerKey: TriggerKey, mode: ExecutionMode) => void
}

const LANE_HEIGHT = 72      // height of one action lane
const LANE_PAD = 6          // top/bottom padding inside a lane
const LABEL_WIDTH = 100
const MIN_ZOOM_MS = 500
const MAX_ZOOM_MS = 30000
const RULER_HEIGHT = 28
const ACTION_MIN_WIDTH = 80
const CLIP_EST_PX_PER_CHAR = 7  // rough estimate for overlap detection

// Assign each action to a lane so overlapping clips stack vertically.
function assignLanes(
  actions: { id: string; delay: number; action: string }[],
  msToPx: (ms: number) => number,
  getWidth?: (a: { id: string; delay: number; action: string }) => number
): { id: string; lane: number }[] {
  const laneEdge: number[] = []
  const result: { id: string; lane: number }[] = []

  for (const a of [...actions].sort((x, y) => x.delay - y.delay)) {
    const x = msToPx(a.delay)
    const width = getWidth
      ? getWidth(a)
      : Math.max(ACTION_MIN_WIDTH, (a.action?.length ?? 4) * CLIP_EST_PX_PER_CHAR + 20)
    const right = x + width

    let placed = false
    for (let lane = 0; lane < laneEdge.length; lane++) {
      if (x >= laneEdge[lane]) {
        laneEdge[lane] = right
        result.push({ id: a.id, lane })
        placed = true
        break
      }
    }
    if (!placed) {
      result.push({ id: a.id, lane: laneEdge.length })
      laneEdge.push(right)
    }
  }

  return result
}

function msToLabel(ms: number): string {
  if (ms === 0) return '0'
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`
  return `${ms}ms`
}

function snapToGrid(ms: number, snapMs: number): number {
  return Math.round(ms / snapMs) * snapMs
}

function getSnapMs(visibleMs: number): number {
  for (const s of [10, 25, 50, 100, 250, 500, 1000, 2000, 5000]) {
    if (visibleMs / s <= 20) return s
  }
  return 5000
}

const TRIGGERS: TriggerKey[] = ['down', 'up']

export default function Timeline({
  buttonKey,
  control,
  instances,
  selectedActionId,
  onActionSelect,
  onActionMove,
  onActionAdd,
  onActionDelete,
  onStepAdd,
  onStepRemove,
  onTriggerAdd,
  onTriggerRemove,
  onActionDelayChange,
  onExecutionModeChange,
}: Props) {
  const trackAreaRef = useRef<HTMLDivElement>(null)
  const [visibleMs, setVisibleMs] = useState(5000)
  const [scrollMs, setScrollMs] = useState(0)
  const [activeStepKey, setActiveStepKey] = useState<string>('0')
  const [addingHold, setAddingHold] = useState(false)
  const [holdInput, setHoldInput] = useState('2000')
  const [editingWaitId, setEditingWaitId] = useState<string | null>(null)
  const [waitInput, setWaitInput] = useState('')
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; stepKey: string; triggerKey: TriggerKey; actionId: string
  } | null>(null)

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [contextMenu])

  const MIN_ACTION_WIDTH = 100   // fixed action section width
  const MIN_WAIT_PX = 54         // min wait section width when a wait exists

  const snapMs = getSnapMs(visibleMs)
  const stepKeys = Object.keys(control.steps).sort()

  // If active step was removed, reset to first
  const currentStepKey = stepKeys.includes(activeStepKey) ? activeStepKey : (stepKeys[0] ?? '0')

  const tracks = useMemo(() => {
    const step = control.steps[currentStepKey]
    if (!step) return []
    const result: { triggerKey: TriggerKey; actions: CompanionAction[] }[] = []
    // Standard triggers first, then any numeric hold triggers
    const allTriggers = Object.keys(step.action_sets)
    const ordered = [
      ...TRIGGERS.filter(t => allTriggers.includes(t)),
      ...allTriggers.filter(t => !TRIGGERS.includes(t as TriggerKey)).sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b)
        return isNaN(na) ? 1 : isNaN(nb) ? -1 : na - nb
      })
    ] as TriggerKey[]
    for (const tKey of ordered) {
      result.push({ triggerKey: tKey, actions: step.action_sets[tKey] ?? [] })
    }
    return result
  }, [control, currentStepKey])

  const pxPerMs = useCallback(
    (w: number) => w / visibleMs,
    [visibleMs]
  )
  const msToPx = useCallback(
    (ms: number, w: number) => (ms - scrollMs) * pxPerMs(w),
    [scrollMs, pxPerMs]
  )
  const pxToMs = useCallback(
    (px: number, w: number) => px / pxPerMs(w) + scrollMs,
    [scrollMs, pxPerMs]
  )

  const dragRef = useRef<{
    actionId: string; stepKey: string; triggerKey: TriggerKey
    startDelay: number; startX: number; containerWidth: number
  } | null>(null)

  // Resize handle: dragging right edge of a clip changes the NEXT action's delay
  const resizeRef = useRef<{
    nextActionId: string; stepKey: string; triggerKey: TriggerKey
    startNextDelay: number; minDelay: number
    startX: number; containerWidth: number
  } | null>(null)

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent, nextAction: CompanionAction, minDelay: number, triggerKey: TriggerKey) => {
      e.preventDefault()
      e.stopPropagation()
      const w = (trackAreaRef.current?.clientWidth ?? 900) - LABEL_WIDTH
      resizeRef.current = {
        nextActionId: nextAction.id,
        stepKey: currentStepKey,
        triggerKey,
        startNextDelay: nextAction.delay,
        minDelay,
        startX: e.clientX,
        containerWidth: w
      }
      const ppm = pxPerMs(w)
      const onMove = (ev: MouseEvent) => {
        if (!resizeRef.current) return
        const dx = ev.clientX - resizeRef.current.startX
        const newDelay = Math.max(
          resizeRef.current.minDelay,
          snapToGrid(resizeRef.current.startNextDelay + dx / ppm, snapMs)
        )
        onActionDelayChange(
          resizeRef.current.stepKey,
          resizeRef.current.triggerKey,
          resizeRef.current.nextActionId,
          newDelay
        )
      }
      const onUp = () => {
        resizeRef.current = null
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [currentStepKey, pxPerMs, snapMs, onActionDelayChange]
  )

  const handleActionMouseDown = useCallback(
    (e: React.MouseEvent, action: CompanionAction, triggerKey: TriggerKey) => {
      e.preventDefault()
      e.stopPropagation()
      onActionSelect(action.id, triggerKey, currentStepKey)
      const w = (trackAreaRef.current?.clientWidth ?? 900) - LABEL_WIDTH
      dragRef.current = { actionId: action.id, stepKey: currentStepKey, triggerKey, startDelay: action.delay, startX: e.clientX, containerWidth: w }
      const ppm = pxPerMs(w)
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return
        const dx = ev.clientX - dragRef.current.startX
        const newDelay = Math.max(0, snapToGrid(dragRef.current.startDelay + dx / ppm, snapMs))
        onActionMove(dragRef.current.stepKey, dragRef.current.triggerKey, dragRef.current.actionId, newDelay)
      }
      const onUp = () => { dragRef.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [onActionSelect, onActionMove, pxPerMs, snapMs, currentStepKey]
  )

  const handleTrackDoubleClick = useCallback(
    (e: React.MouseEvent, triggerKey: TriggerKey) => {
      const w = (trackAreaRef.current?.clientWidth ?? 900) - LABEL_WIDTH
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const ms = Math.max(0, snapToGrid(pxToMs(e.clientX - rect.left, w), snapMs))
      onActionAdd(currentStepKey, triggerKey, ms)
    },
    [pxToMs, snapMs, onActionAdd, currentStepKey]
  )

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    if (e.metaKey || e.ctrlKey) {
      setVisibleMs(v => Math.max(MIN_ZOOM_MS, Math.min(MAX_ZOOM_MS, v * (e.deltaY > 0 ? 1.2 : 0.8))))
    } else {
      const w = (trackAreaRef.current?.clientWidth ?? 900) - LABEL_WIDTH
      setScrollMs(s => Math.max(0, s + (e.deltaX || e.deltaY) / pxPerMs(w)))
    }
  }, [pxPerMs])

  const containerWidth = (trackAreaRef.current?.clientWidth ?? 900) - LABEL_WIDTH

  const renderRuler = () => {
    const ticks: React.ReactNode[] = []
    let t = Math.floor(scrollMs / snapMs) * snapMs
    while (t <= scrollMs + visibleMs) {
      const x = msToPx(t, containerWidth)
      if (x >= 0 && x <= containerWidth) {
        ticks.push(
          <div key={t} className="ruler-tick" style={{ left: x }}>
            <span className="ruler-label">{msToLabel(t)}</span>
          </div>
        )
      }
      t += snapMs
    }
    return ticks
  }

  return (
    <div className="timeline-wrap">
      {/* Step tabs */}
      <div className="step-bar">
        <span className="step-bar-label">Steps</span>
        {stepKeys.map((sk) => (
          <button
            key={sk}
            className={`step-tab ${sk === currentStepKey ? 'step-tab--active' : ''}`}
            onClick={() => setActiveStepKey(sk)}
          >
            {parseInt(sk) + 1}
          </button>
        ))}
        <button className="step-tab step-tab--add" onClick={onStepAdd} title="Add step">+</button>
        {stepKeys.length > 1 && (
          <button
            className="step-tab step-tab--remove"
            onClick={() => onStepRemove(currentStepKey)}
            title="Remove current step"
          >−</button>
        )}

        <div className="step-bar-divider" />

        <span className="step-bar-label">Hold</span>
        {!addingHold ? (
          <button
            className="step-tab step-tab--add"
            title="Add hold duration group"
            onClick={() => setAddingHold(true)}
          >+</button>
        ) : (
          <div className="hold-input-group">
            <input
              className="hold-input"
              type="number"
              min={100}
              step={100}
              value={holdInput}
              onChange={e => setHoldInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  const ms = parseInt(holdInput)
                  if (!isNaN(ms) && ms >= 100) {
                    onTriggerAdd(currentStepKey, ms)
                    setAddingHold(false)
                    setHoldInput('2000')
                  }
                } else if (e.key === 'Escape') {
                  setAddingHold(false)
                }
              }}
              autoFocus
            />
            <span className="hold-input-unit">ms</span>
            <button
              className="step-tab step-tab--add"
              onClick={() => {
                const ms = parseInt(holdInput)
                if (!isNaN(ms) && ms >= 100) {
                  onTriggerAdd(currentStepKey, ms)
                  setAddingHold(false)
                  setHoldInput('2000')
                }
              }}
            >✓</button>
            <button
              className="step-tab step-tab--remove"
              onClick={() => setAddingHold(false)}
            >✕</button>
          </div>
        )}
      </div>

      {/* Timeline tracks */}
      <div className="timeline" onWheel={handleWheel} ref={trackAreaRef}>
        {/* Ruler */}
        <div className="timeline-ruler" style={{ height: RULER_HEIGHT }}>
          <div className="ruler-track-label" style={{ width: LABEL_WIDTH }} />
          <div className="ruler-ticks" style={{ position: 'relative', flex: 1 }}>
            {renderRuler()}
          </div>
        </div>

        {tracks.map(({ triggerKey, actions }) => {
          const isHoldTrack = !['down','up','rotate_left','rotate_right'].includes(triggerKey)

          // Infer track execution mode from actions: if any action_group present, note it; otherwise concurrent
          const hasGroups = actions.some(a => a.instance === 'internal' && a.action === 'action_group')

          // Sort by delay to build next-action map
          const sorted = [...actions].sort((a, b) => a.delay - b.delay)
          const nextAction = new Map<string, CompanionAction>()
          for (let i = 0; i < sorted.length - 1; i++) nextAction.set(sorted[i].id, sorted[i + 1])

          // Wait section width — right edge must land exactly on the next action's x position.
          // gap_px = distance between the two delays on screen.
          // The action block already consumes MIN_ACTION_WIDTH, so the wait section width
          // = gap_px - MIN_ACTION_WIDTH so the whole clip ends at x_next.
          const ppm = pxPerMs(containerWidth)
          const waitPx = (action: CompanionAction) => {
            const next = nextAction.get(action.id)
            if (!next || next.delay <= action.delay) return 0
            const gap = (next.delay - action.delay) * ppm
            // Subtract the action block width so the wait ends at x_next
            const waitWidth = gap - MIN_ACTION_WIDTH
            // Only show a wait section if there's enough room for the label
            return waitWidth >= MIN_WAIT_PX ? waitWidth : 0
          }
          // Total clip width = action section + wait section
          const totalWidth = (action: CompanionAction) => MIN_ACTION_WIDTH + waitPx(action)

          // Lane assignment uses absolute pixel positions (no scroll offset) so lanes
          // stay stable as the user pans — only zoom changes overlap.
          // Use only the action block width (not wait section) for overlap detection.
          // The wait section ends exactly where the next action starts, so it can never
          // actually collide — only action blocks that visually stack need separate lanes.
          const laneAssignments = assignLanes(
            actions,
            ms => ms * ppm,
            () => MIN_ACTION_WIDTH
          )
          const laneMap = new Map(laneAssignments.map(({ id, lane }) => [id, lane]))
          const laneCount = Math.max(1, ...laneAssignments.map(l => l.lane + 1))
          const trackHeight = laneCount * LANE_HEIGHT

          return (
            <div key={triggerKey} className="track-row" style={{ height: trackHeight }}>
              <div className="track-label" style={{ width: LABEL_WIDTH }}>
                <span className="track-label-text">{triggerLabel(triggerKey)}</span>
                <div className="track-label-meta">
                  {hasGroups && <span className="track-mode-badge" title="Track contains Action Groups">GRP</span>}
                  {isHoldTrack && (
                    <button
                      className="track-remove-btn"
                      title="Remove hold group"
                      onClick={() => onTriggerRemove(currentStepKey, triggerKey)}
                    >×</button>
                  )}
                </div>
              </div>
              <div
                className="track-body"
                style={{ position: 'relative', flex: 1, height: '100%' }}
                onDoubleClick={e => handleTrackDoubleClick(e, triggerKey)}
              >
                {/* Grid lines */}
                {Array.from({ length: Math.ceil(visibleMs / snapMs) + 1 }, (_, i) => {
                  const t = Math.floor(scrollMs / snapMs) * snapMs + i * snapMs
                  const x = msToPx(t, containerWidth)
                  return x >= 0 && x <= containerWidth
                    ? <div key={t} className="grid-line" style={{ left: x }} />
                    : null
                })}

                {/* Lane dividers when stacking */}
                {laneCount > 1 && Array.from({ length: laneCount - 1 }, (_, i) => (
                  <div key={`ld-${i}`} className="lane-divider" style={{ top: (i + 1) * LANE_HEIGHT }} />
                ))}

                {/* Action clips — each is [action section][wait section] */}
                {actions.map(action => {
                  const x = msToPx(action.delay, containerWidth)
                  const lane = laneMap.get(action.id) ?? 0
                  const top = lane * LANE_HEIGHT + LANE_PAD
                  const bottom = (laneCount - lane - 1) * LANE_HEIGHT + LANE_PAD
                  const next = nextAction.get(action.id)
                  const wp = waitPx(action)
                  const hasWait = wp > 0
                  const waitMs = next ? next.delay - action.delay : 0
                  const instLabel = instances[action.instance]?.label ?? action.instance?.slice(0, 6) ?? '?'
                  const isSelected = selectedActionId === action.id
                  const isEditingWait = editingWaitId === action.id
                  const isGroup = action.instance === 'internal' && action.action === 'action_group'
                  const execMode = isGroup ? (String(action.options?.execution_mode ?? 'concurrent')) : null
                  const childCount = isGroup
                    ? (action.children?.default?.length ?? 0)
                    : 0

                  return (
                    <div
                      key={action.id}
                      className={`clip-block ${isSelected ? 'clip-block--selected' : ''} ${isGroup ? 'clip-block--group' : ''}`}
                      style={{ left: x, top, bottom, width: MIN_ACTION_WIDTH + wp }}
                    >
                      {/* ── Action section ── */}
                      <div
                        className={`clip-action ${isGroup ? 'clip-action--group' : ''}`}
                        style={{ width: MIN_ACTION_WIDTH }}
                        onMouseDown={e => handleActionMouseDown(e, action, triggerKey)}
                        onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, stepKey: currentStepKey, triggerKey, actionId: action.id }) }}
                      >
                        {isGroup ? (
                          <>
                            <span className="action-name">Action Group</span>
                            <span className="action-instance">{childCount} action{childCount !== 1 ? 's' : ''}</span>
                            <span className="action-exec-mode">
                              <select
                                className="exec-mode-select"
                                value={execMode ?? 'concurrent'}
                                onMouseDown={e => e.stopPropagation()}
                                onChange={e => {
                                  e.stopPropagation()
                                  onExecutionModeChange(currentStepKey, triggerKey, e.target.value as ExecutionMode)
                                }}
                                title="Execution mode for this group"
                              >
                                <option value="concurrent">Concurrent</option>
                                <option value="sequential">Sequential</option>
                                <option value="inherit">Inherit</option>
                              </select>
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="action-name">{action.action || <em>new</em>}</span>
                            <span className="action-instance">{instLabel}</span>
                            {action.delay > 0 && <span className="action-delay">{msToLabel(action.delay)}</span>}
                          </>
                        )}

                        {/* Add-wait button (shows when no wait yet, on hover) */}
                        {!hasWait && next && (
                          <button
                            className="clip-add-wait"
                            title="Add wait before next action"
                            onMouseDown={e => e.stopPropagation()}
                            onClick={e => {
                              e.stopPropagation()
                              setEditingWaitId(action.id)
                              setWaitInput('500')
                            }}
                          >⏱+</button>
                        )}
                      </div>

                      {/* ── Wait section (shown only when wait > 0) ── */}
                      {hasWait && (
                        <div
                          className="clip-wait"
                          style={{ width: wp }}
                          onMouseDown={e => e.stopPropagation()}
                        >
                          {isEditingWait ? (
                            <div className="clip-wait-editor" onMouseDown={e => e.stopPropagation()}>
                              <input
                                className="wait-input"
                                type="number"
                                min={0}
                                step={50}
                                value={waitInput}
                                autoFocus
                                onChange={e => setWaitInput(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    const ms = parseInt(waitInput)
                                    if (!isNaN(ms) && ms >= 0 && next) {
                                      onActionDelayChange(currentStepKey, triggerKey, next.id, action.delay + ms)
                                    }
                                    setEditingWaitId(null)
                                  }
                                  if (e.key === 'Escape') setEditingWaitId(null)
                                }}
                              />
                              <span className="wait-input-unit">ms</span>
                            </div>
                          ) : (
                            <button
                              className="clip-wait-label"
                              title="Click to edit wait duration"
                              onClick={e => {
                                e.stopPropagation()
                                setEditingWaitId(action.id)
                                setWaitInput(String(waitMs))
                              }}
                            >
                              <span>⏱</span>
                              <span>{msToLabel(waitMs)}</span>
                            </button>
                          )}
                          {/* Resize handle on wait section right edge */}
                          {next && (
                            <div
                              className="clip-resize-handle"
                              onMouseDown={e => handleResizeMouseDown(e, next, action.delay, triggerKey)}
                            />
                          )}
                        </div>
                      )}

                      {/* Inline wait editor when adding a new wait */}
                      {isEditingWait && !hasWait && (
                        <div
                          className="clip-wait clip-wait--new"
                          onMouseDown={e => e.stopPropagation()}
                        >
                          <div className="clip-wait-editor">
                            <input
                              className="wait-input"
                              type="number"
                              min={0}
                              step={50}
                              value={waitInput}
                              autoFocus
                              onChange={e => setWaitInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  const ms = parseInt(waitInput)
                                  if (!isNaN(ms) && ms > 0 && next) {
                                    onActionDelayChange(currentStepKey, triggerKey, next.id, action.delay + ms)
                                  }
                                  setEditingWaitId(null)
                                }
                                if (e.key === 'Escape') setEditingWaitId(null)
                              }}
                            />
                            <span className="wait-input-unit">ms</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {tracks.length === 0 && (
          <div className="timeline-empty">
            <p>No tracks — double-click to add an action</p>
          </div>
        )}

        <div className="timeline-footer">
          <span>⌘ scroll to zoom · scroll to pan · double-click to add · right-click for options · ⌘Z undo</span>
          <span>{msToLabel(scrollMs)} – {msToLabel(scrollMs + visibleMs)}</span>
        </div>
      </div>

      {contextMenu && (
        <div
          className="timeline-context-menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          <button
            className="context-menu-item context-menu-item--danger"
            onClick={() => {
              onActionDelete(contextMenu.stepKey, contextMenu.triggerKey, contextMenu.actionId)
              setContextMenu(null)
            }}
          >Delete action</button>
        </div>
      )}
    </div>
  )
}
