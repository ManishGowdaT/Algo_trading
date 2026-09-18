import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  BarChart2,
  Zap
} from 'lucide-react';

import { apiGet } from '../../trading';
import { startResilientPolling } from '../../utils/resilientPolling';
import { usePageTitle } from '../../hooks/usePageTitle';
import TradingViewChart, {
  type CandleItem,
  type LineSeriesItem,
  type MarkerItem,
  type PriceLineItem,
  type LayerToggles
} from '../../components/chart/TradingViewChart';
import { ChartToolbar } from '../../components/chart/ChartToolbar';
import { computeLocalEMA, computeLocalJMA } from '../../utils/indicatorUtils';

type IndexConfig = {
  id: string;
  name: string;
  underlying: string;
  exchange: string;
};

const INDICES_CONFIG: IndexConfig[] = [
  { id: 'nifty', name: 'NIFTY 50', underlying: 'NIFTY', exchange: 'NSE' },
  { id: 'sensex', name: 'SENSEX', underlying: 'SENSEX', exchange: 'BSE' },
  { id: 'banknifty', name: 'BANKNIFTY', underlying: 'BANKNIFTY', exchange: 'NSE' },
  { id: 'finnifty', name: 'FINNIFTY', underlying: 'FINNIFTY', exchange: 'NSE' },
];

type IndexData = {
  ltp: number | null;
  close: number | null;
  isOffline: boolean;
};

type IndexFetchResult = {
  id: string;
  ltp?: number;
  close?: number;
  isOffline: boolean;
};

type IndexPriceResponse = {
  ltp: number;
  close?: number;
  open?: number;
};

type ChartDataResponse = {
  underlying: string;
  date: string;
  interval: string;
  candles: CandleItem[];
  indicators: {
    ema: LineSeriesItem[];
    jma: LineSeriesItem[];
    modifiedHa: CandleItem[];
  };
  tradeOverlays: {
    markers: MarkerItem[];
    priceLines: PriceLineItem[];
  };
};

const DashboardPage: React.FC = () => {
  usePageTitle('Dashboard');

  // Selected Chart Controls
  const [selectedUnderlying, setSelectedUnderlying] = useState<string>('NIFTY');
  const [timeframe, setTimeframe] = useState<string>('5m');
  const [selectedDate, setSelectedDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [chartType, setChartType] = useState<'candlestick' | 'heikenAshi'>('candlestick');

  // Transient Chart-Only Indicator Settings (Never saved to localStorage/DB)
  const [emaPeriod, setEmaPeriod] = useState<number>(20);
  const [jmaLength, setJmaLength] = useState<number>(7);

  // Layer Toggles
  const [toggles, setToggles] = useState<LayerToggles>({
    showEma: true,
    showJma: true,
    showMha: false,
    showMarkers: true,
    showPriceLines: true,
  });

  // Chart Data State
  const [chartData, setChartData] = useState<ChartDataResponse | null>(null);
  const [chartLoading, setChartLoading] = useState<boolean>(false);

  // Live indices state mapping key -> IndexData
  const [indicesData, setIndicesData] = useState<Record<string, IndexData>>({
    nifty: { ltp: null, close: null, isOffline: false },
    sensex: { ltp: null, close: null, isOffline: false },
    banknifty: { ltp: null, close: null, isOffline: false },
    finnifty: { ltp: null, close: null, isOffline: false },
  });

  // Poll live indices data every 2 seconds with error resilience
  useEffect(() => {
    let active = true;

    const fetchLiveIndices = async () => {
      const fetchPromises: Promise<IndexFetchResult>[] = INDICES_CONFIG.map(async (cfg): Promise<IndexFetchResult> => {
        try {
          const res = await apiGet<IndexPriceResponse>(`/market/index-ltp?underlying=${encodeURIComponent(cfg.underlying)}`);
          if (res && typeof res.ltp === 'number' && res.ltp > 0) {
            return {
              id: cfg.id,
              ltp: res.ltp,
              close: res.close && res.close > 0 ? res.close : (res.open && res.open > 0 ? res.open : res.ltp),
              isOffline: false
            };
          }
          throw new Error('Invalid LTP');
        } catch {
          return { id: cfg.id, isOffline: true };
        }
      });

      const results: IndexFetchResult[] = await Promise.all(fetchPromises);
      if (!active) return;
      if (!results.some((item) => !item.isOffline)) throw new Error('Live index service unavailable');

      setIndicesData((prev) => {
        const updated: Record<string, IndexData> = { ...prev };
        results.forEach((item: IndexFetchResult) => {
          const prevItem = prev[item.id] || { ltp: null, close: null, isOffline: false };
          if (item.isOffline) {
            updated[item.id] = {
              ...prevItem,
              isOffline: true
            };
          } else if (item.ltp !== undefined) {
            updated[item.id] = {
              ltp: item.ltp,
              close: item.close !== undefined ? item.close : prevItem.close,
              isOffline: false
            };
          }
        });
        return updated;
      });
    };

    const stopPolling = startResilientPolling(fetchLiveIndices, { intervalMs: 2000 });
    return () => {
      active = false;
      stopPolling();
    };
  }, []);

  // Fetch Chart Market Data from Backend
  useEffect(() => {
    let active = true;
    const fetchChart = async () => {
      setChartLoading(true);
      try {
        const url = `/chart/market-data?underlying=${encodeURIComponent(selectedUnderlying)}&date=${encodeURIComponent(selectedDate)}&interval=${encodeURIComponent(timeframe)}`;
        const res = await apiGet<{ data: ChartDataResponse }>(url);
        if (active && res && res.data) {
          setChartData(res.data);
        }
      } catch (err) {
        console.error('Failed to fetch chart data:', err);
      } finally {
        if (active) setChartLoading(false);
      }
    };

    fetchChart();
    return () => { active = false; };
  }, [selectedUnderlying, timeframe, selectedDate]);

  // Client-Side Visualization Indicator Computation (< 1ms recalculation)
  const localEma = useMemo(() => {
    return computeLocalEMA(chartData?.candles || [], emaPeriod);
  }, [chartData?.candles, emaPeriod]);

  const localJma = useMemo(() => {
    return computeLocalJMA(chartData?.candles || [], jmaLength);
  }, [chartData?.candles, jmaLength]);

  const handleToggleChange = (key: keyof LayerToggles) => {
    setToggles((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleApplyParams = (newEma: number, newJma: number) => {
    setEmaPeriod(newEma);
    setJmaLength(newJma);
  };

  const formatNumber = (val: number | null) => {
    if (val === null || val <= 0) return '—';
    return val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  return (
    <div className="space-y-4 max-md:space-y-3 select-none">
      {/* Top Section: Institutional Ticker Watchlist Bar (Angel One Inspired) */}
      <div className="hidden md:grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {INDICES_CONFIG.map((cfg) => {
          const data = indicesData[cfg.id] || { ltp: null, close: null, isOffline: false };
          const ltp = data.ltp;
          const close = data.close;

          let absChange = 0;
          let pctChange = 0;
          let isPositive = true;

          if (ltp !== null && close !== null && close > 0) {
            absChange = ltp - close;
            pctChange = (absChange / close) * 100;
            isPositive = absChange >= 0;
          }

          const hasData = ltp !== null && ltp > 0;
          const isSelected = selectedUnderlying === cfg.underlying;

          return (
            <div
              key={cfg.id}
              onClick={() => setSelectedUnderlying(cfg.underlying)}
              className={`p-3 bg-white rounded border cursor-pointer transition-all ${
                isSelected
                  ? 'border-[#0052FF] ring-1 ring-[#0052FF]/20 shadow-sm'
                  : 'border-[#E0E3EB] hover:border-[#B2B5BE]'
              }`}
            >
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-bold text-[#1E222D]">
                    {cfg.name}
                  </span>
                  <span className="text-[9px] font-bold uppercase px-1 py-0.2 rounded bg-[#F0F3FA] text-[#787B86]">
                    {cfg.exchange}
                  </span>
                </div>

                {data.isOffline ? (
                  <span className="flex items-center gap-1 text-[9px] font-semibold text-[#FF9800] bg-[#FF9800]/10 px-1.5 py-0.5 rounded">
                    <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                    Offline
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-[9px] font-bold text-[#089981]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#089981] animate-pulse" />
                    LIVE
                  </span>
                )}
              </div>

              <div className="flex items-baseline justify-between">
                <span className="text-base font-bold text-[#1E222D] tabular-nums tracking-tight">
                  {formatNumber(ltp)}
                </span>

                {hasData && (
                  <div className={`flex items-center gap-0.5 text-xs font-semibold tabular-nums ${isPositive ? 'text-[#089981]' : 'text-[#F23645]'}`}>
                    {isPositive ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                    <span>{isPositive ? '+' : ''}{absChange.toFixed(2)}</span>
                    <span className="text-[10px] font-normal">({isPositive ? '+' : ''}{pctChange.toFixed(2)}%)</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex w-full max-w-full md:hidden gap-2 overflow-x-auto overscroll-x-contain pb-1 -mx-1 px-1 snap-x [touch-action:pan-x_pan-y]">
        {INDICES_CONFIG.map((cfg) => {
          const data = indicesData[cfg.id] || { ltp: null, close: null, isOffline: false };
          const ltp = data.ltp;
          const close = data.close;
          const change = ltp !== null && close !== null ? ltp - close : null;
          const hasData = ltp !== null && ltp > 0;
          const isPositive = (change ?? 0) >= 0;

          return (
            <div key={cfg.id} className="min-w-[136px] shrink-0 snap-start rounded border border-[#E0E3EB] bg-white px-2.5 py-2 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[10px] font-bold text-[#1E222D]">{cfg.name}</span>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${data.isOffline ? 'bg-[#FF9800]' : 'bg-[#089981]'}`} />
              </div>
              <div className="mt-1 flex items-baseline justify-between gap-2">
                <span className="text-xs font-bold tabular-nums text-[#1E222D]">{formatNumber(ltp)}</span>
                {hasData && <span className={`text-[10px] font-semibold tabular-nums ${isPositive ? 'text-[#089981]' : 'text-[#F23645]'}`}>{isPositive ? '+' : ''}{change?.toFixed(2)}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Main Content Layout: Institutional Trading View Terminal Container */}
        <div className="bg-white p-4 max-md:p-3 rounded border border-[#E0E3EB] shadow-sm flex flex-col">
        {/* Terminal Header */}
        <div className="flex items-center justify-between gap-2 max-md:flex-wrap pb-3 mb-3 border-b border-[#E0E3EB]">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-[#0052FF]/10 rounded flex items-center justify-center text-[#0052FF]">
              <BarChart2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-[#1E222D] tracking-tight uppercase">
                {selectedUnderlying} Real-Time Execution Chart
              </h3>
              <p className="text-[10px] font-medium text-[#787B86]">
                Institutional Data Feed &amp; Signal Overlays
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#434651] bg-[#F0F3FA] px-2 py-1 rounded border border-[#E0E3EB]">
              <Zap className="w-3 h-3 text-[#0052FF]" /> Fast Order Terminal
            </span>
          </div>
        </div>

        {/* Toolbar with Indicators Settings Panel */}
        <ChartToolbar
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
          selectedDate={selectedDate}
          onDateChange={setSelectedDate}
          chartType={chartType}
          onChartTypeChange={setChartType}
          toggles={toggles}
          onToggleChange={handleToggleChange}
          emaPeriod={emaPeriod}
          jmaLength={jmaLength}
          onApplyParams={handleApplyParams}
        />

        {/* Institutional Chart Container */}
        <div className="w-full flex-1 h-[calc(100vh-210px)] min-h-[720px] max-md:h-[clamp(280px,55dvh,420px)] max-md:min-h-[280px] relative rounded border border-[#E0E3EB] overflow-hidden bg-white">
          {chartLoading && (
            <div className="absolute inset-0 bg-white/70 backdrop-blur-[1px] flex items-center justify-center z-10">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-white border border-[#E0E3EB] rounded shadow-md text-xs font-semibold text-[#1E222D]">
                <RefreshCw className="w-4 h-4 text-[#0052FF] animate-spin" />
                <span>Syncing Market Candles...</span>
              </div>
            </div>
          )}

          <TradingViewChart
            key={`${selectedUnderlying}-${selectedDate}-${timeframe}`}
            candles={chartData?.candles || []}
            emaSeries={localEma}
            jmaSeries={localJma}
            modifiedHaSeries={chartData?.indicators?.modifiedHa || []}
            markers={chartData?.tradeOverlays?.markers || []}
            priceLines={chartData?.tradeOverlays?.priceLines || []}
            toggles={toggles}
            chartType={chartType}
            isDarkMode={false}
          />
        </div>
      </div>
    </div>
  );
};

export default DashboardPage;
