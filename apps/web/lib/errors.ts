// Domain error hierarchy.
//
// Repo-layer code throws DomainError (or a subclass) instead of plain Error
// with a localised message. The route handler catches DomainError, returns
// `{ error: code, detail }` with `httpStatus` so:
//
//   - The UI sees a stable machine code and renders a localised string from
//     the dictionary, rather than the raw Arabic.
//   - User errors stop being HTTP 500 (which alerts Sentry on user mistakes).
//   - Logs carry a structured `code` instead of an unsearchable Arabic blob.
//
// `detail` is safe to expose to the client — never put secrets or full row
// snapshots in it. Use it for the bits the UI needs to render a helpful
// message (productName, available qty, etc).

export interface DomainErrorDetail {
  [k: string]: unknown;
}

export class DomainError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly detail?: DomainErrorDetail;

  constructor(
    code: string,
    httpStatus = 400,
    detail?: DomainErrorDetail,
  ) {
    super(code);
    this.name = "DomainError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}

/** Build the {error, detail} body a route returns for a DomainError. */
export function domainErrorBody(err: DomainError): {
  error: string;
  detail?: DomainErrorDetail;
} {
  return err.detail ? { error: err.code, detail: err.detail } : { error: err.code };
}
