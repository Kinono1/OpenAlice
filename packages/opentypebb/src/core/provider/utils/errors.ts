/**
 * Error classes for OpenTypeBB.
 * Maps to: openbb_core/app/model/abstract/error.py
 *          openbb_core/provider/utils/errors.py
 */

/** Base error for all OpenBB errors. */
export class OpenBBError extends Error {
  readonly original?: unknown

  constructor(message: string, original?: unknown) {
    super(message)
    this.name = 'OpenBBError'
    this.original = original
  }
}

/** Raised when a query returns no data. */
export class EmptyDataError extends OpenBBError {
  constructor(message = 'No data found.') {
    super(message)
    this.name = 'EmptyDataError'
  }
}

/** Raised when credentials are missing or invalid. */
export class UnauthorizedError extends OpenBBError {
  constructor(message = 'Unauthorized.') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}
