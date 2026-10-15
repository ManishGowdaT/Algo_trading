import { describe, expect, it } from 'vitest'
import { displayedCandidates, type ViewRow } from './viewFilters'

const rows: ViewRow[] = [
  { ticker: 'NIFTY', type: 'BULL PUT', earnings: false, short_strike: 100, credit: 2, ror_pct: 20, cushion_pct: 2, vrp: 1.2, p_adj: .1, ev: -1 },
  { ticker: 'BANKNIFTY', type: 'BEAR CALL', earnings: true, short_strike: 200, credit: 3, ror_pct: 30, cushion_pct: 3, vrp: 1.3, p_adj: .2, ev: -2 },
]
describe('original result view behavior', () => {
  it('B6 uses precise displayed credit for filters and explicit sorting', () => {
    const precise = [{ ...rows[0], credit:.01, credit_points_unrounded:.005 }, { ...rows[1], credit:.01, credit_points_unrounded:.009 }]
    expect(displayedCandidates(precise, '', '', '', {credit:{min:'.006'}}, '', 'desc').map(r=>r.candidate.ticker)).toEqual(['BANKNIFTY'])
    expect(displayedCandidates(precise, '', '', '', {}, 'credit', 'desc')[0].candidate.ticker).toBe('BANKNIFTY')
  })
  it('preserves server ranking by default and never mutates results', () => {
    expect(displayedCandidates(rows, '', '', '', {}, '', 'desc').map(r => r.candidate)).toEqual(rows)
    expect(displayedCandidates(rows, '', '', '', {}, 'credit', 'desc')[0].candidate.ticker).toBe('BANKNIFTY')
    expect(displayedCandidates(rows, '', '', '', {}, 'credit', 'asc')[0].candidate.ticker).toBe('NIFTY')
    expect(rows[0].ticker).toBe('NIFTY')
  })
  it('combines inclusive numeric ranges and breach percentages with text/type/earnings', () => {
    const result = displayedCandidates(rows, ' nifty ', 'BULL PUT', 'no', { credit: { min: '2', max: '2' }, p_adj: { min: '10', max: '10' } }, '', 'desc')
    expect(result.map(r => r.candidate.ticker)).toEqual(['NIFTY'])
    expect(displayedCandidates(rows, '', '', '', { p_adj: { min: '11' } }, '', 'desc')[0].candidate.ticker).toBe('BANKNIFTY')
    expect(displayedCandidates(rows, '', '', '', {}, 'ticker', 'asc')[0].candidate.ticker).toBe('BANKNIFTY')
  })
})
