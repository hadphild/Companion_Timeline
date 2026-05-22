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

const SLOTS_PER_ROW = 8

export default function ButtonGrid({ config, selectedKey, buttonStates, onSelect }: Props) {
  const pages = useMemo(() => {
    const map: Record<number, Record<number, { key: string; ctrl: ButtonControl }>> = {}
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
        const slots = pages[page]
        const slotNums = Object.keys(slots).map(Number).sort((a, b) => a - b)
        const maxSlot = Math.max(...slotNums, SLOTS_PER_ROW)
        const rows = Math.ceil(maxSlot / SLOTS_PER_ROW)

        return (
          <div key={page} className="page-section">
            <div className="page-label">
              {config.page?.[page]?.name || `Page ${page}`}
            </div>
            <div
              className="button-grid"
              style={{ gridTemplateColumns: `repeat(${SLOTS_PER_ROW}, 1fr)` }}
            >
              {Array.from({ length: rows * SLOTS_PER_ROW }, (_, i) => {
                const slot = i + 1
                const entry = slots[slot]
                if (!entry) {
                  return <div key={slot} className="btn-cell btn-cell--empty" />
                }
                const { key, ctrl } = entry
                const live = buttonStates?.[key]
                const bg = intToColor(ctrl.style.bgcolor ?? 0)
                const fg = intToColor(ctrl.style.color ?? 0xffffff)
                const hasActions = Object.values(ctrl.steps).some((step) =>
                  Object.values(step.action_sets).some((acts) => acts && acts.length > 0)
                )

                return (
                  <button
                    key={slot}
                    className={`btn-cell ${selectedKey === key ? 'btn-cell--selected' : ''} ${hasActions ? 'btn-cell--has-actions' : ''} ${live?.pressed ? 'btn-cell--pressed' : ''}`}
                    style={live?.bitmap ? {} : { backgroundColor: bg, color: fg }}
                    onClick={() => onSelect(key)}
                    title={ctrl.style.text || `Slot ${slot}`}
                  >
                    {live?.bitmap ? (
                      // Live rendered bitmap from Companion
                      <img
                        className="btn-bitmap"
                        src={`data:image/png;base64,${live.bitmap}`}
                        alt={ctrl.style.text || ''}
                        draggable={false}
                      />
                    ) : (
                      <span className="btn-text">{ctrl.style.text || ''}</span>
                    )}
                    {hasActions && !live?.bitmap && <span className="btn-dot" />}
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
