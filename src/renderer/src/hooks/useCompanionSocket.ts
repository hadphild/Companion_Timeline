import { useEffect, useRef, useState, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'

const COMPANION_URL = 'http://127.0.0.1:8000'

function emitPromise<T = unknown>(socket: Socket, event: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), 5000)
    socket.emit(event, ...args, (res: T) => {
      clearTimeout(timer)
      resolve(res)
    })
  })
}

export interface CompanionSocketHandle {
  isConnected: boolean
  setDelay: (v5id: string, stepKey: string, triggerKey: string, actionId: string, delay: number) => void
  addAction: (v5id: string, stepKey: string, triggerKey: string, connectionId: string, actionId: string) => void
  removeAction: (v5id: string, stepKey: string, triggerKey: string, actionId: string) => void
  setOption: (v5id: string, stepKey: string, triggerKey: string, actionId: string, key: string, value: unknown) => void
}

export function useCompanionSocket(
  onConnect: () => void,
  onDisconnect: () => void
): CompanionSocketHandle {
  const [isConnected, setIsConnected] = useState(false)
  const socketRef = useRef<Socket | null>(null)
  const onConnectRef = useRef(onConnect)
  const onDisconnectRef = useRef(onDisconnect)
  onConnectRef.current = onConnect
  onDisconnectRef.current = onDisconnect

  // Debounce ref for drag-based delay changes
  const delayDebounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const socket = io(COMPANION_URL, {
      transports: ['websocket'],  // skip HTTP polling — Companion's Express catch-all blocks it
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
      timeout: 8000,
    })
    socketRef.current = socket

    socket.on('connect', () => {
      console.log('[socket] connected to Companion', socket.id)
      setIsConnected(true)
      onConnectRef.current()
    })

    socket.on('connect_error', (e: any) => {
      console.log('[socket] connect_error:', e.message, e.type, e.description?.message ?? e.description)
    })

    socket.on('disconnect', (reason) => {
      console.log('[socket] disconnected:', reason)
      setIsConnected(false)
      onDisconnectRef.current()
    })

    return () => {
      delayDebounceRef.current.forEach(t => clearTimeout(t))
      socket.disconnect()
      socketRef.current = null
    }
  }, [])

  const setDelay = useCallback((v5id: string, stepKey: string, triggerKey: string, actionId: string, delay: number) => {
    const socket = socketRef.current
    if (!socket?.connected) return
    // Debounce per-action to avoid flooding during drag
    const key = `${v5id}:${stepKey}:${triggerKey}:${actionId}`
    const existing = delayDebounceRef.current.get(key)
    if (existing) clearTimeout(existing)
    delayDebounceRef.current.set(key, setTimeout(() => {
      delayDebounceRef.current.delete(key)
      emitPromise(socket, 'controls:action:set-delay', v5id, stepKey, triggerKey, actionId, delay)
        .catch(() => {})
    }, 150))
  }, [])

  const addAction = useCallback((v5id: string, stepKey: string, triggerKey: string, connectionId: string, actionId: string) => {
    const socket = socketRef.current
    if (!socket?.connected) return
    emitPromise(socket, 'controls:action:add', v5id, stepKey, triggerKey, connectionId, actionId)
      .catch(() => {})
  }, [])

  const removeAction = useCallback((v5id: string, stepKey: string, triggerKey: string, actionId: string) => {
    const socket = socketRef.current
    if (!socket?.connected) return
    emitPromise(socket, 'controls:action:remove', v5id, stepKey, triggerKey, actionId)
      .catch(() => {})
  }, [])

  const setOption = useCallback((v5id: string, stepKey: string, triggerKey: string, actionId: string, key: string, value: unknown) => {
    const socket = socketRef.current
    if (!socket?.connected) return
    emitPromise(socket, 'controls:action:set-option', v5id, stepKey, triggerKey, actionId, key, value)
      .catch(() => {})
  }, [])

  return { isConnected, setDelay, addAction, removeAction, setOption }
}
