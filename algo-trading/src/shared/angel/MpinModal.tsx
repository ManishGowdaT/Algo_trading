import { useState } from 'react'
import { X } from 'lucide-react'
import type { AngelCredentials } from './AngelConnectionProvider'

export default function MpinModal({
  open,
  onCancel,
  onSubmit,
}: {
  open: boolean
  onCancel: () => void
  onSubmit: (credentials: AngelCredentials) => Promise<void> | void
}) {
  const [form, setForm] = useState<AngelCredentials>({ apiKey: '', clientCode: '', mpin: '', totpSecret: '' })
  const [isWorking, setIsWorking] = useState(false)
  const [error, setError] = useState('')

  const clearCredentials = () => {
    setForm({ apiKey: '', clientCode: '', mpin: '', totpSecret: '' })
  }

  const closeModal = () => {
    clearCredentials()
    setError('')
    onCancel()
  }

  if (!open) return null

  const update = (key: keyof AngelCredentials, value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
    setError('')
  }

  async function handleSubmit() {
    if (isWorking) return
    if (Object.values(form).some((value) => !value.trim())) {
      setError('Enter API key, Client ID, MPIN, and TOTP secret.')
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 max-md:p-2" role="dialog" aria-modal="true" aria-label="Connect to Angel One">
      <div className="w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 max-md:p-4 shadow-xl dark:border-white/10 dark:bg-slate-900">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Connect to Angel One</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Credentials are used for this connection only.</p>
          </div>
          <button type="button" onClick={closeModal} disabled={isWorking} className="rounded-xl p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-60" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-5 space-y-3">
          {([
            ['apiKey', 'API Key'],
            ['clientCode', 'Client ID'],
            ['mpin', 'MPIN'],
            ['totpSecret', 'TOTP Code or Secret'],
          ] as const).map(([key, label]) => (
            <label key={key} className="block text-sm font-medium text-slate-700 dark:text-slate-200">
              {label}
              <input
                type="password"
                autoComplete="off"
                value={form[key]}
                onChange={(event) => update(key, event.target.value)}
                disabled={isWorking}
                className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-4 focus:ring-cyan-200 dark:border-white/10 dark:bg-white/5 dark:text-slate-50"
              />
            </label>
          ))}
        </div>

        {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={closeModal} disabled={isWorking} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold hover:bg-slate-100 disabled:opacity-70">Cancel</button>
          <button type="button" onClick={() => void handleSubmit()} disabled={isWorking} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:opacity-70">{isWorking ? 'Connecting…' : 'Connect'}</button>
        </div>
      </div>
    </div>
  )
}
