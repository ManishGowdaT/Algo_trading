type PollTask = () => Promise<boolean | void> | boolean | void

type PollOptions = {
  intervalMs: number
  initialJitterMs?: number
  scheduleJitterMs?: number
  maxBackoffMs?: number
}

export function startResilientPolling(task: PollTask, options: PollOptions): () => void {
  const {
    intervalMs,
    initialJitterMs = 350,
    scheduleJitterMs = 250,
    maxBackoffMs = 30_000,
  } = options

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let consecutiveFailures = 0

  const jitter = (max: number) => max > 0 ? Math.floor(Math.random() * (max + 1)) : 0

  const schedule = (delayMs: number) => {
    if (stopped) return
    timer = setTimeout(run, Math.max(0, delayMs))
  }

  const run = async () => {
    if (stopped) return
    try {
      const successful = await task()
      consecutiveFailures = successful === false ? consecutiveFailures + 1 : 0
    } catch {
      consecutiveFailures += 1
    }

    if (stopped) return
    const backoff = Math.min(maxBackoffMs, intervalMs * (2 ** Math.min(consecutiveFailures, 6)))
    schedule(backoff + jitter(scheduleJitterMs))
  }

  schedule(jitter(initialJitterMs))

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
  }
}
