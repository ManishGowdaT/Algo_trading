import { useState, useEffect, useCallback, useRef } from 'react'
import {
    Search,
    Filter,
    ChevronLeft,
    ChevronRight,
    TrendingUp,
    TrendingDown,
    Calendar,
    Clock,
    RefreshCw,
    ChevronDown,
    Check,
    Download,
    Trash2
} from 'lucide-react'
import DatePicker from 'react-datepicker'
import 'react-datepicker/dist/react-datepicker.css'
import { apiDelete, apiGet } from '../../trading'
import { buildTradesUrl, validateTradesTimeRange } from './tradesQuery'
import { usePageTitle } from '../../hooks/usePageTitle'
import { generateTradesPdf } from './generateTradesPdf'

type Trade = {
    _id: string
    strategyId: {
        _id: string
        name: string
    }
    index: string
    premium: number
    qty: number
    buyPrice: number
    exitPrice?: number
    pnl?: number
    exitReason?: string
    positionState?: string
    createdAt: string
}

type TradesResponse = {
    status: string
    results: number
    total: number
    pages: number
    analytics?: {
        totalPnl: number
        totalTrades: number
        taxes: number
        netPnl: number
    }
    data: {
        trades: Trade[]
    }
}

export default function TradesPage() {
    usePageTitle('Trades');
    const deleteDialogRef = useRef<HTMLDialogElement>(null)
    const [trades, setTrades] = useState<Trade[]>([])
    const [strategies, setStrategies] = useState<{ _id: string, name: string }[]>([])
    const [loading, setLoading] = useState(true)
    const [page, setPage] = useState(1)
    const [totalPages, setTotalPages] = useState(1)
    const [totalResults, setTotalResults] = useState(0)

    // Filters inputs
    const [searchQuery, setSearchQuery] = useState('')
    const [exitReasonFilter, setExitReasonFilter] = useState('')
    const [strategyIdFilter, setStrategyIdFilter] = useState('')
    const [startDate, setStartDate] = useState('')
    const [endDate, setEndDate] = useState('')
    const [timeFrom, setTimeFrom] = useState('')
    const [timeTo, setTimeTo] = useState('')

    // Applied Filters (used for fetching)
    const [appliedFilters, setAppliedFilters] = useState({
        searchQuery: '',
        exitReasonFilter: '',
        strategyIdFilter: '',
        startDate: '',
        endDate: '',
        timeFrom: '',
        timeTo: ''
    })

    // Custom Select Dropdown states
    const [isStrategyDropdownOpen, setIsStrategyDropdownOpen] = useState(false)
    const [isExitReasonDropdownOpen, setIsExitReasonDropdownOpen] = useState(false)

    // Export PDF state
    const [isExporting, setIsExporting] = useState(false)
    const [pdfMessage, setPdfMessage] = useState<string | null>(null)
    const [filterMessage, setFilterMessage] = useState<string | null>(null)
    const [deleteMessage, setDeleteMessage] = useState<string | null>(null)
    const [tradeToDelete, setTradeToDelete] = useState<Trade | null>(null)
    const [deletingTradeId, setDeletingTradeId] = useState<string | null>(null)

    const [analytics, setAnalytics] = useState({
        totalPnl: 0,
        totalTrades: 0,
        taxes: 0,
        netPnl: 0
    })

    useEffect(() => {
        const dialog = deleteDialogRef.current
        if (!dialog) return
        if (tradeToDelete && !dialog.open) dialog.showModal()
        else if (!tradeToDelete && dialog.open) dialog.close()
    }, [tradeToDelete])

    const handleDownloadPdf = async () => {
        setPdfMessage(null)

        if (totalResults === 0 || (trades.length === 0 && !loading)) {
            setPdfMessage('No trades found for the selected filters.')
            return
        }

        setIsExporting(true)
        try {
            let tradesToExport: Trade[] = trades

            // Re-use already loaded data if all results are present, otherwise fetch full filtered dataset
            if (totalResults > trades.length) {
                const url = buildTradesUrl({ page: 1, limit: totalResults, filters: appliedFilters })
                const response = await apiGet<TradesResponse>(url)
                if (response.status === 'success') {
                    tradesToExport = response.data.trades
                }
            }

            if (!tradesToExport || tradesToExport.length === 0) {
                setPdfMessage('No trades found for the selected filters.')
                return
            }

            const selectedStrategyName = appliedFilters.strategyIdFilter
                ? strategies.find(s => s._id === appliedFilters.strategyIdFilter)?.name
                : undefined

            generateTradesPdf({
                trades: tradesToExport,
                filters: appliedFilters,
                strategyName: selectedStrategyName,
                analytics
            })
        } catch (error) {
            console.error('Error generating PDF report:', error)
            setPdfMessage('Failed to generate PDF. Please try again.')
        } finally {
            setIsExporting(false)
        }
    }

    const fetchTrades = useCallback(async () => {
        setLoading(true)
        setFilterMessage(null)
        try {
            const url = buildTradesUrl({ page, limit: 10, filters: appliedFilters })

            const response = await apiGet<TradesResponse>(url)
            if (response.status === 'success') {
                setTrades(response.data.trades)
                setTotalPages(response.pages)
                setTotalResults(response.total)
                if (response.analytics) {
                    setAnalytics(response.analytics)
                }
            }
        } catch (error) {
            console.error('Error fetching trades:', error)
            setTrades([])
            setTotalPages(1)
            setTotalResults(0)
            setAnalytics({ totalPnl: 0, totalTrades: 0, taxes: 0, netPnl: 0 })
            setFilterMessage('Unable to load trades for the selected filters.')
        } finally {
            setLoading(false)
        }
    }, [page, appliedFilters])

    const isClosedTrade = (trade: Trade) => {
        const activePositionStates = ['PROTECTED', 'UNPROTECTED', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED']
        return typeof trade.exitPrice === 'number'
            && Number.isFinite(trade.exitPrice)
            && trade.exitPrice > 0
            && !activePositionStates.includes(String(trade.positionState || '').toUpperCase())
    }

    const confirmDeleteTrade = async () => {
        if (!tradeToDelete || deletingTradeId) return

        const trade = tradeToDelete
        setDeletingTradeId(trade._id)
        setDeleteMessage(null)
        try {
            await apiDelete<{ status: string }>(`/trades/${encodeURIComponent(trade._id)}`)
            setTradeToDelete(null)
            if (trades.length === 1 && page > 1) {
                setPage((currentPage) => Math.max(1, currentPage - 1))
            } else {
                await fetchTrades()
            }
        } catch (error) {
            setDeleteMessage(error instanceof Error ? error.message : 'Unable to delete this trade. Please try again.')
        } finally {
            setDeletingTradeId(null)
        }
    }

    useEffect(() => {
        fetchTrades()
    }, [fetchTrades])

    useEffect(() => {
        apiGet<{ status: string, data: { strategies: { _id: string, name: string }[] } }>('/strategies')
            .then(res => {
                if (res.status === 'success') {
                    setStrategies(res.data.strategies)
                }
            })
            .catch(console.error)
    }, [])

    const formatDate = (dateString: string) => {
        return new Date(dateString).toLocaleString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
    }

    return (
        <div className="space-y-4 select-none">
            {/* Analytics Summary Cards (Angel One Compact Style) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="bg-white p-3 rounded border border-[#E0E3EB] shadow-sm">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[#787B86] mb-1">Total PNL</p>
                    <div className={`flex items-baseline gap-1 ${analytics.totalPnl >= 0 ? 'text-[#089981]' : 'text-[#F23645]'}`}>
                        <span className="text-xl font-bold tabular-nums">₹{Math.abs(analytics.totalPnl).toFixed(2)}</span>
                        {analytics.totalPnl >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                    </div>
                </div>

                {/* Win Rate Card */}
                {(() => {
                    const completedTrades = trades.filter((t) => t.pnl !== undefined);
                    const winningTrades = completedTrades.filter((t) => (t.pnl || 0) > 0);
                    const winRate = completedTrades.length > 0
                        ? ((winningTrades.length / completedTrades.length) * 100).toFixed(1)
                        : '0.0';
                    return (
                        <div className="bg-white p-3 rounded border border-[#E0E3EB] shadow-sm">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-[#787B86] mb-1">Win Rate</p>
                            <div className="text-xl font-bold tabular-nums text-[#089981]">
                                {winRate}%
                            </div>
                        </div>
                    );
                })()}

                <div className="bg-white p-3 rounded border border-[#E0E3EB] shadow-sm">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[#787B86] mb-1">Est. Taxes & Fees</p>
                    <div className="text-xl font-bold tabular-nums text-[#F23645]">
                        ₹{analytics.taxes.toFixed(2)}
                    </div>
                </div>

                <div className="bg-white p-3 rounded border border-[#E0E3EB] shadow-sm">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[#787B86] mb-1">Net PNL</p>
                    <div className={`flex items-baseline gap-1 ${analytics.netPnl >= 0 ? 'text-[#089981]' : 'text-[#F23645]'}`}>
                        <span className="text-xl font-bold tabular-nums">₹{Math.abs(analytics.netPnl).toFixed(2)}</span>
                        {analytics.netPnl >= 0 ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                    </div>
                </div>
            </div>

            {/* Filters Panel */}
            <div className="bg-white rounded border border-[#E0E3EB] shadow-sm p-4 max-md:p-3">
                <div className="w-full flex flex-col gap-3">
                    {/* Top Row: Search & Dropdowns */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="relative md:col-span-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#787B86]" />
                            <input
                                type="text"
                                placeholder="Search Index / Premium..."
                                className="w-full bg-[#F0F3FA] border border-[#E0E3EB] rounded pl-9 pr-3 py-1.5 text-xs font-medium text-[#1E222D] outline-none focus:border-[#0052FF]"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>

                        {/* Custom Strategy Dropdown */}
                        <div className="relative md:col-span-1">
                            <div
                                className="w-full max-md:min-h-11 bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 cursor-pointer flex items-center justify-between text-xs font-medium transition-colors hover:border-[#0052FF]"
                                onClick={() => {
                                    setIsStrategyDropdownOpen(!isStrategyDropdownOpen)
                                    setIsExitReasonDropdownOpen(false)
                                }}
                            >
                                <span className={strategyIdFilter ? 'text-[#0052FF] font-semibold' : 'text-[#434651]'}>
                                    {strategyIdFilter ? strategies.find(s => s._id === strategyIdFilter)?.name || 'Unknown Strategy' : 'All Strategies'}
                                </span>
                                <ChevronDown className={`w-3.5 h-3.5 text-[#787B86] transition-transform ${isStrategyDropdownOpen ? 'rotate-180' : ''}`} />
                            </div>

                            {isStrategyDropdownOpen && (
                                <>
                                    <div className="fixed inset-0 z-[100]" onClick={() => setIsStrategyDropdownOpen(false)} />
                                    <div className="mobile-filter-menu absolute top-[105%] left-0 w-full z-[110] bg-white border border-[#E0E3EB] rounded shadow-xl py-1">
                                        <div
                                            className={`mobile-filter-option px-3 py-1.5 hover:bg-[#F0F3FA] cursor-pointer text-xs font-semibold flex items-center justify-between transition-colors ${!strategyIdFilter ? 'text-[#0052FF] bg-[#0052FF]/10' : 'text-[#434651]'}`}
                                            onClick={() => {
                                                setStrategyIdFilter('');
                                                setIsStrategyDropdownOpen(false);
                                            }}
                                        >
                                            All Strategies
                                            {!strategyIdFilter && <Check className="w-3.5 h-3.5 text-[#0052FF]" />}
                                        </div>
                                        {strategies.map(s => (
                                            <div
                                                key={s._id}
                                                className={`mobile-filter-option px-3 py-1.5 hover:bg-[#F0F3FA] cursor-pointer text-xs font-semibold flex items-center justify-between transition-colors ${strategyIdFilter === s._id ? 'text-[#0052FF] bg-[#0052FF]/10' : 'text-[#434651]'}`}
                                                onClick={() => {
                                                    setStrategyIdFilter(s._id);
                                                    setIsStrategyDropdownOpen(false);
                                                }}
                                            >
                                                {s.name}
                                                {strategyIdFilter === s._id && <Check className="w-3.5 h-3.5 text-[#0052FF]" />}
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Custom Exit Reason Dropdown */}
                        <div className="relative md:col-span-1">
                            <div
                                className="w-full max-md:min-h-11 bg-[#F0F3FA] border border-[#E0E3EB] rounded px-3 py-1.5 cursor-pointer flex items-center justify-between text-xs font-medium transition-colors hover:border-[#0052FF]"
                                onClick={() => {
                                    setIsExitReasonDropdownOpen(!isExitReasonDropdownOpen)
                                    setIsStrategyDropdownOpen(false)
                                }}
                            >
                                <span className={exitReasonFilter ? 'text-[#0052FF] font-semibold' : 'text-[#434651]'}>
                                    {exitReasonFilter || 'All Exit Reasons'}
                                </span>
                                <ChevronDown className={`w-3.5 h-3.5 text-[#787B86] transition-transform ${isExitReasonDropdownOpen ? 'rotate-180' : ''}`} />
                            </div>

                            {isExitReasonDropdownOpen && (
                                <>
                                    <div className="fixed inset-0 z-[100]" onClick={() => setIsExitReasonDropdownOpen(false)} />
                                    <div className="mobile-filter-menu absolute top-[105%] left-0 w-full z-[110] bg-white border border-[#E0E3EB] rounded shadow-xl py-1">
                                        {[
                                            { value: '', label: 'All Exit Reasons' },
                                            { value: 'Target', label: 'Target' },
                                            { value: 'SL', label: 'SL' },
                                            { value: 'Trailing SL', label: 'Trailing SL' },
                                            { value: 'Strategy', label: 'Strategy' },
                                            { value: 'HA_TREND_REVERSAL', label: 'HA_TREND_REVERSAL' }
                                        ].map(option => (
                                            <div
                                                key={option.value}
                                                className={`mobile-filter-option px-3 py-1.5 hover:bg-[#F0F3FA] cursor-pointer text-xs font-semibold flex items-center justify-between transition-colors ${exitReasonFilter === option.value ? 'text-[#0052FF] bg-[#0052FF]/10' : 'text-[#434651]'}`}
                                                onClick={() => {
                                                    setExitReasonFilter(option.value);
                                                    setIsExitReasonDropdownOpen(false);
                                                }}
                                            >
                                                {option.label}
                                                {exitReasonFilter === option.value && <Check className="w-3.5 h-3.5 text-[#0052FF]" />}
                                            </div>
                                        ))}
                                    </div>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Bottom Row: Date/Time Pickers & Actions */}
                    <div className="flex flex-col xl:flex-row gap-3 justify-between items-center pt-1 border-t border-[#E0E3EB] max-md:items-stretch">
                        {/* Time & Date Range */}
                        <div className="grid grid-cols-2 max-sm:grid-cols-1 md:grid-cols-4 gap-3 w-full xl:w-auto">
                            <div className="relative">
                                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#787B86] z-10" />
                                <DatePicker
                                    selected={startDate ? new Date(startDate) : null}
                                    onChange={(date: Date | null) => {
                                        if (date) {
                                            const offset = date.getTimezoneOffset()
                                            const localDate = new Date(date.getTime() - (offset * 60 * 1000))
                                            setStartDate(localDate.toISOString().split('T')[0])
                                        } else {
                                            setStartDate('')
                                        }
                                    }}
                                    dateFormat="yyyy-MM-dd"
                                    placeholderText="Start Date"
                                    popperClassName="trade-history-datepicker-popper"
                                    className="bg-[#F0F3FA] border border-[#E0E3EB] rounded pl-8 pr-2 py-1.5 text-xs text-[#1E222D] outline-none focus:border-[#0052FF] font-medium w-full"
                                />
                            </div>
                            <div className="relative">
                                <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#787B86] z-10" />
                                <DatePicker
                                    selected={endDate ? new Date(endDate) : null}
                                    onChange={(date: Date | null) => {
                                        if (date) {
                                            const offset = date.getTimezoneOffset()
                                            const localDate = new Date(date.getTime() - (offset * 60 * 1000))
                                            setEndDate(localDate.toISOString().split('T')[0])
                                        } else {
                                            setEndDate('')
                                        }
                                    }}
                                    dateFormat="yyyy-MM-dd"
                                    placeholderText="End Date"
                                    popperClassName="trade-history-datepicker-popper"
                                    className="bg-[#F0F3FA] border border-[#E0E3EB] rounded pl-8 pr-2 py-1.5 text-xs text-[#1E222D] outline-none focus:border-[#0052FF] font-medium w-full"
                                />
                            </div>
                            <div className="relative z-[90] max-md:z-auto">
                                <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#787B86] z-10" />
                                <input
                                    type="time"
                                    value={timeFrom}
                                    onChange={(e) => setTimeFrom(e.target.value)}
                                    className="bg-[#F0F3FA] border border-[#E0E3EB] rounded pl-8 pr-2 py-1.5 text-xs text-[#1E222D] outline-none focus:border-[#0052FF] font-medium w-full"
                                />
                            </div>
                            <div className="relative z-[90] max-md:z-auto">
                                <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#787B86] z-10" />
                                <input
                                    type="time"
                                    value={timeTo}
                                    onChange={(e) => setTimeTo(e.target.value)}
                                    className="bg-[#F0F3FA] border border-[#E0E3EB] rounded pl-8 pr-2 py-1.5 text-xs text-[#1E222D] outline-none focus:border-[#0052FF] font-medium w-full"
                                />
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex w-full xl:w-auto items-center gap-2 max-md:grid max-md:grid-cols-2">
                            <button
                                onClick={() => {
                                    const timeError = validateTradesTimeRange(timeFrom, timeTo)
                                    if (timeError) {
                                        setFilterMessage(timeError)
                                        setTrades([])
                                        setTotalPages(1)
                                        setTotalResults(0)
                                        setAnalytics({ totalPnl: 0, totalTrades: 0, taxes: 0, netPnl: 0 })
                                        return
                                    }
                                    setFilterMessage(null)
                                    setPage(1)
                                    setAppliedFilters({
                                        searchQuery,
                                        exitReasonFilter,
                                        strategyIdFilter,
                                        startDate,
                                        endDate,
                                        timeFrom,
                                        timeTo
                                    })
                                }}
                                className="flex-1 xl:flex-none px-4 py-1.5 bg-[#0052FF] hover:bg-[#0047D0] text-white text-xs font-semibold rounded transition-colors shadow-sm flex items-center justify-center gap-1.5"
                            >
                                <Filter className="w-3.5 h-3.5 fill-current" />
                                Apply
                            </button>
                            <button
                                onClick={() => {
                                    setSearchQuery('')
                                    setExitReasonFilter('')
                                    setStrategyIdFilter('')
                                    setStartDate('')
                                    setEndDate('')
                                    setTimeFrom('')
                                    setTimeTo('')
                                    setPage(1)
                                    setAppliedFilters({ searchQuery: '', exitReasonFilter: '', strategyIdFilter: '', startDate: '', endDate: '', timeFrom: '', timeTo: '' })
                                    setPdfMessage(null)
                                }}
                                className="flex-1 xl:flex-none px-4 py-1.5 bg-[#F0F3FA] hover:bg-[#E0E3EB] text-[#434651] text-xs font-semibold rounded transition-colors flex items-center justify-center gap-1.5"
                            >
                                <Filter className="w-3.5 h-3.5" />
                                Reset
                            </button>
                            <button
                                onClick={handleDownloadPdf}
                                disabled={isExporting}
                                className="flex-1 xl:flex-none px-4 py-1.5 bg-[#F0F3FA] hover:bg-[#E0E3EB] text-[#1E222D] text-xs font-semibold rounded transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                            >
                                <Download className="w-3.5 h-3.5 text-[#0052FF]" />
                                {isExporting ? 'Generating...' : 'Download PDF'}
                            </button>
                            <button
                                onClick={() => fetchTrades()}
                                className="max-md:min-h-11 max-md:min-w-11 p-1.5 bg-[#0052FF]/10 hover:bg-[#0052FF]/20 text-[#0052FF] text-xs font-semibold rounded transition-colors"
                                title="Refresh"
                            >
                                <RefreshCw className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                    {filterMessage && (
                        <div className="mt-2 p-2.5 rounded bg-[#FFF2F2] border border-[#F23645]/30 text-[#F23645] text-xs font-semibold">
                            {filterMessage}
                        </div>
                    )}
                    {pdfMessage && (
                        <div className="mt-2 p-2.5 rounded bg-[#FFF2F2] border border-[#F23645]/30 text-[#F23645] text-xs font-semibold flex items-center justify-between">
                            <span>{pdfMessage}</span>
                            <button onClick={() => setPdfMessage(null)} className="text-[#F23645] hover:underline text-xs">Dismiss</button>
                        </div>
                    )}
                </div>
            </div>

            {/* Table Content */}
            <div className="bg-white rounded border border-[#E0E3EB] shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full max-md:hidden max-md:min-w-[900px] text-left border-collapse">
                        <thead>
                            <tr className="bg-[#F8F9FA] border-b border-[#E0E3EB]">
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86]">Entry date &amp; time</th>
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86]">Strategy</th>
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86]">Index</th>
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86]">Premium</th>
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86] text-right">Qty</th>
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86] text-right">Entry</th>
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86] text-right">Exit</th>
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86] text-right">Total PNL</th>
                                <th className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wider text-[#787B86]">Reason</th>
                                <th className="px-4 py-2.5 text-center text-[11px] font-bold uppercase tracking-wider text-[#787B86]">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E0E3EB]">
                            {loading ? (
                                <tr>
                                    <td colSpan={10} className="px-4 py-12 text-center">
                                        <div className="flex flex-col items-center gap-2">
                                            <RefreshCw className="w-5 h-5 text-[#0052FF] animate-spin" />
                                            <p className="text-xs font-semibold text-[#787B86]">Fetching Trade Records...</p>
                                        </div>
                                    </td>
                                </tr>
                            ) : trades.length === 0 ? (
                                <tr>
                                    <td colSpan={10} className="px-4 py-12 text-center">
                                        <p className="text-xs font-semibold text-[#787B86]">No transaction records found</p>
                                    </td>
                                </tr>
                            ) : (
                                trades.map((trade) => (
                                    <tr key={trade._id} className="hover:bg-[#F8F9FA] transition-colors">
                                        <td className="px-4 py-2 text-xs font-medium text-[#434651]">
                                            <div className="flex items-center gap-2 max-md:flex-wrap">
                                                <Clock className="w-3 h-3 text-[#787B86]" />
                                                <span>{formatDate(trade.createdAt)}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-2">
                                            <span className="px-2 py-0.5 bg-[#0052FF]/10 text-[#0052FF] text-[10px] font-bold uppercase rounded">
                                                {trade.strategyId?.name || 'Manual'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 text-xs font-bold text-[#1E222D] uppercase">
                                            {trade.index}
                                        </td>
                                        <td className="px-4 py-2 text-xs font-bold text-[#1E222D]">
                                            {trade.premium}
                                        </td>
                                        <td className="px-4 py-2 text-xs font-semibold text-[#434651] text-right tabular-nums">
                                            {trade.qty}
                                        </td>
                                        <td className="px-4 py-2 text-xs font-bold text-[#1E222D] text-right tabular-nums">
                                            ₹{trade.buyPrice.toFixed(2)}
                                        </td>
                                        <td className="px-4 py-2 text-xs font-bold text-[#1E222D] text-right tabular-nums">
                                            {trade.exitPrice ? `₹${trade.exitPrice.toFixed(2)}` : '---'}
                                        </td>
                                        <td className="px-4 py-2 text-right">
                                            <div className={`flex items-center justify-end gap-1 text-xs font-bold tabular-nums ${trade.pnl !== undefined ? (trade.pnl >= 0 ? 'text-[#089981]' : 'text-[#F23645]') : 'text-[#787B86]'}`}>
                                                {trade.pnl !== undefined ? (trade.pnl >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />) : null}
                                                {trade.pnl !== undefined ? `₹${trade.pnl.toFixed(2)}` : '---'}
                                            </div>
                                        </td>
                                        <td className="px-4 py-2">
                                            <span className={`text-[10px] font-bold uppercase ${trade.exitReason === 'Target' ? 'text-[#089981]' : trade.exitReason === 'SL' ? 'text-[#F23645]' : 'text-[#787B86]'}`}>
                                                {trade.exitReason || 'Active'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 text-center">
                                            {isClosedTrade(trade) && (
                                                <button
                                                    type="button"
                                                    onClick={() => { setDeleteMessage(null); setTradeToDelete(trade) }}
                                                    disabled={deletingTradeId === trade._id}
                                                    className="inline-flex min-h-9 min-w-9 items-center justify-center rounded text-[#F23645] hover:bg-[#F23645]/10 disabled:opacity-50"
                                                    aria-label={`Delete closed trade ${trade.premium}`}
                                                    title="Delete trade from history"
                                                >
                                                    <Trash2 className="h-4 w-4" />
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="hidden max-md:block space-y-2 p-3">
                    {loading && <p className="py-8 text-center text-xs font-semibold text-[#787B86]">Fetching Trade Records...</p>}
                    {!loading && trades.length === 0 && <p className="py-8 text-center text-xs font-semibold text-[#787B86]">No transaction records found</p>}
                    {!loading && trades.length > 0 && trades.map((trade) => (
                        <details key={`mobile-${trade._id}`} className="rounded-xl border border-[#E0E3EB] bg-white p-3 shadow-sm">
                            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 max-md:flex-wrap">
                                        <span className="truncate text-xs font-bold uppercase text-[#1E222D]">{trade.index}</span>
                                        <span className="rounded bg-[#0052FF]/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#0052FF]">{trade.strategyId?.name || 'Manual'}</span>
                                    </div>
                                    <p className="mt-1 text-[10px] font-medium text-[#787B86]">{formatDate(trade.createdAt)} · Qty {trade.qty}</p>
                                </div>
                                <span className={`shrink-0 text-xs font-bold tabular-nums ${trade.pnl !== undefined ? (trade.pnl >= 0 ? 'text-[#089981]' : 'text-[#F23645]') : 'text-[#787B86]'}`}>
                                    {trade.pnl !== undefined ? `₹${trade.pnl.toFixed(2)}` : '---'}
                                </span>
                            </summary>
                            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#E0E3EB] pt-3 text-[10px]">
                                <div><p className="text-[#787B86]">Premium</p><p className="font-bold text-[#1E222D]">{trade.premium}</p></div>
                                <div><p className="text-[#787B86]">Reason</p><p className="font-bold uppercase text-[#1E222D]">{trade.exitReason || 'Active'}</p></div>
                                <div><p className="text-[#787B86]">Entry</p><p className="font-bold text-[#1E222D]">₹{trade.buyPrice.toFixed(2)}</p></div>
                                <div><p className="text-[#787B86]">Exit</p><p className="font-bold text-[#1E222D]">{trade.exitPrice ? `₹${trade.exitPrice.toFixed(2)}` : '---'}</p></div>
                            </div>
                            {isClosedTrade(trade) && (
                                <button
                                    type="button"
                                    onClick={() => { setDeleteMessage(null); setTradeToDelete(trade) }}
                                    disabled={deletingTradeId === trade._id}
                                    className="mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded border border-[#F23645]/30 px-3 text-xs font-semibold text-[#F23645] hover:bg-[#F23645]/5 disabled:opacity-50"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    Delete from history
                                </button>
                            )}
                        </details>
                    ))}
                </div>

                {/* Pagination */}
                <div className="px-4 py-3 border-t border-[#E0E3EB] bg-[#F8F9FA] flex flex-col md:flex-row items-center justify-between gap-3">
                    <p className="text-[11px] font-semibold text-[#787B86]">
                        Showing <span className="text-[#1E222D] font-bold">{trades.length}</span> of <span className="text-[#1E222D] font-bold">{totalResults}</span> Trades
                    </p>
                    <div className="mobile-pagination flex items-center gap-1.5 max-md:max-w-full max-md:flex-wrap max-md:justify-center">
                        <button
                            disabled={page === 1}
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            className="w-7 h-7 max-md:min-h-11 max-md:min-w-11 flex items-center justify-center bg-white border border-[#E0E3EB] rounded disabled:opacity-30 hover:border-[#0052FF] transition-colors"
                        >
                            <ChevronLeft className="w-4 h-4 text-[#434651]" />
                        </button>
                        <div className="flex items-center gap-1 max-md:max-w-full max-md:flex-wrap max-md:justify-center">
                            {(() => {
                                const pages: (number | string)[] = [];
                                if (totalPages <= 5) {
                                    for (let i = 1; i <= totalPages; i++) pages.push(i);
                                } else {
                                    if (page <= 3) {
                                        pages.push(1, 2, 3, 4, '...', totalPages - 1, totalPages);
                                    } else if (page >= totalPages - 2) {
                                        pages.push(1, 2, '...', totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
                                    } else {
                                        pages.push(1, '...', page - 1, page, page + 1, '...', totalPages);
                                    }
                                }
                                return pages.map((p, i) => (
                                    p === '...' ? (
                                        <span key={`ellipsis-${i}`} className="w-7 h-7 flex items-center justify-center text-[#787B86] font-semibold text-xs">
                                            ...
                                        </span>
                                    ) : (
                                        <button
                                            key={`page-${p}`}
                                            onClick={() => setPage(p as number)}
                                            className={`w-7 h-7 max-md:min-h-11 max-md:min-w-11 text-xs font-semibold rounded transition-colors ${page === p ? 'bg-[#0052FF] text-white shadow-sm' : 'bg-white border border-[#E0E3EB] text-[#434651] hover:bg-[#F0F3FA]'}`}
                                        >
                                            {p}
                                        </button>
                                    )
                                ));
                            })()}
                        </div>
                        <button
                            disabled={page === totalPages}
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            className="w-7 h-7 max-md:min-h-11 max-md:min-w-11 flex items-center justify-center bg-white border border-[#E0E3EB] rounded disabled:opacity-30 hover:border-[#0052FF] transition-colors"
                        >
                            <ChevronRight className="w-4 h-4 text-[#434651]" />
                        </button>
                    </div>
                </div>
            </div>

            <dialog
                ref={deleteDialogRef}
                className="w-[calc(100%-2rem)] max-w-md max-md:max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-2rem)] max-md:overflow-y-auto rounded-lg border border-[#E0E3EB] bg-white p-5 text-[#1E222D] shadow-xl backdrop:bg-slate-950/50"
                aria-labelledby="delete-trade-title"
                aria-describedby="delete-trade-description"
                onCancel={(event) => {
                    event.preventDefault()
                    if (!deletingTradeId) setTradeToDelete(null)
                }}
            >
                {tradeToDelete && (
                    <div>
                        <h2 id="delete-trade-title" className="text-base font-bold text-[#1E222D]">Delete this trade?</h2>
                        <p id="delete-trade-description" className="mt-2 text-sm text-[#434651]">
                            This permanently removes <span className="font-semibold">{tradeToDelete.premium}</span> from trade history. History totals and future PDF exports will change. This does not cancel or change any broker order.
                        </p>
                        <p className="mt-2 text-xs text-[#787B86]">
                            {formatDate(tradeToDelete.createdAt)} · {tradeToDelete.strategyId?.name || 'Manual'} · Qty {tradeToDelete.qty} · Exit {tradeToDelete.exitPrice ? `₹${tradeToDelete.exitPrice.toFixed(2)}` : '—'}
                        </p>
                        {deleteMessage && <p role="alert" className="mt-3 rounded bg-[#FFF2F2] p-2 text-xs font-semibold text-[#F23645]">{deleteMessage}</p>}
                        <div className="mt-5 flex justify-end gap-2">
                            <button
                                type="button"
                                autoFocus
                                disabled={Boolean(deletingTradeId)}
                                onClick={() => { setDeleteMessage(null); setTradeToDelete(null) }}
                                className="min-h-11 rounded bg-[#F0F3FA] px-4 text-sm font-semibold text-[#434651] disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                disabled={Boolean(deletingTradeId)}
                                onClick={() => void confirmDeleteTrade()}
                                className="min-h-11 rounded bg-[#F23645] px-4 text-sm font-semibold text-white disabled:opacity-50"
                            >
                                {deletingTradeId ? 'Deleting…' : 'Delete trade'}
                            </button>
                        </div>
                    </div>
                )}
            </dialog>
        </div>
    )
}

