import React, { useMemo } from 'react'
import {
  CompanionConfig,
  ButtonControl,
  parseBankKey,
  intToColor
} from '../types'
import type { SatelliteButtonState } from '../hooks/useCompanionSatellite'

interface Props {
  config: CompanionConfig
  selectedKey: string | null
  buttonStates?: Record<string, SatelliteButtonState>
  onSelect: (key: string) => void
}

export default function ButtonGrid({ config, selectedKey, buttonStates, onSelect }: Props) {
  const gridCols = config.gridSize?.columns ?? 8
  const gridRows = config.gridSize?.rows ?? 4
  const totalSlots = gridCols * gridRows

  const pages = useMemo(() => {
    const map: Record<number, Record<number, { key: string; ctrl: ButtonControl } | null>> = {}
    for (const [key, ctrl] of Object.entries(config.controls)) {
      if (ctrl.type !== 'button') continue
      const ref = parseBankKey(key)
      if (!ref) continue
      if (!map[ref.page]) map[ref.page] = {}
      map[ref.page][ref.slot] = { key, ctrl: ctrl as ButtonControl }
    }
    return map
  }, [config])

  const pageNums = Object.keys(pages).map(Number).sort((a, b) => a - b)

  if (pageNums.length === 0) {
    return <div className="sidebar-empty"><p>No buttons found</p></div>
  }

  return (
    <div className="sidebar">
      {pageNums.map((page) => {
        const slots = pages[page] ?? {}

        return (
          <div key={page} className="page-section">
            <div className="page-label">
              {config.page?.[page]?.name || `Page ${page}`}
            </div>
            <div
              className="button-grid"
              style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
            >
              {Array.from({ length: totalSlots }, (_, i) => {
                const slot = i + 1
                const entry = slots[slot]

                if (!entry) {
                  // Empty slot — still selectable so user can add actions to it
                  const key = `bank:${page}-${slot}`
                  return (
                    <button
                      key={slot}
                      className={`btn-cell btn-cell--empty ${selectedKey === key ? 'btn-cell--selected' : ''}`}
                      onClick={() => onSelect(key)}
                      title={`Slot ${slot}`}
                    />
                  )
                }

                const { key, ctrl } = entry
                const live = buttonStates?.[key]
                const bg = intToColor(ctrl.style.bgcolor ?? 0)
                const fg = intToColor(ctrl.style.color ?? 0xffffff)
                const hasActions = Object.values(ctrl.steps).some((step) =>
                  Object.values(step.action_sets).some((acts) => acts && acts.length > 0)
                )

                const bitmapSrc = live?.bitmap
                  ? `data:image/png;base64,${live.bitmap}`
                  : ctrl.style.image ?? null

                return (
                  <button
                    key={slot}
                    className={`btn-cell ${selectedKey === key ? 'btn-cell--selected' : ''} ${hasActions ? 'btn-cell--has-actions' : ''} ${live?.pressed ? 'btn-cell--pressed' : ''}`}
                    style={{ backgroundColor: bg }}
                    onClick={() => onSelect(key)}
                    title={ctrl.style.text || `Slot ${slot}`}
                  >
                    {bitmapSrc ? (
                      <div className="btn-image-wrap">
                        <img
                          className="btn-bitmap"
                          src={bitmapSrc}
                          alt={ctrl.style.text || ''}
                          draggable={false}
                        />
                        {ctrl.style.text && (
                          <span className="btn-text btn-text--overlay" style={{ color: fg }}>
                            {ctrl.style.text}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="btn-text" style={{ color: fg }}>{ctrl.style.text || ''}</span>
                    )}
                    {hasActions && <span className="btn-dot" />}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
