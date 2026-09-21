import { createContext, useCallback, useContext, useMemo, useState, useEffect } from 'react'
import type { ReactNode } from 'react'

import MpinModal from './MpinModal'
import { apiGet, apiPost } from '../../trading'
import { useAuth } from '../../context/AuthContext'

export type AngelCredentials = {
  apiKey: string
  clientCode: string
  mpin: string
  totpSecret: string
}

type AngelLoginResponse = {
  status: boolean
  connected?: boolean
  clientCode?: string | null
  message?: string
}

type SystemHealthResponse = {
  ready: boolean
}

type ConnectStatus = 'idle' | 'connecting' | 'connected' | 'error'

type AngelConnectionContextValue = {
  connectStatus: ConnectStatus
  connectMessage: string
  backendReady: boolean
  openConnect: () => void
  disconnect: () => Promise<void>
}

const AngelConnectionContext = createContext<AngelConnectionContextValue | null>(null)

export function AngelConnectionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>('idle')
  const [connectMessage, setConnectMessage] = useState('')
  const [backendReady, setBackendReady] = useState(false)
  const [mpinOpen, setMpinOpen] = useState(false)

  const openConnect = useCallback(() => {
    if (!backendReady) {
      setConnectMessage('Server is starting up, please wait a moment.')
      return
    }
    setMpinOpen(true)
  }, [backendReady])

  const disconnect = useCallback(async () => {
    try {
      await apiPost<Record<string, unknown>>('/angel/logout')
    } catch {
      // ignore
    }
    setConnectStatus('idle')
    setConnectMessage('Disconnected')
  }, [])

  const submitCredentials = useCallback(async (credentials: AngelCredentials) => {
    setConnectStatus('connecting')
    setConnectMessage('')
    try {
      const login = await apiPost<AngelLoginResponse>('/angel/login', credentials)
      setConnectStatus('connected')
      setConnectMessage(login.message ?? 'Connected')
      setMpinOpen(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connect failed'
      setConnectStatus('error')
      setConnectMessage('')
      throw new Error(msg)
    }
  }, [])

  // Restore the broker connection indicator after an application refresh.
  useEffect(() => {
    if (!user) return
    apiGet<{ connected: boolean; message?: string }>('/angel/status')
      .then((status) => {
        setConnectStatus(status.connected ? 'connected' : 'idle')
        if (status.message) setConnectMessage(status.message)
      })
      .catch(() => {
        setConnectStatus('idle')
      })
  }, [user])

  useEffect(() => {
    if (!user) {
      setBackendReady(false)
      return
    }

    let active = true
    const checkHealth = async () => {
      try {
        const health = await apiGet<SystemHealthResponse>('/system/health')
        if (!active) return
        setBackendReady(health.ready)
        setConnectMessage((current) => health.ready && current === 'Server is starting up, please wait a moment.' ? '' : current)
      } catch {
        if (!active) return
        setBackendReady(false)
        setConnectMessage((current) => current || 'Server is starting up, please wait a moment.')
      }
    }

    void checkHealth()
    const interval = window.setInterval(() => void checkHealth(), 3_000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [user])

  const value = useMemo<AngelConnectionContextValue>(
    () => ({
      connectStatus,
      connectMessage,
      backendReady,
      openConnect,
      disconnect,
    }),
    [backendReady, connectMessage, connectStatus, disconnect, openConnect],
  )

  return (
    <AngelConnectionContext.Provider value={value}>
      {children}
      <MpinModal
        open={mpinOpen}
        onCancel={() => setMpinOpen(false)}
        onSubmit={async (credentials) => {
          await submitCredentials(credentials)
        }}
      />
    </AngelConnectionContext.Provider>
  )
}

export function useAngelConnection(): AngelConnectionContextValue {
  const ctx = useContext(AngelConnectionContext)
  if (!ctx) throw new Error('useAngelConnection must be used within AngelConnectionProvider')
  return ctx
}
