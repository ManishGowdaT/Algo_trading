import type { ReactNode } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

import { useAngelConnection } from '../../shared/angel/AngelConnectionProvider'
import { useTheme } from '../../shared/theme/ThemeProvider'
import { usePageTitle } from '../../hooks/usePageTitle'
import { Button } from '../../components/ui/button'

type Props = {
  title: string
  subtitle?: string
  backTo?: string
  children: ReactNode
}

export default function StrategiesLayout({ title, subtitle, backTo, children }: Props) {
  usePageTitle(title)
  const navigate = useNavigate()
  const { theme, toggleTheme } = useTheme()
  const { connectStatus, connectMessage, backendReady, openConnect, disconnect } = useAngelConnection()

  return (
    <div className="min-h-screen max-md:min-h-[100dvh] bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-8 max-md:px-0 max-md:py-2">
        <header className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between max-md:rounded-none max-md:border-x-0">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight max-md:text-xl">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{subtitle}</p> : null}
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Status: <span className="font-medium">{connectStatus}</span>
            </p>
            {connectMessage ? <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{connectMessage}</p> : null}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            {backTo ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigate(backTo)}
              >
                Back
              </Button>
            ) : null}

            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>

            {connectStatus === 'connected' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void disconnect()}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                onClick={openConnect}
                disabled={!backendReady || connectStatus === 'connecting'}
                title={!backendReady ? 'Server is starting up, please wait a moment.' : undefined}
              >
                {connectStatus === 'connecting' ? 'Connecting…' : 'Connect'}
              </Button>
            )}
          </div>
        </header>

        <section className="mt-4 max-md:mt-3">{children}</section>
      </div>
    </div>
  )
}
