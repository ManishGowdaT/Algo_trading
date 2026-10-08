import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiGet, apiPost, apiStream, setApiAccountScope, setApiIdentity } from './api'

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
  it('streams split SSE frames using bearer headers and the selected account; releases the stream on completion', async () => {
    setApiIdentity('stream-user')
    setApiAccountScope('account-a')
    memory.set('jwt', 'test-token')
    const encoder = new TextEncoder()
    let cancelled = false
    const chunks = ['data: {"ltp":', '100}\n\ndata: {"ltp":101}\n\n']
    let i = 0
    const reader = { read: async () => i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true }, cancel: async () => { cancelled = true } }
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain('brokerAccountId=account-a')
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
      return { ok: true, status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader: () => reader } } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    const frames: unknown[] = []
    await apiStream('/instruments/live?exchange=NSE&symboltoken=2885', new AbortController().signal, data => frames.push(data))
    expect(frames).toEqual([{ ltp: 100 }, { ltp: 101 }])
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('test-token')
    expect(cancelled).toBe(true)
  })

  it('never delivers an old stream frame after account selection changes', async () => {
    setApiIdentity('stream-user')
    setApiAccountScope('account-a')
    let deliver!: (value: { done: boolean; value: Uint8Array }) => void
    let opened!: () => void
    const reading = new Promise<void>(resolve => { opened = resolve })
    const reader = { read: () => { opened(); return new Promise(resolve => { deliver = resolve }) }, cancel: async () => {} }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader: () => reader } }) as unknown as Response))
    const listener = vi.fn()
    const pending = apiStream('/instruments/live', new AbortController().signal, listener)
    await reading
    setApiAccountScope('account-b')
    deliver({ done: false, value: new TextEncoder().encode('data: {"ltp":100}\n\n') })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('cancels caller-aborted search requests and includes their broker account', async () => {
    setApiIdentity('stream-user')
    setApiAccountScope('account-a')
    let signal: AbortSignal | null | undefined
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      signal = options?.signal
      return new Promise<Response>(resolve => { finish = resolve })
    }))
    const controller = new AbortController()
    const pending = apiGet('/instruments/search?query=NIFTY', controller.signal)
    controller.abort()
    expect(signal?.aborted).toBe(true)
    setApiIdentity('changed-user')
    finish({ ok: true, status: 200, text: async () => '{"items":[]}' } as Response)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('adds the selected broker account to strategy and paginated trade requests', async () => {
    setApiIdentity('user-a')
    setApiAccountScope('account-a')
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('/trades?')
      return ({ ok: true, status: 200, text: async () => '{"ok":true}' }) as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    await apiGet('/trades?page=2&limit=10')
    expect(String(fetchMock.mock.calls[0][0])).toContain('brokerAccountId=account-a')
  })

  it('keeps the legacy strategy start payload intact while selecting its account in the URL', async () => {
    setApiIdentity('user-a')
    setApiAccountScope('account-a')
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain('/strategies/HeikenAshi/start')
      expect(init?.method).toBe('POST')
      return ({ ok: true, status: 200, text: async () => '{"status":"success"}' }) as unknown as Response
    })
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
