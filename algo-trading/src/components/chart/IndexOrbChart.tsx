import { useEffect, useRef, useState } from 'react'
import { createChart, ColorType, LineStyle, type Time } from 'lightweight-charts'
import { useTheme } from '../../shared/theme/ThemeProvider'
import { orbOverlays, type OrbCandle, type OrbStatus, type IndexUnderlying } from '../../trading/indexVwapOrbUi'

export default function IndexOrbChart({ candles, status, underlying, date, timeframe, showLevels, showVwap, showMarkers }: {
  candles: OrbCandle[]; status: OrbStatus | null; underlying: IndexUnderlying; date: string
  showLevels: boolean; showVwap: boolean; showMarkers: boolean
  timeframe: '1m' | '5m'
}) {
  const container = useRef<HTMLDivElement>(null)
  const { theme } = useTheme()
  const [regions, setRegions] = useState<{ start: number; end: number; cutoff: number | null }>({ start: 0, end: 0, cutoff: null })
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null)
  const dataRef = useRef({ candles, status, underlying, date, timeframe, showLevels, showVwap, showMarkers })
  useEffect(() => { dataRef.current = { candles, status, underlying, date, timeframe, showLevels, showVwap, showMarkers } }, [candles, status, underlying, date, timeframe, showLevels, showVwap, showMarkers])
  const updateRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!container.current) return
    const dark = theme === 'dark'
    const chart = createChart(container.current, { height: 400, width: container.current.clientWidth,
      layout: { background: { type: ColorType.Solid, color: dark ? '#0f172a' : '#ffffff' }, textColor: dark ? '#cbd5e1' : '#53677e' },
      grid: { vertLines: { color: dark ? '#1e293b' : '#f1f5f9' }, horzLines: { color: dark ? '#1e293b' : '#f1f5f9' } },
      localization: { timeFormatter: (time: number) => new Date(time * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) },
      timeScale: { timeVisible: true, secondsVisible: false, tickMarkFormatter: (time: number) => new Date(time * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }) } })
    chartRef.current = chart
    const series = chart.addCandlestickSeries({ upColor: '#089981', downColor: '#ef4444', borderVisible: false, wickUpColor: '#089981', wickDownColor: '#ef4444' })
    const vwap = chart.addLineSeries({ title: 'Session VWAP', color: '#7c3aed', lineWidth: 2 })
    let levelSeries: ReturnType<typeof chart.addLineSeries>[] = []
    let fitted = false
    const place = () => {
      const data = dataRef.current
      const overlay = orbOverlays(data.status, data.underlying, data.date, data.candles, data.timeframe === '1m' ? 60 : 300)
      const x = (time: number) => chart.timeScale().timeToCoordinate(time as Time)
      const last = (data.candles.at(-1)?.time ?? 0) + (data.timeframe === '1m' ? 60 : 300)
      setRegions({ start: x(overlay.open) ?? 0, end: x(Math.min(overlay.rangeEnd, last)) ?? 0, cutoff: x(overlay.cutoff) })
    }
    const update = () => {
      const data = dataRef.current
      const valid = data.candles.filter(c => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite))
      const duration = data.timeframe === '1m' ? 60 : 300
      // This chart's x-axis is candle CLOSE time, so confirmation markers align
      // exactly with the information available at that time, including the last bar.
      series.setData(valid.map(c => ({ ...c, time: (c.time + duration) as Time })))
      const overlay = orbOverlays(data.status, data.underlying, data.date, valid, duration)
      const times = valid.map(c => c.time + duration)
      vwap.setData(data.showVwap ? overlay.vwap.filter(v => times.includes(v.time + 60)).map(v => ({ ...v, time: (v.time + 60) as Time })) : [])
      levelSeries.forEach(s => chart.removeSeries(s)); levelSeries = []
      if (data.showLevels) for (const line of overlay.lines) {
        if (line.to <= line.from) continue
        const s = chart.addLineSeries({ title: line.title, color: line.color, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: true })
        s.setData([{ time: line.from as Time, value: line.price }, { time: line.to as Time, value: line.price }]); levelSeries.push(s)
      }
      series.setMarkers(data.showMarkers ? overlay.markers.map(marker => {
        // Confirmation belongs at its knowledge time. For 5M display use the first
        // visible bar at/after it, never an earlier candle that implies foresight.
        const time = times.find(t => t >= marker.time)
        return time === undefined ? null : { ...marker, time: time as Time }
      }).filter((v): v is NonNullable<typeof v> => v !== null).sort((a, b) => Number(a.time) - Number(b.time)) : [])
      if (!fitted && valid.length) { chart.timeScale().fitContent(); fitted = true }
      place()
    }
    updateRef.current = update
    const observer = new ResizeObserver(() => { chart.applyOptions({ width: container.current?.clientWidth ?? 600 }); place() })
    observer.observe(container.current)
    chart.timeScale().subscribeVisibleTimeRangeChange(place)
    update()
    return () => { observer.disconnect(); updateRef.current = () => {}; chartRef.current = null; chart.remove() }
  }, [theme, underlying, date, timeframe])
  useEffect(() => { updateRef.current() }, [candles, status, showLevels, showVwap, showMarkers, timeframe])
  return <div className="relative overflow-hidden rounded border border-slate-200 dark:border-slate-700">
    <div ref={container} aria-label={`${underlying} regular candle chart`} />
    {showLevels && candles.length > 0 && regions.end > regions.start && <div className="pointer-events-none absolute top-0 bottom-8 bg-blue-500/10 border-r border-blue-400/40" style={{ left: Math.max(0, regions.start), width: Math.max(0, regions.end - Math.max(0, regions.start)) }}><span className="text-[10px] text-blue-600 px-1">Opening range</span></div>}
    {showLevels && regions.cutoff !== null && <div className="pointer-events-none absolute top-0 bottom-8 border-l border-dashed border-amber-500" style={{ left: regions.cutoff }}><span className="text-[10px] text-amber-600 px-1">11:30</span></div>}
    {!candles.length && <div className="absolute inset-0 grid place-items-center pointer-events-none text-sm text-slate-500">Waiting for index candle data</div>}
    <button type="button" className="absolute right-20 top-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-600" onClick={() => chartRef.current?.timeScale().fitContent()}>Fit chart</button>
  </div>
}
