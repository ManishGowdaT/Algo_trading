export type ViewRow = { ticker: string; type: string; earnings: boolean; short_strike: number; credit: number; credit_points_unrounded?: number; ror_pct: number; cushion_pct: number; vrp: number; p_adj: number; ev: number }
export function preciseCredit(row: ViewRow): number { return Number((row.credit_points_unrounded ?? row.credit).toFixed(6)) }
export const numericColumns = ['short_strike', 'credit', 'ror_pct', 'cushion_pct', 'vrp', 'p_adj', 'ev'] as const
export type NumericColumn = typeof numericColumns[number]
export type Ranges = Partial<Record<NumericColumn, { min?: string; max?: string }>>
export function displayedCandidates<T extends ViewRow>(rows: T[], search: string, strategy: string, earnings: string, ranges: Ranges, sortKey: keyof ViewRow | '', direction: 'asc' | 'desc') {
  const filtered = rows.filter(row => row.ticker.toLowerCase().includes(search.trim().toLowerCase())
    && (!strategy || row.type === strategy)
    && (!earnings || row.earnings === (earnings === 'yes'))
    && numericColumns.every(key => {
      const value = (key === 'credit' ? preciseCredit(row) : row[key]) * (key === 'p_adj' ? 100 : 1)
      const range = ranges[key]
      return (!range?.min?.trim() || value >= Number(range.min)) && (!range?.max?.trim() || value <= Number(range.max))
    }))
  if (sortKey) filtered.sort((a, b) => {
    const left = sortKey === 'credit' ? preciseCredit(a) : a[sortKey], right = sortKey === 'credit' ? preciseCredit(b) : b[sortKey]
    const compared = typeof left === 'string' ? left.localeCompare(String(right)) : Number(left) - Number(right)
    return compared * (direction === 'asc' ? 1 : -1)
  })
  return filtered.map(candidate => ({ candidate }))
}
