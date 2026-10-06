import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'

import { usePageTitle } from '../../hooks/usePageTitle'

export default function StrategyPlaceholderLayout({ title, children }: { title: string; children: ReactNode }) {
  usePageTitle(title)
  const navigate = useNavigate()

  return (
    <div className="space-y-4 select-none">
      <div className="flex items-center justify-between max-md:flex-col max-md:items-stretch max-md:gap-3 bg-white rounded border border-[#E0E3EB] p-4 shadow-sm">
        <div>
          <h2 className="text-xs font-bold text-[#1E222D] uppercase tracking-wider">{title}</h2>
          <p className="mt-0.5 text-[10px] font-semibold text-[#787B86] uppercase">Algorithm Engine Offline</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/strategies/manual-trading')}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#0052FF]/10 text-[#0052FF] hover:bg-[#0052FF]/20 text-xs font-semibold rounded transition-colors"
        >
          Open Manual Terminal
        </button>
      </div>
      <section className="rounded border border-[#E0E3EB] bg-white p-12 max-md:p-5 shadow-sm flex flex-col items-center justify-center text-center min-h-[360px]">
        <div className="w-12 h-12 bg-[#F8F9FA] rounded flex items-center justify-center border border-[#E0E3EB] mb-4">
          <div className="w-2.5 h-2.5 bg-[#0052FF] rounded-full animate-ping" />
        </div>
        <p className="text-[#1E222D] font-bold text-sm mb-1">Strategy Logic Under Optimization</p>
        <p className="text-[#787B86] text-xs max-w-sm font-medium">This strategy model is undergoing backtesting and tuning. Launch the manual terminal for direct option order entry.</p>
        <div className="mt-6 flex max-md:flex-wrap gap-3 text-xs text-[#434651]">
          {children}
        </div>
      </section>
    </div>
  )
}

