import React, { useEffect, useRef, useState } from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type SeriesMarker,
  type Time,
  ColorType,
  LineStyle,
} from 'lightweight-charts';
import { transformToHeikenAshi, type CandleItem } from '../../utils/heikenAshi';

export type { CandleItem };

export type LineSeriesItem = {
  time: number;
  value: number;
};

export type MarkerItem = {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  text: string;
};

export type PriceLineItem = {
  title: string;
  price: number;
  color: string;
  lineStyle?: number;
};

export type LayerToggles = {
  showEma: boolean;
  showJma: boolean;
  showMha: boolean;
  showMarkers: boolean;
  showPriceLines: boolean;
};

type TradingViewChartProps = {
  candles: CandleItem[];
  emaSeries?: LineSeriesItem[];
  jmaSeries?: LineSeriesItem[];
  modifiedHaSeries?: CandleItem[];
  markers?: MarkerItem[];
  priceLines?: PriceLineItem[];
  toggles: LayerToggles;
  chartType?: 'candlestick' | 'heikenAshi';
  isDarkMode?: boolean;
  liveUpdates?: boolean;
};

type ActiveTooltipInfo = {
  x: number;
  y: number;
  action: string;
  strike: string;
  fullSymbol: string;
  price: string;
  pnl?: string;
  time: string;
};

/**
  Parses raw trade marker text and extracts strike (e.g. 77000 CE), price, and PnL.
 */
function parseTradeMarker(rawText: string) {
  const isBuy = rawText.toUpperCase().includes('BUY');
  const action = isBuy ? 'BUY' : 'SELL';

  // Extract strike (e.g. 77000CE or 53000PE -> 77000 CE)
  let strike = '';
  const strikeMatch = rawText.match(/([0-9]{4,6}\s*(?:CE|PE))/i);
  if (strikeMatch) {
    const raw = strikeMatch[1].toUpperCase();
    strike = raw.replace(/(CE|PE)/, ' $1');
  }

  // Extract Execution Price
  let price = '';
  const priceMatch = rawText.match(/@\s*₹?\s*([0-9]+\.?[0-9]*)/);
  if (priceMatch) {
    price = `₹${parseFloat(priceMatch[1]).toFixed(2)}`;
  }

  // Extract PnL for SELL orders
  let pnl = '';
  const pnlMatch = rawText.match(/PnL:\s*₹?\s*([+-]?[0-9]+\.?[0-9]*)/i);
  if (pnlMatch) {
    const val = parseFloat(pnlMatch[1]);
    pnl = `${val >= 0 ? '+' : ''}₹${val.toFixed(2)}`;
  }

  return {
    action,
    strike,
    price,
    pnl,
    rawText,
  };
}

export const TradingViewChart: React.FC<TradingViewChartProps> = ({
  candles,
  emaSeries = [],
  jmaSeries = [],
  modifiedHaSeries = [],
  markers = [],
  priceLines = [],
  toggles,
  chartType = 'candlestick',
  isDarkMode = false,
  liveUpdates = false,
}) => {
  const fittedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const jmaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const mhaSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<any[]>([]);

  const [activeTooltip, setActiveTooltip] = useState<ActiveTooltipInfo | null>(null);

  // Initialize Chart Container
  useEffect(() => {
    if (!containerRef.current) return;

    const width = containerRef.current.clientWidth || 800;
    const height = containerRef.current.clientHeight || 720;

    const chart = createChart(containerRef.current, {
      width,
      height,
      layout: {
        background: { type: ColorType.Solid, color: isDarkMode ? '#0f172a' : '#ffffff' },
        textColor: isDarkMode ? '#94a3b8' : '#334155',
      },
      grid: {
        vertLines: { color: isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.06)' },
        horzLines: { color: isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.06)' },
      },
      crosshair: {
        mode: 0,
      },
      localization: {
        timeFormatter: (timestamp: number) => {
          if (typeof timestamp !== 'number') return '';
          const date = new Date(timestamp * 1000);
          return date.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
        },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)',
        tickMarkFormatter: (timestamp: number) => {
          if (typeof timestamp !== 'number') return '';
          const date = new Date(timestamp * 1000);
          return date.toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
        },
      },
      rightPriceScale: {
        borderColor: isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)',
      },
    });

    chartRef.current = chart;

    // Layer 1: Base Candlesticks
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });
    candleSeriesRef.current = candleSeries;

    // Layer 2: EMA (Cyan)
    const emaSeriesInstance = chart.addLineSeries({
      color: '#06b6d4',
      lineWidth: 2,
      title: 'EMA',
    });
    emaSeriesRef.current = emaSeriesInstance;

    // Layer 3: JMA (Purple)
    const jmaSeriesInstance = chart.addLineSeries({
      color: '#a855f7',
      lineWidth: 2,
      title: 'JMA',
    });
    jmaSeriesRef.current = jmaSeriesInstance;

    // Layer 4: Modified Heiken Ashi
    const mhaSeriesInstance = chart.addCandlestickSeries({
      upColor: 'rgba(56, 189, 248, 0.6)',
      downColor: 'rgba(244, 63, 94, 0.6)',
      borderVisible: false,
      wickUpColor: 'rgba(56, 189, 248, 0.6)',
      wickDownColor: 'rgba(244, 63, 94, 0.6)',
    });
    mhaSeriesRef.current = mhaSeriesInstance;

    // ResizeObserver for reliable canvas dimensions & instant auto-fitting
    const resizeObserver = new ResizeObserver((entries) => {
      if (!chartRef.current || entries.length === 0) return;
      const { width: w, height: h } = entries[0].contentRect;
      if (w > 0 && h > 0) {
        requestAnimationFrame(() => {
          chartRef.current?.applyOptions({ width: w, height: h });
        });
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [isDarkMode]);

  // Handle Crosshair Move to show/hide trade hover tooltip
  useEffect(() => {
    if (!chartRef.current) return;

    const handleCrosshairMove = (param: any) => {
      if (
        !param ||
        !param.point ||
        param.point.x < 0 ||
        param.point.y < 0 ||
        !param.time ||
        !toggles.showMarkers ||
        !markers ||
        markers.length === 0
      ) {
        setActiveTooltip(null);
        return;
      }

      const hoverTime = param.time as number;
      const matchedMarker = markers.find((m) => m.time === hoverTime);

      if (matchedMarker) {
        const parsed = parseTradeMarker(matchedMarker.text || '');
        const containerWidth = containerRef.current?.clientWidth || 800;

        let x = param.point.x + 15;
        if (x + 220 > containerWidth) {
          x = param.point.x - 225;
        }
        const y = Math.max(10, param.point.y - 40);

        const date = new Date(hoverTime * 1000);
        const timeStr = date.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });

        let activeStrike = parsed.strike;
        if (!activeStrike) {
          const prevBuy = markers
            .filter((m) => m.time <= hoverTime)
            .reverse()
            .find((m) => (m.text || '').toUpperCase().includes('BUY'));
          if (prevBuy) {
            const prevParsed = parseTradeMarker(prevBuy.text || '');
            activeStrike = prevParsed.strike;
          }
        }

        const symbolMatch = matchedMarker.text.match(/\(([A-Z0-9]+)\)/);
        const fullSymbol = symbolMatch ? symbolMatch[1] : 'F&O Contract';

        setActiveTooltip({
          x,
          y,
          action: parsed.action,
          strike: activeStrike || 'Option Strike',
          fullSymbol,
          price: parsed.price,
          pnl: parsed.pnl,
          time: timeStr,
        });
      } else {
        setActiveTooltip(null);
      }
    };

    chartRef.current.subscribeCrosshairMove(handleCrosshairMove);

    return () => {
      chartRef.current?.unsubscribeCrosshairMove(handleCrosshairMove);
    };
  }, [markers, toggles.showMarkers]);

  // Update Data & Layers dynamically
  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current) return;

    // Layer 1: Base Candles (Standard vs Heiken Ashi)
    if (candles && candles.length > 0) {
      const activeCandleData = chartType === 'heikenAshi'
        ? transformToHeikenAshi(candles)
        : candles;

      const formattedCandles: CandlestickData<Time>[] = activeCandleData.map((c) => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      candleSeriesRef.current.setData(formattedCandles);
    } else {
      candleSeriesRef.current.setData([]);
    }

    // Layer 2: EMA
    if (emaSeriesRef.current) {
      if (toggles.showEma && emaSeries.length > 0) {
        const formattedEma: LineData<Time>[] = emaSeries.map((e) => ({
          time: e.time as Time,
          value: e.value,
        }));
        emaSeriesRef.current.setData(formattedEma);
      } else {
        emaSeriesRef.current.setData([]);
      }
    }

    // Layer 3: JMA
    if (jmaSeriesRef.current) {
      if (toggles.showJma && jmaSeries.length > 0) {
        const formattedJma: LineData<Time>[] = jmaSeries.map((j) => ({
          time: j.time as Time,
          value: j.value,
        }));
        jmaSeriesRef.current.setData(formattedJma);
      } else {
        jmaSeriesRef.current.setData([]);
      }
    }

    // Layer 4: Modified HA
    if (mhaSeriesRef.current) {
      if (toggles.showMha && modifiedHaSeries.length > 0) {
        const formattedMha: CandlestickData<Time>[] = modifiedHaSeries.map((m) => ({
          time: m.time as Time,
          open: m.open,
          high: m.high,
          low: m.low,
          close: m.close,
        }));
        mhaSeriesRef.current.setData(formattedMha);
      } else {
        mhaSeriesRef.current.setData([]);
      }
    }

    // Layer 5: Markers (De-cluttered BUY / SELL Badges with Strike & Price)
    if (candleSeriesRef.current) {
      if (toggles.showMarkers && markers && markers.length > 0) {
        let lastSeenStrike = '';
        const formattedMarkers: SeriesMarker<Time>[] = markers.map((m) => {
          const parsed = parseTradeMarker(m.text || '');
          if (parsed.strike) {
            lastSeenStrike = parsed.strike;
          }
          const activeStrike = parsed.strike || lastSeenStrike;
          let badgeText = '';
          const strikeStr = activeStrike ? ` ${activeStrike}` : '';
          if (parsed.action === 'BUY') {
            badgeText = `BUY${strikeStr}\n${parsed.price}`;
          } else {
            const pnlStr = parsed.pnl ? `\n(P/L ${parsed.pnl})` : '';
            badgeText = `SELL${strikeStr}\n${parsed.price}${pnlStr}`;
          }

          return {
            time: m.time as Time,
            position: m.position,
            color: m.color,
            shape: m.shape,
            text: badgeText,
          };
        });
        candleSeriesRef.current.setMarkers(formattedMarkers);
      } else {
        candleSeriesRef.current.setMarkers([]);
      }
    }

    // Layer 6: Horizontal Price Lines (Entry, SL, Target, Trailing SL)
    if (candleSeriesRef.current) {
      // Clean up previous price lines
      priceLinesRef.current.forEach((pl) => {
        try {
          candleSeriesRef.current?.removePriceLine(pl);
        } catch (e) {}
      });
      priceLinesRef.current = [];

      if (toggles.showPriceLines && priceLines && priceLines.length > 0) {
        priceLines.forEach((pl) => {
          if (typeof pl.price === 'number' && !isNaN(pl.price) && pl.price > 0) {
            const line = candleSeriesRef.current?.createPriceLine({
              price: pl.price,
              color: pl.color,
              lineWidth: 1,
              lineStyle: pl.lineStyle !== undefined ? pl.lineStyle : LineStyle.Dashed,
              axisLabelVisible: true,
              title: pl.title,
            });
            if (line) priceLinesRef.current.push(line);
          }
        });
      }
    }

    // Auto-fit chart content when dataset updates
    if (candles && candles.length > 0 && (!liveUpdates || !fittedRef.current)) {
      requestAnimationFrame(() => {
        if (!chartRef.current) return;
        try {
          chartRef.current.priceScale('right').applyOptions({ autoScale: true });
          chartRef.current.timeScale().fitContent();
          fittedRef.current = !liveUpdates || candles.length > 1;
        } catch (e) {}
      });
    }
  }, [candles, emaSeries, jmaSeries, modifiedHaSeries, markers, priceLines, toggles, chartType, liveUpdates]);

  return (
    <div className="w-full h-full relative group">
      <div ref={containerRef} className="w-full h-full min-h-[700px] max-md:min-h-0 rounded-2xl overflow-hidden" />

      {/* Floating Hover Trade Tooltip Overlay */}
      {activeTooltip && (
        <div
          style={{ left: `${activeTooltip.x}px`, top: `${activeTooltip.y}px` }}
          className="mobile-chart-tooltip absolute z-30 pointer-events-none bg-white/95 backdrop-blur-md border border-[#E0E3EB] shadow-xl rounded-lg p-2.5 text-xs text-[#1E222D] min-w-[200px] max-w-[calc(100vw-2rem)] space-y-1.5 transition-all duration-150"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[#E0E3EB] pb-1">
            <span
              className={`font-bold px-1.5 py-0.5 rounded text-[10px] uppercase text-white ${
                activeTooltip.action === 'BUY' ? 'bg-[#10B981]' : 'bg-[#EF4444]'
              }`}
            >
              {activeTooltip.action}
            </span>
            <span className="font-mono font-bold text-[#0052FF]">{activeTooltip.strike}</span>
          </div>

          <div className="space-y-1 text-[11px]">
            <div className="flex justify-between gap-3 text-[#5D606B]">
              <span>Contract:</span>
              <span className="font-mono font-semibold text-[#1E222D]">{activeTooltip.fullSymbol}</span>
            </div>
            <div className="flex justify-between gap-3 text-[#5D606B]">
              <span>Exec Price:</span>
              <span className="font-mono font-semibold text-[#1E222D]">{activeTooltip.price}</span>
            </div>
            {activeTooltip.pnl && (
              <div className="flex justify-between gap-3 text-[#5D606B]">
                <span>PnL:</span>
                <span
                  className={`font-mono font-bold ${
                    activeTooltip.pnl.includes('-') ? 'text-[#EF4444]' : 'text-[#10B981]'
                  }`}
                >
                  {activeTooltip.pnl}
                </span>
              </div>
            )}
            <div className="flex justify-between gap-3 text-[#5D606B]">
              <span>Time (IST):</span>
              <span className="font-medium text-[#1E222D]">{activeTooltip.time}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TradingViewChart;
