import { useEffect, useRef, useState, useCallback } from 'react'

const COLS_PER_ROW = 8

// Convert bank:PAGE-SLOT key to Satellite LOCATION string (page/row/col, 0-indexed row+col)
export function bankKeyToLocation(key: string): string | null {
  const m = key.match(/^bank:(\d+)-(\d+)$/)
  if (!m) return null
  const page = parseInt(m[1])
  const slot = parseInt(m[2])  // 1-indexed
  const row = Math.floor((slot - 1) / COLS_PER_ROW)
  const col = (slot - 1) % COLS_PER_ROW
  return `${page}/${row}/${col}`
}

// Convert LOCATION back to bank key
export function locationToBankKey(loc: string): string | null {
  const parts = loc.split('/')
  if (parts.length !== 3) return null
  const [page, row, col] = parts.map(Number)
  const slot = row * COLS_PER_ROW + col + 1
  return `bank:${page}-${slot}`
}

export interface SatelliteButtonState {
  bitmap?: string   // base64 PNG (72×72)
  color?: string    // hex e.g. #ff0000
  text?: string     // decoded text label
  pressed: boolean
}

function parseMessage(line: string): { cmd: string; args: Record<string, string> } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const parts = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
  if (parts.length === 0) return null
  const cmd = parts[0] as string
  const args: Record<string, string> = {}
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=')
    if (eq === -1) continue
    const k = parts[i].slice(0, eq)
    let v = parts[i].slice(eq + 1)
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    args[k] = v
  }
  return { cmd, args }
}

function buildMessage(cmd: string, args: Record<string, string | number | boolean>): string {
  const parts = [cmd]
  for (const [k, v] of Object.entries(args)) {
    const s = String(v)
    parts.push(s.includes(' ') ? `${k}="${s}"` : `${k}=${s}`)
  }
  return parts.join(' ') + '\n'
}

export interface SatelliteHandle {
  isConnected: boolean
  subscriptionsEnabled: boolean
  buttonStates: Record<string, SatelliteButtonState>
  subscribeToPage: (bankKeys: string[]) => void
  pressButton: (bankKey: string, pressed: boolean) => void
}

export function useCompanionSatellite(
  onConnect: () => void,
  onDisconnect: () => void,
  host = '127.0.0.1',
  port = 8000
): SatelliteHandle {
  const [isConnected, setIsConnected] = useState(false)
  const [subscriptionsEnabled, setSubscriptionsEnabled] = useState(false)
  const [buttonStates, setButtonStates] = useState<Record<string, SatelliteButtonState>>({})
  const wsRef = useRef<WebSocket | null>(null)
  const subIdsRef = useRef<Map<string, string>>(new Map())  // bankKey → subId
  const onConnectRef = useRef(onConnect)
  const onDisconnectRef = useRef(onDisconnect)
  onConnectRef.current = onConnect
  onDisconnectRef.current = onDisconnect

  const send = useCallback((msg: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(msg)
  }, [])

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let ws: WebSocket

    function connect() {
      ws = new WebSocket(`ws://${host}:16623`)
      wsRef.current = ws
      let buffer = ''

      ws.onopen = () => {
        console.log('[satellite] WebSocket opened')
      }

      ws.onerror = (e) => {
        console.log('[satellite] WebSocket error', (e as any).message ?? e.type)
      }

      ws.onmessage = (evt) => {
        buffer += evt.data
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          console.log('[satellite] rx:', line.slice(0, 120))
          const msg = parseMessage(line)
          if (!msg) continue

          if (msg.cmd === 'BEGIN') {
            console.log('[satellite] connected! version:', msg.args['CompanionVersion'])
            setIsConnected(true)
            onConnectRef.current()
          }

          if (msg.cmd === 'CAPS') {
            const subs = msg.args['SUBSCRIPTIONS'] === '1' || msg.args['SUBSCRIPTIONS'] === 'true'
            console.log('[satellite] CAPS SUBSCRIPTIONS=', msg.args['SUBSCRIPTIONS'], '→ enabled:', subs)
            setSubscriptionsEnabled(subs)
          }

          if (msg.cmd === 'SUB-STATE') {
            const subId = msg.args['SUBID']
            if (!subId) continue
            // Find which bankKey this subId belongs to
            let bankKey: string | null = null
            for (const [k, sid] of subIdsRef.current.entries()) {
              if (sid === subId) { bankKey = k; break }
            }
            if (!bankKey) continue

            // Parse bitmap (base64 PNG), color, text
            const rawText = msg.args['TEXT']
            let decodedText: string | undefined
            if (rawText) {
              try { decodedText = atob(rawText) } catch { decodedText = rawText }
            }

            setButtonStates(prev => ({
              ...prev,
              [bankKey!]: {
                bitmap: msg.args['BITMAP'] || undefined,
                color: msg.args['COLOR'] || undefined,
                text: decodedText,
                pressed: msg.args['PRESSED'] === '1',
              }
            }))
          }
        }
      }

      ws.onclose = (e) => {
        console.log('[satellite] closed, code:', e.code, 'reason:', e.reason)
        wsRef.current = null
        setIsConnected(false)
        setSubscriptionsEnabled(false)
        setButtonStates({})
        subIdsRef.current.clear()
        onDisconnectRef.current()
        // Reconnect after 3 seconds
        reconnectTimer = setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        // onclose fires after onerror — handled there
      }
    }

    connect()

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
      wsRef.current = null
    }
  }, [host, port])

  const subscribeToPage = useCallback((bankKeys: string[]) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    if (!subscriptionsEnabled) {
      console.log('[satellite] subscriptions not enabled — skipping ADD-SUB')
      return
    }

    // Unsubscribe removed keys
    for (const [key, subId] of subIdsRef.current.entries()) {
      if (!bankKeys.includes(key)) {
        send(buildMessage('REMOVE-SUB', { SUBID: subId }))
        subIdsRef.current.delete(key)
        setButtonStates(prev => { const s = { ...prev }; delete s[key]; return s })
      }
    }

    // Subscribe new keys
    for (const key of bankKeys) {
      if (subIdsRef.current.has(key)) continue
      const loc = bankKeyToLocation(key)
      if (!loc) continue
      const subId = `btn_${key.replace(/[^a-z0-9]/gi, '_')}`
      subIdsRef.current.set(key, subId)
      const msg = buildMessage('ADD-SUB', { SUBID: subId, LOCATION: loc, BITMAP: 72, COLORS: 'hex', TEXT: 'true' })
      console.log('[satellite] subscribe:', msg.trim())
      send(msg)
    }
  }, [send, subscriptionsEnabled])

  // Use REST API for button press — works regardless of subscription state
  const pressButton = useCallback((bankKey: string, pressed: boolean) => {
    const loc = bankKeyToLocation(bankKey)
    if (!loc) return
    const [page, row, col] = loc.split('/')
    const endpoint = pressed ? 'down' : 'up'
    fetch(`http://${host}:${port}/api/location/${page}/${row}/${col}/${endpoint}`, { method: 'POST' })
      .then(r => console.log('[satellite] press', endpoint, r.status))
      .catch(e => console.log('[satellite] press error', e.message))
  }, [host])

  return { isConnected, subscriptionsEnabled, buttonStates, subscribeToPage, pressButton }
}
