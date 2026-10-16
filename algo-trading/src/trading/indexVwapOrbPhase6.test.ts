import { describe, expect, it } from 'vitest'
import traces from './fixtures/indexOrbPhase6Trace'
import { orbOverlays, type IndexUnderlying, type OrbStatus } from './indexVwapOrbUi'

describe('Phase 6 overlays match production analyzer sequential decision traces', () => {
  for (const trace of traces) it(`${trace.underlying} ${trace.direction} at ${trace.count} closed bars`, () => {
    const underlying = trace.underlying as IndexUnderlying
    const status = trace.status as OrbStatus
    const overlay = orbOverlays(status, underlying, trace.date, trace.candles)
    const analysis = status.analysis!
    const d = analysis.diagnostics!
    expect(overlay.lines.find(l => l.title === 'OR High')?.price).toBe(d.orHigh)
    expect(overlay.lines.find(l => l.title === 'OR Low')?.price).toBe(d.orLow)
    expect(overlay.lines.filter(l => l.title.startsWith('OR')).every(l => l.from === Date.parse(`${trace.date}T09:30:00+05:30`) / 1000)).toBe(true)
    expect(overlay.vwap.at(-1)?.value).toBe(d.vwap)
    const candidate = d.latestCandidate
    expect(overlay.lines.filter(l => l.title.startsWith('Signal')).length).toBe(candidate ? 3 : 0)
    if (candidate) {
      expect(analysis.isEntry).toBe(true)
      expect(overlay.lines.find(l => l.title.includes('index sl'))?.price).toBe(candidate.stopLoss)
      expect(overlay.lines.find(l => l.title.includes('index target'))?.price).toBe(candidate.takeProfit)
      expect(overlay.lines.filter(l => l.title.startsWith('Signal')).every(l => l.from === candidate.signalClosedAt! / 1000)).toBe(true)
      expect(overlay.markers.find(m => m.text.startsWith('Entry signal'))?.time).toBe(candidate.signalClosedAt! / 1000)
    }
    const pivot = d.setup?.pivot ?? candidate?.pivot
    expect(overlay.markers.find(m => m.text.startsWith('Pivot confirmed'))?.time).toBe(pivot ? pivot.confirmedAt / 1000 : undefined)
    expect(overlay.markers.find(m => m.text.startsWith('Pivot formed'))?.time).toBe(pivot ? pivot.formedAt / 1000 : undefined)
    expect(overlay.markers.every(m => m.time <= trace.candles.at(-1)!.time + 60)).toBe(true)
    expect(orbOverlays(status, underlying === 'NIFTY' ? 'SENSEX' : 'NIFTY',trace.date,trace.candles).lines).toEqual([])
    expect(orbOverlays(status, underlying,'2026-10-15',trace.candles).markers).toEqual([])
  })
})
