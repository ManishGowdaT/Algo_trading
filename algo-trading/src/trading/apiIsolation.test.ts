import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiGet, apiPost, setApiAccountScope, setApiIdentity } from './api'

const memory = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, String(value)),
  removeItem: (key: string) => memory.delete(key),
  clear: () => memory.clear(),
} })
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  location: { origin: 'http://localhost', pathname: '/', search: '', hash: '', assign: vi.fn() },
} })

afterEach(() => {
  vi.restoreAllMocks()
  setApiIdentity(null)
  memory.clear()
})

describe('verified frontend API identity', () => {
  it('adds the selected broker account to strategy and paginated trade requests', async () => {
    setApiIdentity('user-a')
    setApiAccountScope('account-a')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => '{"ok":true}' }) as Response)
    vi.stubGlobal('fetch', fetchMock)

    await apiGet('/trades?page=2&limit=10')
    expect(String(fetchMock.mock.calls[0][0])).toContain('brokerAccountId=account-a')
  })

  it('keeps the legacy strategy start payload intact while selecting its account in the URL', async () => {
    setApiIdentity('user-a')
    setApiAccountScope('account-a')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, status: 200, text: async () => '{"status":"success"}',
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    const config = { underlying: 'NIFTY', quantity: 65, liveTradingConsent: false }

    await apiPost('/strategies/HeikenAshi/start', config)
    expect(String(fetchMock.mock.calls[0][0])).toContain('brokerAccountId=account-a')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual(config)
  })

  it('rejects a late response after the signed-in user changes', async () => {
    setApiIdentity('user-a')
    setApiAccountScope('account-a')
    let finish!: (response: Response) => void
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, options?: RequestInit) => {
      requestSignal = options?.signal ?? undefined
      return new Promise<Response>((resolve) => { finish = resolve })
    }))

    const pending = apiGet('/angel/status')
    setApiIdentity('user-b')
    expect(requestSignal?.aborted).toBe(true)
    finish({ ok: true, status: 200, text: async () => '{"connected":true}' } as Response)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an old settings response after the selected broker account changes', async () => {
    setApiIdentity('user-a')
    setApiAccountScope('account-a')
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const pending = apiGet('/strategies/settings/HeikenAshi')
    setApiAccountScope('account-b')
    finish({ ok: true, status: 200, text: async () => '{"data":{"config":{"liveTradingConsent":true}}}' } as Response)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
