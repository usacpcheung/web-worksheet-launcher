function readHeader(req, headerName) {
  const value = req.headers[headerName];
  if (Array.isArray(value)) return value[0] || null;
  if (typeof value === 'string') return value;
  return null;
}

function toCanonicalHeaderName(headerName) {
  return String(headerName || '')
    .split('-')
    .map((segment) => (segment ? segment[0].toUpperCase() + segment.slice(1).toLowerCase() : segment))
    .join('-');
}

export class AuthError extends Error {
  constructor(message = 'Missing required authenticated identity header.') {
    super(message);
    this.name = 'AuthError';
    this.statusCode = 401;
    this.code = 'AUTH_REQUIRED';
  }
}

export function requireAuthenticatedIdentity(req, authHeaders) {
  const subHeader = authHeaders.sub;
  const sub = readHeader(req, subHeader)?.trim();
  if (!sub) {
    throw new AuthError(`Missing required header: ${toCanonicalHeaderName(subHeader)}`);
  }

  const email = readHeader(req, authHeaders.email)?.trim() || null;
  const name = readHeader(req, authHeaders.name)?.trim() || null;

  return { sub, email, name };
}
