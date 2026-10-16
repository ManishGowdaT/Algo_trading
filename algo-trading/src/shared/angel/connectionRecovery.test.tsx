import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'

const h = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => unknown)[] }))
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = h.cursor++
    if (!(i in h.values)) h.values[i] = initial
    return [h.values[i], (v: unknown) => { h.values[i] = typeof v === 'function' ? v(h.values[i]) : v }]
  },
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.values)) h.values[i] = { current: initial }; return h.values[i] },
  useEffect: (effect: () => unknown) => { h.effects.push(effect) },
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
}))
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { _id: 'owner' } }) }))
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/dashboard' }), useNavigate: () => vi.fn() }))
vi.mock('../../trading', () => ({ apiGet: api.get, apiPost: api.post }))
vi.mock('../../trading/api', () => ({ setApiAccountScope: vi.fn() }))
import { AngelConnectionProvider } from './AngelConnectionProvider'
import MpinModal from './MpinModal'

type El = ReactElement<Record<string, unknown>>
function nodes(node: ReactNode): El[] {
  if (Array.isArray(node)) return node.flatMap(nodes)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const el = node as El
  return [el, ...nodes(el.props.children as ReactNode)]
}
function render() { h.cursor = 0; h.effects = []; return AngelConnectionProvider({ children: null }) }
beforeEach(() => { h.values = []; h.cursor = 0; h.effects = []; api.get.mockReset(); api.post.mockReset() })

it.each([false, true])('opens the normal connection form when configured=%s', async configured => {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: vi.fn() })
  api.get.mockImplementation(async (path: string) => path === '/system/health' ? { ready: true } : path === '/angel/status' ? { connected: false } : { configured })
  render(); [...h.effects].forEach(effect => effect())
  await new Promise(resolve => setTimeout(resolve, 0))
  let root = render()
  await root.props.value.openConnect()
  root = render()
  const modal = nodes(root).find(n => n.type === MpinModal)!
  expect(modal.props.credentialsConfigured).toBe(configured)
  expect(modal.props.recoveryRequired).toBe(false)
  expect(api.post).not.toHaveBeenCalled()
  vi.unstubAllGlobals()
})

it('click shows a visible problem dialog while Python is unavailable', async () => {
  let root = render()
  await root.props.value.openConnect()
  root = render()
  expect(nodes(root).some(n => n.props['aria-label'] === 'Angel One connection unavailable')).toBe(true)
  expect(api.get).not.toHaveBeenCalled()
})

it('unreadable saved credentials open replacement fields with broker verification', async () => {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: vi.fn() })
  api.get.mockImplementation(async (path: string) => path === '/system/health' ? { ready: true } : path === '/angel/status' ? { connected: false } : { configured: true, recoveryRequired: true })
  render()
  const effects = [...h.effects]
  effects.forEach(effect => effect())
  await new Promise(resolve => setTimeout(resolve, 0))
  let root = render()
  await root.props.value.openConnect()
  root = render()
  const modal = nodes(root).find(n => n.type === MpinModal)!
  expect(modal.props.credentialsConfigured).toBe(true)
  expect(modal.props.recoveryRequired).toBe(true)
  h.cursor = 100
  const view = MpinModal(modal.props as Parameters<typeof MpinModal>[0])
  const text = JSON.stringify(view)
  expect(text).not.toContain('Application password for reauthentication')
  expect(text).toContain('verified before the replacement is saved')
  expect(text).toContain('TOTP authenticator setup secret')
  expect(text).toContain('cannot be decrypted')
  api.post.mockResolvedValue({ status: true, connected: true, brokerAccountId: 'account' })
  await (modal.props.onSubmit as (credentials: unknown) => Promise<void>)({ apiKey: 'test-api-key', clientCode: 'CLIENT-A', totpSecret: 'TESTSECRET', mpin: '0123', consent: true })
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/angel/login', {
    apiKey: 'test-api-key', clientCode: 'CLIENT-A', totpSecret: 'TESTSECRET', mpin: '0123', consent: true, persistCredentials: true,
  })
  vi.unstubAllGlobals()
})

it('credential-status transport failure opens retry dialog and never treats unknown setup as absent', async () => {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: vi.fn() })
  api.get.mockImplementation(async (path: string) => {
    if (path === '/system/health') return { ready: true }
    if (path === '/angel/status') return { connected: false }
    throw new Error('Unavailable')
  })
  render(); [...h.effects].forEach(effect => effect())
  await new Promise(resolve => setTimeout(resolve, 0))
  let root = render()
  await root.props.value.openConnect()
  root = render()
  expect(nodes(root).some(n => n.props['aria-label'] === 'Angel One connection unavailable')).toBe(true)
  expect(nodes(root).some(n => n.type === MpinModal)).toBe(false)
  expect(api.post).not.toHaveBeenCalled()
  api.get.mockResolvedValue({ configured: false })
  await root.props.value.openConnect()
  root = render()
  expect(nodes(root).some(n => n.props['aria-label'] === 'Angel One connection unavailable')).toBe(false)
  const modal = nodes(root).find(n => n.type === MpinModal)!
  expect(modal.props.credentialsConfigured).toBe(false)
  expect(modal.props.recoveryRequired).toBe(false)
  vi.unstubAllGlobals()
})
