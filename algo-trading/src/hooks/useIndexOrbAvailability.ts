import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useAngelConnection } from '../shared/angel/AngelConnectionProvider'
import { apiGet, isApiScopeCurrent } from '../trading'
export default function useIndexOrbAvailability() {
  const { user } = useAuth()
  const { brokerAccountId } = useAngelConnection()
  const userId = user?._id
  const scope = `${user?._id ?? ''}:${brokerAccountId ?? ''}`
  const [available, setAvailable] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    if (!userId || !brokerAccountId) return
    apiGet<{ data?: { manifests?: { id: string }[] }; manifests?: { id: string }[] }>('/strategies/manifests')
      .then(res => { if (active && isApiScopeCurrent(scope)) setAvailable((res.data?.manifests ?? res.manifests ?? []).some(m => m.id === 'IndexVwapOrb') ? scope : null) })
      .catch(() => { if (active) setAvailable(null) })
    return () => { active = false }
  }, [scope, userId, brokerAccountId])
  return available === scope
}
