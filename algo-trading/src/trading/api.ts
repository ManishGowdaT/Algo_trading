const configuredApiBase = import.meta.env.VITE_API_BASE ?? import.meta.env.VITE_API_URL;
const API_BASE = configuredApiBase
  ? `${configuredApiBase.replace(/\/+$/, '')}${configuredApiBase.replace(/\/+$/, '').endsWith('/api/v1') ? '' : '/api/v1'}`
  : 'http://localhost:5000/api/v1';
const AUTH_BASE = `${API_BASE}/users`;
let refreshInFlight: Promise<boolean> | null = null;

function getUrl(path: string): string {
  if (path.startsWith('/market/index-ltp')) {
    return `${API_BASE}/chart/index-ltp${path.replace('/market/index-ltp', '')}`;
  }
  return `${API_BASE}${path}`;
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

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = fetch(`${AUTH_BASE}/refresh`, {
      method: 'POST',
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const data = await response.json();
        if (!data?.token) return false;
        localStorage.setItem('jwt', data.token);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('jwt');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiGet<T>(path: string): Promise<T> {
  const url = getUrl(path);

  let res = await fetch(url, { headers: authHeaders(), credentials: 'include' });
  let data = await readResponseBody(res);
  if (isConfirmedAuthFailure(res, data)) {
    if (await refreshAccessToken()) {
      res = await fetch(url, { headers: authHeaders(), credentials: 'include' });
      data = await readResponseBody(res);
      if (res.ok) return data as T;
    }
    redirectToLoginWithReturnPath();
    throw new Error('Authentication session expired');
  }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return data as T;
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const url = getUrl(path);

  const requestOptions: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  };

  let res = await fetch(url, requestOptions);
  let data = await readResponseBody(res);
  if (isConfirmedAuthFailure(res, data)) {
    if (await refreshAccessToken()) {
      res = await fetch(url, {
        ...requestOptions,
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      data = await readResponseBody(res);
      if (res.ok) return data as T;
    }
    redirectToLoginWithReturnPath();
    throw new Error('Authentication session expired');
  }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return data as T;
}
