import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Zap, TrendingUp, BarChart2, Clock, Target, Activity, Cpu } from 'lucide-react'
import { apiGet } from '../../trading'

import StrategiesLayout from './StrategiesLayout'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card'

type StrategyCard = {
  title: string
  description: string
  to: string
  icon: any
}

type PluginManifest = {
  id: string
  name: string
  description: string
}

export default function StrategiesPage() {
  const navigate = useNavigate()
  const [plugins, setPlugins] = useState<PluginManifest[]>([])

  useEffect(() => {
    async function loadPlugins() {
      try {
        const res = await apiGet<{ manifests: PluginManifest[] }>('/strategies/manifests')
        if (res && Array.isArray(res.manifests)) {
          // Filter out existing hardcoded pages to prevent duplicates
          const builtinIds = ['HeikenAshi', 'ModifiedHeikenAshi', '5minBreakout']
          const customPlugins = res.manifests.filter(m => !builtinIds.includes(m.id))
          setPlugins(customPlugins)
        }
      } catch (e) {}
    }
    loadPlugins()
  }, [])

  const cards: StrategyCard[] = [
    {
      title: 'Manual Trading',
      description: 'Place trades manually with live price and margin info.',
      to: '/strategies/manual-trading',
      icon: Activity,
    },
    {
      title: 'Ichimoku strategy',
      description: 'Trend + momentum strategy using Ichimoku Cloud.',
      to: '/strategies/ichimoku',
      icon: BarChart2,
    },
    {
      title: '5 min breakout',
      description: 'Breakout strategy based on 5-minute range.',
      to: '/strategies/5-min-breakout',
      icon: Zap,
    },
    {
      title: 'VWAP + SMMA',
      description: 'Mean reversion / trend confirmation using VWAP + SMMA.',
      to: '/strategies/vwap-smma',
      icon: Clock,
    },
    {
      title: 'Expiry strategy',
      description: 'Expiry day logic and risk controls (placeholder).',
      to: '/strategies/expiry',
      icon: Target,
    },
    {
      title: 'Heikenashi',
      description: 'Trend following strategy using Heiken Ashi candles.',
      to: '/strategies/heikenashi',
      icon: TrendingUp,
    },
    {
      title: 'Modified Heikenashi',
      description: 'Modified Heiken Ashi logic.',
      to: '/strategies/modified-heikenashi',
      icon: TrendingUp,
    },
  ]

  // Append dynamically discovered plugins
  plugins.forEach(p => {
    cards.push({
      title: p.name,
      description: p.description || 'Custom Strategy Plugin',
      to: `/strategies/plugin/${p.id}`,
      icon: Cpu
    })
  })

  return (
    <StrategiesLayout
      title="Select Algorithmic Strategy"
      subtitle="Launch institutional automated trading rules or use manual ticket."
      backTo="/dashboard"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 select-none">
        {cards.map((c) => {
          const IconComp = c.icon
          return (
            <Card
              key={c.title}
              role="button"
              tabIndex={0}
              onClick={() => navigate(c.to)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  navigate(c.to)
                }
              }}
              className="group flex cursor-pointer flex-col justify-between transition-all hover:border-[#0052FF] hover:shadow-md focus-visible:border-[#0052FF] focus-visible:ring-4 focus-visible:ring-[#0052FF]/10"
            >
              <CardHeader className="p-4 pb-2">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 max-md:min-w-0">
                    <div className="w-7 h-7 bg-[#F0F3FA] rounded flex items-center justify-center text-[#0052FF] group-hover:bg-[#0052FF] group-hover:text-white transition-colors">
                      <IconComp className="w-3.5 h-3.5" />
                    </div>
                    <CardTitle>{c.title}</CardTitle>
                  </div>
                  <span className="flex min-h-11 items-center gap-0.5 rounded-lg px-2 text-[10px] font-bold text-[#0052FF] transition-transform group-hover:translate-x-0.5" aria-hidden="true">
                    Launch <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
                <CardDescription>{c.description}</CardDescription>
              </CardHeader>

              <CardContent className="mt-2 flex items-center justify-between max-md:flex-wrap max-md:gap-2 border-t border-[#E0E3EB] pt-3 text-[10px] font-semibold text-[#787B86]">
                <span>Status: Ready</span>
                <span className="text-[#089981] font-bold">Institutional Grade</span>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </StrategiesLayout>
  )
}

