export class OperationTimeoutError extends Error {
  readonly operationName: string
  readonly timeoutMs: number

  constructor(operationName: string, timeoutMs: number) {
    super(`${operationName} timed out after ${timeoutMs}ms`)
    this.name = 'OperationTimeoutError'
    this.operationName = operationName
    this.timeoutMs = timeoutMs
  }
}

export async function withTimeout<T>(
  operationName: string,
  timeoutMs: number | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return task()
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new OperationTimeoutError(operationName, timeoutMs))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export function isOperationTimeoutError(err: unknown): err is OperationTimeoutError {
  return err instanceof OperationTimeoutError
}
