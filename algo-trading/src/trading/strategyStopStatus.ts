export interface StrategyStopStatus {
  state: string
  message?: string
  activeTradeId?: string | null
  pendingEntryQuantity?: number | null
}

// Stop acknowledges scanner shutdown. The server remains the authority for
// open/pending exposure, including fills that arrive while Stop is in flight.
export function retainedStopStatus(status?: StrategyStopStatus): StrategyStopStatus | null {
  if (!status) return null
  return status.activeTradeId || Number(status.pendingEntryQuantity) > 0
    || ['EXIT_PENDING', 'RECONCILIATION_REQUIRED'].includes(status.state) ? status : null
}
