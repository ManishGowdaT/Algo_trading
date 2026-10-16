import { useEffect, useState } from 'react'
import { Eye, EyeOff, X } from 'lucide-react'
import type { AngelCredentials } from './AngelConnectionProvider'

export default function MpinModal({
  open,
  credentialsConfigured,
  recoveryRequired = false,
  onCancel,
  onSubmit,
}: {
  open: boolean
  credentialsConfigured: boolean
  recoveryRequired?: boolean
  onCancel: () => void
  onSubmit: (credentials: AngelCredentials) => Promise<void> | void
}) {
  const [form, setForm] = useState<AngelCredentials>({ apiKey: '', clientCode: '', mpin: '', totpSecret: '', consent: false })
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState('')
  const [editingSetup, setEditingSetup] = useState(false)
  const setupVisible = !credentialsConfigured || editingSetup || recoveryRequired
  const [visibleFields, setVisibleFields] = useState<Record<'apiKey' | 'clientCode' | 'mpin' | 'totpSecret', boolean>>({
    apiKey: false,
    clientCode: false,
    mpin: false,
    totpSecret: false,
  })

  const clearCredentials = () => {
    setForm({ apiKey: '', clientCode: '', mpin: '', totpSecret: '', consent: false })
    setVisibleFields({ apiKey: false, clientCode: false, mpin: false, totpSecret: false })
  }

  const closeModal = () => {
    clearCredentials()
    setError('')
    setEditingSetup(false)
    onCancel()
  }

  useEffect(() => {
    if (!open) setEditingSetup(false)
  }, [open])

  if (!open) return null

  const update = (key: keyof AngelCredentials, value: string | boolean) => {
    setForm((current) => ({ ...current, [key]: value }))
    setError('')
  }

  async function handleSubmit() {
    if (isWorking) return
    if (!form.mpin?.trim()) {
      setError('Enter your Angel One MPIN.')
      return
    }
    if (setupVisible && (!form.apiKey?.trim() || !form.clientCode?.trim() || !form.totpSecret?.trim() || !form.consent
      || (credentialsConfigured && !form.currentPassword?.trim()))) {
      setError(credentialsConfigured ? 'Enter the replacement broker credentials, application password, and consent.' : 'Enter API key, Client ID, TOTP setup secret, and consent to encrypted storage.')
      return
    }

    setIsWorking(true)
    setError('')
    try {
      await onSubmit(form)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Angel One connection failed')
    } finally {
      clearCredentials()
      setIsWorking(false)
    }
  }

  return (
    <div className="mobile-connect-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 max-md:p-2" role="dialog" aria-modal="true" aria-label="Connect to Angel One">
      <div className="mobile-connect-panel w-full max-w-md max-h-[calc(100vh-2rem)] max-md:max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 max-md:p-4 shadow-xl dark:border-white/10 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Connect to Angel One</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{setupVisible ? 'The API key and TOTP setup secret are encrypted before storage. MPIN is used only for this login.' : 'Enter your MPIN to connect using your saved encrypted setup.'}</p>
          </div>
          <button type="button" onClick={closeModal} disabled={isWorking} className="rounded-xl p-1 max-md:shrink-0 max-md:min-h-11 max-md:min-w-11 max-md:flex max-md:items-center max-md:justify-center text-slate-500 hover:bg-slate-100 disabled:opacity-60" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {recoveryRequired && <p role="alert" className="mt-3 text-sm text-amber-700">Saved broker setup cannot be decrypted. Restore the original server encryption key, or replace your setup below using your application password. Existing account and open-position checks still apply.</p>}
        <div className="mt-5 space-y-3">
          {([
            ...(setupVisible ? [['apiKey', 'API Key'], ['clientCode', 'Client ID'], ['totpSecret', 'TOTP authenticator setup secret']] as const : []),
            ['mpin', 'Angel One MPIN'],
          ] as const).map(([key, label]) => (
            <label key={key} className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              {label}
              <div className="relative mt-1">
                <input
                  type={visibleFields[key] ? 'text' : 'password'}
                  autoComplete="off"
                  value={String(form[key] ?? '')}
                  onChange={(event) => update(key, event.target.value)}
                  disabled={isWorking}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 pr-11 max-md:pr-12 text-sm text-slate-900 outline-none focus:ring-4 focus:ring-cyan-200 dark:border-white/10 dark:bg-white/5 dark:text-slate-50"
                />
                <button
                  type="button"
                  onClick={() => setVisibleFields((current) => ({ ...current, [key]: !current[key] }))}
                  disabled={isWorking}
                  className="absolute right-1 top-1/2 flex h-9 w-9 max-md:h-11 max-md:w-11 -translate-y-1/2 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-60 dark:hover:bg-white/10"
                  aria-label={visibleFields[key] ? `Hide ${label}` : `Show ${label}`}
                >
                  {visibleFields[key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>
          ))}
          {setupVisible && credentialsConfigured && <label className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Application password for reauthentication
            <input type="password" autoComplete="current-password" value={form.currentPassword || ''} disabled={isWorking} onChange={(event) => update('currentPassword', event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 dark:border-white/10 dark:bg-white/5 dark:text-slate-50" />
          </label>}
          {setupVisible && <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={Boolean(form.consent)} disabled={isWorking} onChange={(event) => update('consent', event.target.checked)} className="mt-0.5" />
            <span>I consent to storing my API key and TOTP authenticator setup secret encrypted so I only need my MPIN to reconnect.</span>
          </label>}
        </div>

        {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}

        <div className="mt-6 flex justify-end gap-2 max-md:[&>button]:flex-1">
          {credentialsConfigured && !editingSetup && <button type="button" onClick={() => setEditingSetup(true)} disabled={isWorking} className="mr-auto rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold hover:bg-slate-100 disabled:opacity-70">Replace saved setup</button>}
          <button type="button" onClick={closeModal} disabled={isWorking} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold hover:bg-slate-100 disabled:opacity-70">Cancel</button>
          <button type="button" onClick={() => void handleSubmit()} disabled={isWorking} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-70">{isWorking ? 'Connecting…' : 'Connect'}</button>
        </div>
      </div>
    </div>
  )
}
