import { describe, expect, it } from 'vitest'

import { buildTradesUrl, validateTradesTimeRange } from './tradesQuery'

describe('buildTradesUrl', () => {
  it('builds base url with page/limit', () => {
    expect(buildTradesUrl({ page: 1, limit: 10, filters: {} })).toBe('/trades?page=1&limit=10')
  })

  it('includes all filters and url-encodes values', () => {
    expect(
      buildTradesUrl({
        page: 2,
        limit: 10,
        filters: {
          searchQuery: 'NIFTY 50',
          exitReasonFilter: 'HA_TREND_REVERSAL',
          startDate: '2026-03-01',
          endDate: '2026-03-04',
          timeFrom: '09:15',
          timeTo: '15:30'
        }
      })
    ).toBe(
      '/trades?page=2&limit=10' +
        '&searchQuery=NIFTY%2050' +
        '&exitReason=HA_TREND_REVERSAL' +
        '&startDate=2026-03-01' +
        '&endDate=2026-03-04' +
        '&timeFrom=09%3A15' +
        '&timeTo=15%3A30'
    )
  })

  it('omits empty string filters', () => {
    expect(
      buildTradesUrl({
        page: 1,
        limit: 10,
        filters: {
          searchQuery: '',
          exitReasonFilter: '',
          startDate: '',
          endDate: '',
          timeFrom: '',
          timeTo: ''
        }
      })
    ).toBe('/trades?page=1&limit=10')
  })

  it('accepts an inclusive same-day time range', () => {
    expect(validateTradesTimeRange('10:30', '15:30')).toBeNull()
  })

  it('rejects a reversed time range and explains 24-hour input', () => {
    expect(validateTradesTimeRange('10:30', '03:30')).toContain('Use 15:30 for 3:30 PM')
  })

  it('allows a single time boundary', () => {
    expect(validateTradesTimeRange('10:30', '')).toBeNull()
  })
})
