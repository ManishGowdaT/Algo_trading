import { API_BASE } from '../config/apiBase';
const AUTH_BASE = `${API_BASE}/users`;
let refreshInFlight: Promise<boolean> | null = null;
let apiIdentity = ''
let apiAccountId = ''
let identityGeneration = 0
const activeRequests = new Set<AbortController>()

export function setApiIdentity(userId: string | null): void {
  const next = userId || ''
  if (next === apiIdentity) return
  apiIdentity = next
  apiAccountId = ''
  identityGeneration += 1
  for (const controller of activeRequests) controller.abort()
  activeRequests.clear()
  refreshInFlight = null
}

export function setApiAccountScope(brokerAccountId: string | null): void {
  const next = brokerAccountId || ''
  if (next === apiAccountId) return
  apiAccountId = next
  identityGeneration += 1
  for (const controller of activeRequests) controller.abort()
  activeRequests.clear()
  refreshInFlight = null
}

export function isApiScopeCurrent(scope: string): boolean {
  return `${apiIdentity}:${apiAccountId}` === scope
}

function getUrl(path: string): string {
  let url: string
  if (path.startsWith('/market/index-ltp')) {
    url = `${API_BASE}/chart/index-ltp${path.replace('/market/index-ltp', '')}`
  } else {
    url = `${API_BASE}${path}`
  }
  const accountPath = path.split('?')[0]
  const accountScoped = /^\/(angel\/(?:status|logout|orders|positions)|strategies\/(?:settings\/[^/]+|[^/]+\/(?:status|start|stop|exit))|trades(?:\/|$))/.test(accountPath)
  if (apiAccountId && accountScoped) {
    const parsed = new URL(url, window.location.origin)
    parsed.searchParams.set('brokerAccountId', apiAccountId)
    return parsed.toString()
  }
  return url
}

function isConfirmedAuthFailure(response: Response, data: unknown): boolean {
  if (response.status !== 401) return false;
  if (data && typeof data === 'object' && 'brokerSessionUnavailable' in data) return false;
  return true;
}

function redirectToLoginWithReturnPath(): void {
  if (window.location.pathname === '/login') return;
  const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`/login?redirect=${encodeURIComponent(returnPath)}`);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

function errorMessage(data: unknown, status: number): string {
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    const body = data as { message?: unknown; detail?: unknown; requestId?: unknown };
    const detail = typeof body.message === 'string'
      ? body.message
      : typeof body.detail === 'string'
        ? body.detail
        : Array.isArray(body.detail)
          ? body.detail.map((item) => {
              if (item && typeof item === 'object' && 'msg' in item && typeof item.msg === 'string') return item.msg;
              return '';
            }).filter(Boolean).join('. ')
          : '';
    const requestReference = typeof body.requestId === 'string' ? ` (Reference: ${body.requestId})` : '';
    if (detail) return `${detail}${requestReference}`;
  }
  return `Request failed with status ${status}.`;
}

function assertCurrent(generation: number): void {
  if (generation !== identityGeneration) throw new DOMException('Request belongs to an old user or account.', 'AbortError')
}

async function refreshAccessToken(generation: number): Promise<boolean> {
  if (!refreshInFlight) {
    const controller = new AbortController()
    activeRequests.add(controller)
    refreshInFlight = fetch(`${AUTH_BASE}/refresh`, {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        assertCurrent(generation)
        if (!response.ok) return false;
        const data = await response.json();
        assertCurrent(generation)
        if (!data?.token) return false;
        localStorage.setItem('jwt', data.token);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        activeRequests.delete(controller)
        if (generation === identityGeneration) refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('jwt');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' })
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body })
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

async function request<T>(path: string, options: { method: string; body?: unknown }): Promise<T> {
  if (!apiIdentity) throw new DOMException('No signed-in user owns this request.', 'AbortError')
  const generation = identityGeneration
  const controller = new AbortController()
  activeRequests.add(controller)
  const url = getUrl(path)
  const requestOptions = (): RequestInit => ({
    method: options.method,
    headers: { ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...authHeaders() },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'include',
    signal: controller.signal,
  })
  try {
    let res = await fetch(url, requestOptions())
    let data = await readResponseBody(res)
    assertCurrent(generation)
    if (isConfirmedAuthFailure(res, data)) {
      const refreshed = await refreshAccessToken(generation)
      assertCurrent(generation)
      if (refreshed) {
        res = await fetch(url, requestOptions())
        data = await readResponseBody(res)
        assertCurrent(generation)
        if (res.ok) return data as T
      }
      redirectToLoginWithReturnPath()
      throw new Error('Authentication session expired')
    }
    if (!res.ok) throw new Error(errorMessage(data, res.status))
    return data as T
  } finally {
    activeRequests.delete(controller)
  }
}
