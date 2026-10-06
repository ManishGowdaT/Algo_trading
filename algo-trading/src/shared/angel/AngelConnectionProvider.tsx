import { createContext, useCallback, useContext, useMemo, useState, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

import MpinModal from './MpinModal'
import { apiGet, apiPost } from '../../trading'
import { setApiAccountScope } from '../../trading/api'
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
  brokerAccountId?: string | null
  message?: string
}

type SystemHealthResponse = {
  ready: boolean
  pythonStatus?: 'starting' | 'ready' | 'authentication_misconfigured' | 'edge_rate_limited' | 'timeout' | 'unavailable'
}

const DEFAULT_BACKEND_MESSAGE = 'Server is starting up, please wait a moment.'
const BACKEND_MESSAGES = new Set([
  DEFAULT_BACKEND_MESSAGE,
  'Server configuration is incomplete. Please contact support.',
  'The hosting platform is limiting server wake-up requests. Please try again shortly.',
  'The server did not respond in time. Please try again shortly.',
  'The Python service is unavailable. Please try again shortly.',
])

function messageForPythonStatus(status?: SystemHealthResponse['pythonStatus']): string {
  switch (status) {
    case 'authentication_misconfigured':
      return 'Server configuration is incomplete. Please contact support.'
    case 'edge_rate_limited':
      return 'The hosting platform is limiting server wake-up requests. Please try again shortly.'
    case 'timeout':
      return 'The server did not respond in time. Please try again shortly.'
    case 'unavailable':
      return 'The Python service is unavailable. Please try again shortly.'
    default:
      return DEFAULT_BACKEND_MESSAGE
  }
}

type ConnectStatus = 'idle' | 'connecting' | 'connected' | 'error'

type AngelConnectionContextValue = {
  connectStatus: ConnectStatus
  connectMessage: string
  backendReady: boolean
  backendMessage: string
  brokerAccountId: string | null
  openConnect: () => void
  disconnect: () => Promise<void>
}

const AngelConnectionContext = createContext<AngelConnectionContextValue | null>(null)

export function AngelConnectionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const userIdRef = useRef(user?._id ?? null)
  userIdRef.current = user?._id ?? null
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>('idle')
  const [connectMessage, setConnectMessage] = useState('')
  const [brokerAccountId, setBrokerAccountId] = useState<string | null>(null)
  const [backendReady, setBackendReady] = useState(false)
  const [backendMessage, setBackendMessage] = useState(DEFAULT_BACKEND_MESSAGE)
  const [mpinOpen, setMpinOpen] = useState(false)

  const openConnect = useCallback(() => {
    if (!backendReady) {
      setConnectMessage(backendMessage)
      return
    }
    setMpinOpen(true)
  }, [backendMessage, backendReady])

  const disconnect = useCallback(async () => {
    await apiPost<Record<string, unknown>>('/angel/logout')
    setApiAccountScope(null)
    setBrokerAccountId(null)
    setConnectStatus('idle')
    setConnectMessage('Disconnected')
  }, [])

  const submitCredentials = useCallback(async (credentials: AngelCredentials) => {
    const ownerId = user?._id
    if (!ownerId) throw new Error('Sign in before connecting a broker account.')
    setConnectStatus('connecting')
    setConnectMessage('')
    try {
      const login = await apiPost<AngelLoginResponse>('/angel/login', credentials)
      if (ownerId !== userIdRef.current) return
      if (!login.brokerAccountId) throw new Error('Broker connection did not return a verified account.')
      setBrokerAccountId(login.brokerAccountId)
      setApiAccountScope(login.brokerAccountId)
      setConnectStatus('connected')
      setConnectMessage(login.message ?? 'Connected')
      setMpinOpen(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connect failed'
      if (ownerId !== userIdRef.current) return
      setConnectStatus('error')
      setConnectMessage('')
      throw new Error(msg)
    }
  }, [user?._id])

  // Restore the broker connection indicator after an application refresh.
  useEffect(() => {
    let active = true
    setApiAccountScope(null)
    setBrokerAccountId(null)
    setConnectStatus('idle')
    setConnectMessage('')
    if (!user) return () => { active = false }
    apiGet<{ connected: boolean; message?: string; brokerAccountId?: string | null }>('/angel/status')
      .then((status) => {
        if (!active) return
        const accountId = status.brokerAccountId || null
        setBrokerAccountId(accountId)
        setApiAccountScope(accountId)
        setConnectStatus(status.connected ? 'connected' : 'idle')
        if (status.message) setConnectMessage(status.message)
      })
      .catch(() => {
        if (active) setConnectStatus('idle')
      })
    return () => { active = false }
  }, [user])

  useEffect(() => {
    if (!user) {
      setBackendReady(false)
      setBackendMessage(DEFAULT_BACKEND_MESSAGE)
      return
    }

    let active = true
    const checkHealth = async () => {
      try {
        const health = await apiGet<SystemHealthResponse>('/system/health')
        if (!active) return
        const message = messageForPythonStatus(health.pythonStatus)
        setBackendReady(health.ready)
        setBackendMessage(message)
        setConnectMessage((current) => {
          if (health.ready) return BACKEND_MESSAGES.has(current) ? '' : current
          return !current || BACKEND_MESSAGES.has(current) ? message : current
        })
      } catch {
        if (!active) return
        setBackendReady(false)
        setBackendMessage(DEFAULT_BACKEND_MESSAGE)
        setConnectMessage((current) => current || DEFAULT_BACKEND_MESSAGE)
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
      backendMessage,
      brokerAccountId,
      openConnect,
      disconnect,
    }),
    [backendMessage, backendReady, brokerAccountId, connectMessage, connectStatus, disconnect, openConnect],
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
