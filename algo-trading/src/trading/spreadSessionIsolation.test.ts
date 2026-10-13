import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apiGet, setApiIdentity } from './api'

const assign = vi.fn()
let storage: Map<string, string>
beforeEach(() => {
  storage = new Map([['jwt', 'valid-app-token']])
  vi.stubGlobal('window', { location: { pathname: '/spreads', search: '', hash: '', origin: 'http://localhost:5173', assign } })
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) })
  assign.mockClear()
  setApiIdentity('spread-session-test')
})
afterEach(() => { setApiIdentity(null); vi.unstubAllGlobals() })

it('disconnected Upstox stays on Spreads without refreshing or clearing app login', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Connect Upstox to scan.', upstoxSessionUnavailable: true }), { status: 409 }))
  vi.stubGlobal('fetch', fetch)
  await expect(apiGet('/spreads/underlyings/NIFTY/expiries')).rejects.toThrow('Connect Upstox')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(assign).not.toHaveBeenCalled()
  expect(storage.get('jwt')).toBe('valid-app-token')
})

it('actual expired app authentication still refreshes and redirects when refresh fails', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'App token expired' }), { status: 401 }))
    .mockResolvedValueOnce(new Response('{}', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  await expect(apiGet('/spreads/upstox/status')).rejects.toThrow('Authentication session expired')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(String(fetch.mock.calls[1][0])).toMatch(/\/users\/refresh$/)
  expect(assign).toHaveBeenCalledWith('/login?redirect=%2Fspreads')
})
