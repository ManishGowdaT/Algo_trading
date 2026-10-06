import { describe, expect, it } from 'vitest'
import { retainedStopStatus } from './strategyStopStatus'

describe('Phase 5 Stop display compatibility', () => {
  it.each(['POSITION_PROTECTED', 'POSITION_UNPROTECTED', 'IN_POSITION', 'EXIT_PENDING'])('retains held %s state for desktop and mobile controls', state => {
    const status = { state, activeTradeId: 'owned-trade' }
    expect(retainedStopStatus(status)).toBe(status)
  })
  it('retains an unresolved BUY without a trade ID', () => {
    const status = { state: 'RECONCILIATION_REQUIRED', pendingEntryQuantity: 10 }
    expect(retainedStopStatus(status)).toBe(status)
  })
  it('uses the server result when a fill arrives during Stop', () => {
    const status = { state: 'POSITION_PROTECTED', activeTradeId: 'late-fill', message: 'New entries stopped; position managed.' }
    expect(retainedStopStatus(status)?.activeTradeId).toBe('late-fill')
  })
  it('keeps ordinary Stop clearing unchanged when no exposure exists', () => {
    expect(retainedStopStatus({ state: 'STOPPED', activeTradeId: null, pendingEntryQuantity: 0 })).toBeNull()
    expect(retainedStopStatus()).toBeNull()
  })
})
