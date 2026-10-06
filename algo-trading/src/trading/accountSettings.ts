export function accountStorageKey(userId: string, brokerAccountId: string, key: string): string {
  return `account:${encodeURIComponent(userId)}:${encodeURIComponent(brokerAccountId)}:${key}`
}

export function readAccountSetting<T>(userId: string, brokerAccountId: string, key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(accountStorageKey(userId, brokerAccountId, key))
    return value === null ? fallback : JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function writeAccountSetting(userId: string, brokerAccountId: string, key: string, value: unknown): void {
  localStorage.setItem(accountStorageKey(userId, brokerAccountId, key), JSON.stringify(value))
}
