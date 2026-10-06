import { describe, expect, it } from 'vitest'
import { AccountSettingsSaveQueue, canStartStrategy, loadValidatedStrategySettings } from './strategySettingsLifecycle'
import { AuthSessionMutationQueue, clearTokenForCurrentSession } from './authSessionLifecycle'
import { isApiScopeCurrent, setApiAccountScope, setApiIdentity } from './api'

describe('Phase 7 frontend lifecycle', () => {
  it('does not run queued User A settings saves after an A to B scope switch', async () => {
    const writes: Array<{ scope: string; consent: unknown }> = []
    let finishFirst!: () => void
    const a = new AccountSettingsSaveQueue('user-a:account-a')
    setApiIdentity('user-a'); setApiAccountScope('account-a')
    a.enqueue({ liveTradingConsent: true }, async (scope, config) => {
      await new Promise<void>(resolve => { finishFirst = resolve })
      writes.push({ scope, consent: config.liveTradingConsent })
    }, isApiScopeCurrent)
    await new Promise(resolve => setTimeout(resolve, 0))
    a.enqueue({ liveTradingConsent: true, quantity: 99 }, async (scope, config) => {
      writes.push({ scope, consent: config.liveTradingConsent })
    }, isApiScopeCurrent)
    a.dispose()

    setApiIdentity('user-b'); setApiAccountScope('account-b')
    const b = new AccountSettingsSaveQueue('user-b:account-b')
    b.enqueue({ liveTradingConsent: false, quantity: 10 }, async (scope, config) => {
      writes.push({ scope, consent: config.liveTradingConsent })
    }, isApiScopeCurrent)
    finishFirst()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(writes).toEqual([
      { scope: 'user-a:account-a', consent: true },
      { scope: 'user-b:account-b', consent: false },
    ])
    setApiIdentity(null)
  })

  it('rejects a queued old-scope save before unmount cleanup runs', async () => {
    const writes: string[] = []
    let release!: () => void
    setApiIdentity('user-a'); setApiAccountScope('account-a')
    const queue = new AccountSettingsSaveQueue('user-a:account-a')
    queue.enqueue({}, async () => new Promise<void>(resolve => { release = resolve }), isApiScopeCurrent)
    await new Promise(resolve => setTimeout(resolve, 0))
    queue.enqueue({ liveTradingConsent: true }, async scope => { writes.push(scope) }, isApiScopeCurrent)
    setApiIdentity('user-b')
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(writes).toEqual([])
    setApiIdentity(null)
  })

  it('keeps settings unready after a failed GET and rejects invalid saved configuration', async () => {
    let ready = false
    await expect(loadValidatedStrategySettings('HeikenAshi', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(ready).toBe(false)
    await expect(loadValidatedStrategySettings('HeikenAshi', async () => ({ data: { config: { quantity: -3 } } }))).rejects.toThrow('invalid')
    expect(ready).toBe(false)
    const empty = await loadValidatedStrategySettings('HeikenAshi', async () => ({ data: { config: null } }))
    expect(empty).toEqual({})
    ready = true
    expect(ready).toBe(true)
  })

  it('blocks Start while settings are hydrating or invalid', () => {
    expect(canStartStrategy(false, false, true)).toBe(false)
    expect(canStartStrategy(true, false, true)).toBe(false)
    expect(canStartStrategy(true, true, false)).toBe(false)
    expect(canStartStrategy(true, true, true)).toBe(true)
  })

  it('serializes overlapping logout and login and guards stale token cleanup', async () => {
    const queue = new AuthSessionMutationQueue()
    let finishLogout!: () => void
    const events: string[] = []
    let generation = 1
    const logout = queue.run(async () => {
      events.push('logout-request')
      await new Promise<void>(resolve => { finishLogout = resolve })
      clearTokenForCurrentSession(1, generation, () => events.push('remove-token'))
    })
    generation = 2
    const login = queue.run(async () => { events.push('login-B-request'); events.push('store-B-token') })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toEqual(['logout-request'])
    finishLogout()
    await Promise.all([logout, login])
    expect(events).toEqual(['logout-request', 'login-B-request', 'store-B-token'])
  })
})
