export interface ErrorDetail {
  path?: string;
  message: string;
}

/** Operational error that maps directly to an HTTP response. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly errors: ErrorDetail[];

  constructor(statusCode: number, message: string, errors: ErrorDetail[] = []) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.errors = errors;
    Error.captureStackTrace?.(this, this.constructor);
  }
}
