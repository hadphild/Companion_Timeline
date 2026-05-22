import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'

export interface ActionTemplate {
  connectionId: string
  definitionId: string
  options: Record<string, unknown>
}

interface ActionEntry {
  connectionId: string
  connectionLabel: string
  moduleId: string
  definitionId: string
  options: Record<string, unknown>
  usedBefore: boolean
}

interface Props {
  onAdd: (template: ActionTemplate) => void
  onClose: () => void
}

export default function AddActionModal({ onAdd, onClose }: Props) {
  const [actions, setActions] = useState<ActionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedConnId, setSelectedConnId] = useState<string>('')
  const [selectedDefId, setSelectedDefId] = useState<string>('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    window.api.getActionLibrary().then((result: any) => {
      if (result?.actions) setActions(result.actions)
      setLoading(false)
      // Auto-select first connection if only one
      if (result?.connections) {
        const ids = Object.keys(result.connections)
        if (ids.length === 1) setSelectedConnId(ids[0])
      }
      setTimeout(() => searchRef.current?.focus(), 50)
    })
  }, [])

  // Unique connections from actions list
  const connections = useMemo(() => {
    const map = new Map<string, { label: string; moduleId: string }>()
    for (const a of actions) {
      if (!map.has(a.connectionId))
        map.set(a.connectionId, { label: a.connectionLabel, moduleId: a.moduleId })
    }
    return map
  }, [actions])

  // Filtered & sorted actions
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return actions
      .filter(a => {
        if (selectedConnId && a.connectionId !== selectedConnId) return false
        if (!q) return true
        return (
          a.definitionId.toLowerCase().includes(q) ||
          a.connectionLabel.toLowerCase().includes(q)
        )
      })
      .sort((a, b) => {
        // Used actions first, then alphabetical
        if (a.usedBefore !== b.usedBefore) return a.usedBefore ? -1 : 1
        return a.definitionId.localeCompare(b.definitionId)
      })
  }, [actions, selectedConnId, search])

  // Group by connection
  const grouped = useMemo(() => {
    const map = new Map<string, ActionEntry[]>()
    for (const a of filtered) {
      if (!map.has(a.connectionId)) map.set(a.connectionId, [])
      map.get(a.connectionId)!.push(a)
    }
    return map
  }, [filtered])

  const selected = useMemo(() =>
    actions.find(a => a.connectionId === selectedConnId && a.definitionId === selectedDefId) ?? null,
    [actions, selectedConnId, selectedDefId]
  )

  const handleAdd = useCallback(() => {
    if (!selectedConnId || !selectedDefId) return
    onAdd(selected ?? { connectionId: selectedConnId, definitionId: selectedDefId, options: {} })
  }, [selectedConnId, selectedDefId, selected, onAdd])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    if (e.key === 'Enter' && selectedConnId && selectedDefId) handleAdd()
  }, [onClose, handleAdd, selectedConnId, selectedDefId])

  const pick = (a: ActionEntry) => {
    setSelectedConnId(a.connectionId)
    setSelectedDefId(a.definitionId)
  }

  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal modal--wide" onKeyDown={handleKeyDown}>
        <div className="modal-header">
          <span className="modal-title">Add Action</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body modal-body--actions">
          {/* Left: connection filter */}
          <div className="action-conn-list">
            <div className="action-conn-header">Connections</div>
            <button
              className={`action-conn-item ${!selectedConnId ? 'action-conn-item--active' : ''}`}
              onClick={() => setSelectedConnId('')}
            >
              All connections
              <span className="action-conn-count">{actions.length}</span>
            </button>
            {[...connections.entries()].map(([id, conn]) => {
              const count = actions.filter(a => a.connectionId === id).length
              return (
                <button
                  key={id}
                  className={`action-conn-item ${selectedConnId === id ? 'action-conn-item--active' : ''}`}
                  onClick={() => setSelectedConnId(id)}
                >
                  <span className="action-conn-label">{conn.label}</span>
                  <span className="action-conn-module">{conn.moduleId.split('-').slice(-1)[0]}</span>
                  <span className="action-conn-count">{count}</span>
                </button>
              )
            })}
          </div>

          {/* Right: search + action list */}
          <div className="action-pick-area">
            <input
              ref={searchRef}
              className="inspector-input action-search"
              placeholder="Search actions…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />

            <div className="action-list action-list--tall">
              {loading && <div className="action-list-empty">Loading…</div>}

              {!loading && filtered.length === 0 && (
                <div className="action-list-empty">No actions found</div>
              )}

              {[...grouped.entries()].map(([connId, connActions]) => {
                const conn = connections.get(connId)
                const showHeader = !selectedConnId || grouped.size > 1
                return (
                  <div key={connId}>
                    {showHeader && (
                      <div className="action-group-header">
                        {conn?.label ?? connId}
                        <span className="action-group-module">{conn?.moduleId}</span>
                      </div>
                    )}
                    {connActions.map(a => {
                      const isSelected = a.connectionId === selectedConnId && a.definitionId === selectedDefId
                      return (
                        <button
                          key={`${a.connectionId}:${a.definitionId}`}
                          className={`action-list-item ${isSelected ? 'action-list-item--selected' : ''}`}
                          onClick={() => pick(a)}
                          onDoubleClick={() => { pick(a); onAdd(a) }}
                        >
                          <span className="action-list-id">
                            {a.definitionId}
                            {a.usedBefore && <span className="action-used-dot" title="Used in this config" />}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <div className="modal-footer-hint">
            {selected
              ? <span className="muted">{selected.connectionLabel} · {selected.definitionId}</span>
              : <span className="muted">Double-click or select + Add</span>
            }
          </div>
          <button className="modal-btn modal-btn--secondary" onClick={onClose}>Cancel</button>
          <button
            className="modal-btn modal-btn--primary"
            disabled={!selectedConnId || !selectedDefId}
            onClick={handleAdd}
          >
            Add Action
          </button>
        </div>
      </div>
    </div>
  )
}
