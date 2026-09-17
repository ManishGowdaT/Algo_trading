import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Play, Square, XCircle } from 'lucide-react'
import { apiGet, apiPost } from '../../trading'
import { startResilientPolling } from '../../utils/resilientPolling'
import { usePageTitle } from '../../hooks/usePageTitle'
import StrategiesLayout from './StrategiesLayout'

type ParameterSchema = {
  type: string
  default: any
  label: string
  min?: number
  max?: number
}

type StrategyManifest = {
  id: string
  name: string
  version: string
  engineVersion: string
  description: string
  requires: {
    timeframe: string
    lookbackCandles: number
    dataStreams: string[]
  }
  parameters: Record<string, ParameterSchema>
}

export default function DynamicStrategyPage() {
  const { strategyId } = useParams<{ strategyId: string }>()
  const [manifest, setManifest] = useState<StrategyManifest | null>(null)
  const [config, setConfig] = useState<Record<string, any>>({})
  const [status, setStatus] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  usePageTitle(manifest ? manifest.name : 'Strategy Execution')

  useEffect(() => {
    async function loadManifest() {
      try {
        const res = await apiGet<{ manifests: StrategyManifest[] }>('/strategies/manifests')
        const found = res?.manifests?.find((m: StrategyManifest) => m.id === strategyId)
        if (found) {
          setManifest(found)
          const initialConfig: Record<string, any> = { underlying: 'SENSEX', quantity: 20 }
          Object.entries(found.parameters || {}).forEach(([key, param]) => {
            initialConfig[key] = param.default
          })
          setConfig(initialConfig)
        }
      } catch (err) {
        console.error('Failed to load strategy manifest:', err)
      } finally {
        setLoading(false)
      }
    }
    loadManifest()
  }, [strategyId])

  useEffect(() => {
    if (!strategyId) return
    const fetchStatus = async () => {
      try {
        const res = await apiGet<any>(`/strategies/${strategyId}/status`)
        setStatus(res)
        return true
      } catch { return false }
    }
    const stopPolling = startResilientPolling(fetchStatus, { intervalMs: 2000 })
    return () => stopPolling()
  }, [strategyId])

  const handleStart = async () => {
    if (!strategyId) return
    try {
      const res = await apiPost<any>(`/strategies/${strategyId}/start`, config)
      setStatus(res)
    } catch (e: any) {
      alert(`Start failed: ${e.message}`)
    }
  }

  const handleStop = async () => {
    if (!strategyId) return
    try {
      const res = await apiPost<any>(`/strategies/${strategyId}/stop`)
      setStatus(res)
    } catch (e: any) {
      alert(`Stop failed: ${e.message}`)
    }
  }

  const handleExit = async () => {
    if (!strategyId) return
    try {
      const res = await apiPost<any>(`/strategies/${strategyId}/exit`)
      setStatus(res)
    } catch (e: any) {
      alert(`Exit failed: ${e.message}`)
    }
  }

  if (loading) {
    return (
      <StrategiesLayout title="Loading Strategy..." backTo="/strategies">
        <div className="p-8 text-center text-sm font-semibold text-[#787B86]">Loading strategy schema...</div>
      </StrategiesLayout>
    )
  }

  if (!manifest) {
    return (
      <StrategiesLayout title="Strategy Not Found" backTo="/strategies">
        <div className="p-8 text-center text-sm font-semibold text-red-500">
          Strategy plugin "{strategyId}" is not registered or supported by the current engine.
        </div>
      </StrategiesLayout>
    )
  }

  return (
    <StrategiesLayout title={manifest.name} subtitle={manifest.description} backTo="/strategies">
      <div className="space-y-6">
        {/* Controls Header */}
        <div className="flex items-center justify-between bg-white rounded border border-[#E0E3EB] p-4 shadow-sm">
          <div>
            <span className="text-xs font-bold text-[#787B86] uppercase tracking-wider">Engine v{manifest.engineVersion}</span>
            <h2 className="text-sm font-bold text-[#1E222D]">{manifest.name}</h2>
          </div>
          <div className="flex items-center gap-2">
            {!status?.isRunning ? (
              <button
                type="button"
                onClick={handleStart}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#0052FF] text-white hover:bg-[#0052FF]/90 text-xs font-bold rounded transition-colors"
              >
                <Play className="w-3.5 h-3.5" /> Start Engine
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleStop}
                  className="flex items-center gap-1.5 px-4 py-2 bg-[#F23645] text-white hover:bg-[#F23645]/90 text-xs font-bold rounded transition-colors"
                >
                  <Square className="w-3.5 h-3.5" /> Stop Engine
                </button>
                <button
                  type="button"
                  onClick={handleExit}
                  className="flex items-center gap-1.5 px-4 py-2 bg-[#F0F3FA] text-[#1E222D] hover:bg-[#E0E3EB] text-xs font-bold rounded transition-colors"
                >
                  <XCircle className="w-3.5 h-3.5" /> Force Exit
                </button>
              </>
            )}
          </div>
        </div>

        {/* Dynamic Parameter Settings */}
        <div className="bg-white rounded border border-[#E0E3EB] p-5 shadow-sm space-y-4">
          <h3 className="text-xs font-bold text-[#1E222D] uppercase tracking-wider">Configurable Parameters</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(manifest.parameters || {}).map(([key, param]) => (
              <div key={key} className="space-y-1">
                <label className="text-xs font-semibold text-[#434651]">{param.label || key}</label>
                <input
                  type={param.type === 'number' ? 'number' : 'text'}
                  value={config[key] ?? param.default}
                  onChange={(e) => setConfig({ ...config, [key]: param.type === 'number' ? Number(e.target.value) : e.target.value })}
                  className="w-full px-3 py-1.5 text-xs font-medium border border-[#E0E3EB] rounded focus:outline-none focus:border-[#0052FF]"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Monitor & Logs Section */}
        {status && (
          <div className="bg-white rounded border border-[#E0E3EB] p-5 shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-[#1E222D] uppercase tracking-wider">Live Monitor Status</h3>
            <div className="p-3 bg-[#F8F9FA] rounded border border-[#E0E3EB] text-xs font-mono">
              Status: <span className="font-bold text-[#0052FF]">{status.state}</span> | Trend: <span className="font-bold">{status.trend}</span>
              {status.message && <div className="mt-1 text-[#434651]">{status.message}</div>}
            </div>

            {status.logs && status.logs.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-[#787B86]">Execution Logs</h4>
                <div className="p-3 bg-[#1E222D] text-white rounded text-[11px] font-mono max-h-48 overflow-y-auto space-y-1">
                  {status.logs.map((log: string, idx: number) => (
                    <div key={idx}>{log}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </StrategiesLayout>
  )
}
