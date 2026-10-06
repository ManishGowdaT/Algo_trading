export class AuthSessionMutationQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = this.tail.catch(() => undefined).then(mutation)
    this.tail = operation.then(() => undefined, () => undefined)
    return operation
  }
}

export function clearTokenForCurrentSession(
  generation: number,
  currentGeneration: number,
  removeToken: () => void,
): void {
  if (generation === currentGeneration) removeToken()
}
