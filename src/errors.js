// src/errors.js

// One error contract for the whole API:
// { "error": { code, message, details[], status, path, timestamp } }
export class ApiError extends Error {
  constructor(status, code, message, details = [], headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export const badRequest = (message, details = []) => new ApiError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentication required', scheme = 'Bearer') =>
  new ApiError(401, 'UNAUTHENTICATED', message, [], { 'WWW-Authenticate': scheme });
export const forbidden = (message = 'You do not have access to this resource') =>
  new ApiError(403, 'FORBIDDEN', message);
export const notFound = (what, id) =>
  new ApiError(404, 'NOT_FOUND', id === undefined ? what : `${what} ${id} was not found`);
export const methodNotAllowed = (allow) =>
  new ApiError(405, 'METHOD_NOT_ALLOWED', `Method not allowed here. Allowed: ${allow.join(', ')}`, [], { Allow: allow.join(', ') });
export const conflict = (code, message, details = []) => new ApiError(409, code, message, details);
export const preconditionFailed = () =>
  new ApiError(412, 'PRECONDITION_FAILED', 'The resource has changed since you last retrieved it (If-Match does not match current ETag)');

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    err = new ApiError(400, 'MALFORMED_JSON', 'Request body is not valid JSON', [{ issue: err.message }]);
  } else if (!(err instanceof ApiError) && err.expose && err.status >= 400 && err.status < 500) {
    err = new ApiError(err.status, 'BAD_REQUEST', err.message);
  } else if (!(err instanceof ApiError)) {
    console.error(err);
    err = new ApiError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred');
  }
  res.set(err.headers);
  res.status(err.status).json({
    error: {
      code: err.code,
      message: err.message,
      details: err.details,
      status: err.status,
      path: req.originalUrl,
      timestamp: new Date().toISOString(),
    },
  });
}