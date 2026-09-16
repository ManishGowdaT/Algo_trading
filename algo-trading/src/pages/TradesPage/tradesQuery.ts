export type TradesFilters = {
  searchQuery?: string
  exitReasonFilter?: string
  strategyIdFilter?: string
  startDate?: string
  endDate?: string
  timeFrom?: string
  timeTo?: string
}

export function validateTradesTimeRange(timeFrom?: string, timeTo?: string): string | null {
  if (!timeFrom || !timeTo) return null

  const from = timeFrom.split(':').map(Number)
  const to = timeTo.split(':').map(Number)
  if (from.length !== 2 || to.length !== 2 || from.some(Number.isNaN) || to.some(Number.isNaN)) {
    return 'Please enter a valid time range.'
  }

  const fromMinutes = from[0] * 60 + from[1]
  const toMinutes = to[0] * 60 + to[1]
  if (fromMinutes > toMinutes) {
    return 'Start time must be earlier than or equal to end time. Use 15:30 for 3:30 PM.'
  }

  return null
}

export function buildTradesUrl(params: {
  page: number
  limit: number
  filters: TradesFilters
}): string {
  const { page, limit, filters } = params

  let url = `/trades?page=${page}&limit=${limit}`

  if (filters.searchQuery) url += `&searchQuery=${encodeURIComponent(filters.searchQuery)}`
  if (filters.exitReasonFilter) url += `&exitReason=${encodeURIComponent(filters.exitReasonFilter)}`
  if (filters.strategyIdFilter) url += `&strategyId=${encodeURIComponent(filters.strategyIdFilter)}`
  if (filters.startDate) url += `&startDate=${filters.startDate}`
  if (filters.endDate) url += `&endDate=${filters.endDate}`
  if (filters.timeFrom) url += `&timeFrom=${encodeURIComponent(filters.timeFrom)}`
  if (filters.timeTo) url += `&timeTo=${encodeURIComponent(filters.timeTo)}`

  return url
}
