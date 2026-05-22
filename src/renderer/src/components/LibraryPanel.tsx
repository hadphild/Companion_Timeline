import React, { useState, useEffect, useMemo, useCallback } from 'react'

interface ActionEntry {
  connectionId: string
  connectionLabel: string
  definitionId: string
  options: Record<string, unknown>
  usedBefore: boolean
  noActions?: boolean
}

interface Props {}

export default function LibraryPanel({ }: Props) {
  const [actions, setActions] = useState<ActionEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    window.api.getActionLibrary().then((result: any) => {
      if (result?.error) {
        setError(result.error)
      } else if (Array.isArray(result?.actions)) {
        setActions(result.actions)
      } else {
        setError('Unexpected response')
        console.error('[Library] getActionLibrary response:', result)
      }
      setLoading(false)
    }).catch((e: any) => {
      setError(String(e))
      setLoading(false)
    })
  }, [])

  useEffect(() => { load() }, [load])

  // Reload when Companion's database changes (new connections, module updates, etc.)
  useEffect(() => {
    const unsub = window.api.onCompanionChange(() => load())
    return unsub
  }, [load])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return actions
    return actions.filter(a =>
      a.definitionId.toLowerCase().includes(q) ||
      a.connectionLabel.toLowerCase().includes(q)
    )
  }, [actions, search])

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; actions: ActionEntry[] }>()
    for (const a of filtered) {
      if (!map.has(a.connectionId)) map.set(a.connectionId, { label: a.connectionLabel, actions: [] })
      map.get(a.connectionId)!.actions.push(a)
    }
    return map
  }, [filtered])

  const handleDragStart = useCallback((e: React.DragEvent, action: ActionEntry) => {
    e.dataTransfer.setData('application/companion-action', JSON.stringify({
      connectionId: action.connectionId,
      definitionId: action.definitionId,
      options: action.options ?? {}
    }))
    e.dataTransfer.effectAllowed = 'copy'
  }, [])

  const toggleGroup = useCallback((connId: string) => {
    setCollapsed(c => ({ ...c, [connId]: !c[connId] }))
  }, [])

  return (
    <div className="library-panel">
      <div className="library-header">
        <span className="library-title">Action Library</span>
        <span className="library-hint">drag to timeline</span>
      </div>

      <button className="library-reload-btn" onClick={load} disabled={loading}>
        <span className="library-reload-icon">↺</span>
        {loading ? 'Loading…' : 'Reload Connections'}
      </button>

      <input
        className="inspector-input library-search"
        placeholder="Search actions…"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      <div className="library-list">
        {loading && <div className="library-empty">Loading…</div>}
        {!loading && error && (
          <div className="library-empty library-error" title={error}>
            Could not load actions — is Companion running?
          </div>
        )}
        {!loading && !error && grouped.size === 0 && (
          <div className="library-empty">No actions found</div>
        )}

        {[...grouped.entries()].map(([connId, { label, actions: connActions }]) => (
          <div key={connId} className="library-group">
            <button
              className="library-group-header"
              onClick={() => toggleGroup(connId)}
            >
              <span className="library-group-chevron">{collapsed[connId] ? '▶' : '▼'}</span>
              <span className="library-group-label">{label}</span>
              <span className="library-group-count">{connActions[0]?.noActions ? 0 : connActions.length}</span>
            </button>

            {!collapsed[connId] && (
              <div className="library-group-items">
                {connActions[0]?.noActions
                  ? <div className="library-no-actions">No actions scanned for this module</div>
                  : connActions.map(a => (
                    <div
                      key={`${a.connectionId}:${a.definitionId}`}
                      className={`library-item ${a.usedBefore ? 'library-item--used' : ''}`}
                      draggable
                      onDragStart={e => handleDragStart(e, a)}
                      title={`${a.connectionLabel} · ${a.definitionId}`}
                    >
                      <span className="library-item-icon">⠿</span>
                      <span className="library-item-name">{a.definitionId}</span>
                      {a.usedBefore && <span className="library-item-dot" title="Used in this config" />}
                    </div>
                  ))
                }
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
