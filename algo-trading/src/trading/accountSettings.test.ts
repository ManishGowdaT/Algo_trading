import { afterEach, describe, expect, it } from 'vitest'
import { readAccountSetting, writeAccountSetting } from './accountSettings'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, String(value)),
  removeItem: (key: string) => memory.delete(key),
  clear: () => memory.clear(),
} })

afterEach(() => memory.clear())

describe('account settings browser storage', () => {
  it('keeps each user and broker account configuration separate in one browser profile', () => {
    writeAccountSetting('user-a', 'account-a', 'liveTradingConsent', true)
    writeAccountSetting('user-b', 'account-b', 'liveTradingConsent', false)

    expect(readAccountSetting('user-a', 'account-a', 'liveTradingConsent', false)).toBe(true)
    expect(readAccountSetting('user-b', 'account-b', 'liveTradingConsent', false)).toBe(false)
    expect(readAccountSetting('user-b', 'account-a', 'liveTradingConsent', false)).toBe(false)
  })

  it('does not read legacy unscoped strategy keys', () => {
    localStorage.setItem('ha_liveTradingConsent', 'true')
    expect(readAccountSetting('user-b', 'account-b', 'ha_liveTradingConsent', false)).toBe(false)
  })

  it('persists a user account setting across a simulated refresh', () => {
    writeAccountSetting('user-a', 'account-a', 'underlying', 'NIFTY')
    expect(readAccountSetting('user-a', 'account-a', 'underlying', 'SENSEX')).toBe('NIFTY')
  })
})
