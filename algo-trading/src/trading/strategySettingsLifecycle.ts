export type StrategySettingsConfig = Record<string, unknown>

/** A save queue belongs to one keyed user/account page instance. Disposing it
 * prevents callbacks queued by that instance from running under a later API identity. */
export class AccountSettingsSaveQueue {
  private active = true
  private generation = 0
  private pending: Promise<unknown> = Promise.resolve()
  private readonly scope: string

  constructor(scope: string) { this.scope = scope }

  enqueue(
    config: StrategySettingsConfig,
    save: (scope: string, config: StrategySettingsConfig) => Promise<unknown>,
    isScopeCurrent: (scope: string) => boolean = () => true,
  ): void {
    const scope = this.scope
    const generation = this.generation
    const snapshot = structuredClone(config)
    this.pending = this.pending.catch(() => undefined).then(() => {
      if (!this.active || generation !== this.generation || !isScopeCurrent(scope)) return undefined
      return save(scope, snapshot)
    }).catch(() => undefined)
  }

  activate(): void { this.active = true }
  dispose(): void { this.active = false; this.generation += 1 }
}

const enums: Record<string, readonly string[]> = {
  underlying: ['SENSEX', 'NIFTY', 'BANKNIFTY', 'CRUDEOILM'],
  exchange: ['BSE', 'BFO', 'NFO', 'MCX'],
  baseTimeframe: ['ONE_MINUTE', 'THREE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'THIRTY_MINUTE'],
  confirmationTimeframe: ['ONE_MINUTE', 'THREE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'THIRTY_MINUTE'],
  strikeMode: ['ATM', 'ITM', 'OTM'],
  exitStrategy: ['CANDLES', 'TARGET', 'TRAILING_SL'],
}
const fields: Record<string, readonly string[]> = {
  HeikenAshi: ['underlying', 'quantity', 'baseTimeframe', 'needConfirmation', 'confirmationTimeframe', 'strikeMode', 'strikeDepth', 'premiumMin', 'premiumMax', 'exitStrategy', 'targetPoints', 'slPoints', 'emaPeriod', 'jmaLength', 'liveTradingConsent'],
  ModifiedHeikenAshi: ['underlying', 'quantity', 'baseTimeframe', 'needConfirmation', 'confirmationTimeframe', 'strikeMode', 'strikeDepth', 'premiumMin', 'premiumMax', 'exitStrategy', 'targetPoints', 'slPoints', 'initialSlPoints', 'trailingStopPoints', 'finalTargetPoints', 'emaPeriod', 'jmaLength', 'liveTradingConsent'],
  '5minBreakout': ['underlying', 'exchange', 'quantity', 'lookback', 'targetPoints', 'bufferPoints', 'maxRangeLimit', 'strikeMode', 'strikeDepth', 'premiumMin', 'premiumMax', 'liveTradingConsent'],
}

export function isValidStrategySettings(config: unknown, strategyName?: string): config is StrategySettingsConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false
  const values = config as Record<string, unknown>
  if (strategyName && (!fields[strategyName] || Object.keys(values).some(key => !fields[strategyName].includes(key)))) return false
  for (const [key, options] of Object.entries(enums)) {
    if (values[key] !== undefined) {
      const strategyOptions = key === 'underlying' && strategyName === '5minBreakout'
        ? ['SENSEX', 'NIFTY', 'BANKNIFTY']
        : key === 'exchange' && strategyName === '5minBreakout'
          ? ['BSE', 'NFO']
          : key === 'exitStrategy' && strategyName !== 'ModifiedHeikenAshi'
            ? ['CANDLES', 'TARGET']
            : options
      if (typeof values[key] !== 'string' || !strategyOptions.includes(values[key] as string)) return false
    }
  }
  for (const key of ['needConfirmation', 'liveTradingConsent']) {
    if (values[key] !== undefined && typeof values[key] !== 'boolean') return false
  }
  for (const key of ['quantity', 'strikeDepth', 'premiumMin', 'premiumMax', 'targetPoints', 'slPoints', 'initialSlPoints', 'trailingStopPoints', 'finalTargetPoints', 'bufferPoints', 'maxRangeLimit', 'lookback', 'emaPeriod', 'jmaLength']) {
    const value = values[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000)) return false
  }
  if (values.quantity !== undefined && (!Number.isInteger(values.quantity) || Number(values.quantity) < 1)) return false
  if (values.strikeDepth !== undefined && (!Number.isInteger(values.strikeDepth) || Number(values.strikeDepth) < 1)) return false
  if (values.lookback !== undefined && ![4, 5].includes(Number(values.lookback))) return false
  if (values.emaPeriod !== undefined && (!Number.isInteger(values.emaPeriod) || Number(values.emaPeriod) < 2 || Number(values.emaPeriod) > 200)) return false
  if (values.jmaLength !== undefined && (!Number.isInteger(values.jmaLength) || Number(values.jmaLength) < 2 || Number(values.jmaLength) > 100)) return false
  if (typeof values.premiumMin === 'number' && typeof values.premiumMax === 'number' && values.premiumMin > values.premiumMax) return false
  return true
}

export async function loadValidatedStrategySettings(
  strategyName: string,
  load: () => Promise<{ data?: { config?: StrategySettingsConfig | null } }>,
): Promise<StrategySettingsConfig> {
  const response = await load();
  const config = response?.data?.config ?? {};
  if (!isValidStrategySettings(config, strategyName)) throw new Error('Saved strategy settings are invalid.');
  return config;
}

export function canStartStrategy(settingsReady: boolean, settingsValid: boolean, connected: boolean): boolean {
  return settingsReady && settingsValid && connected
}
