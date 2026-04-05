function readHeader(req, headerName) {
  const value = req.headers[headerName];
  if (Array.isArray(value)) return value[0] || null;
  if (typeof value === 'string') return value;
  return null;
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
  const sub = readHeader(req, authHeaders.sub)?.trim();
  if (!sub) {
    throw new AuthError('Missing required header: X-OIDC-Sub');
  }

  const email = readHeader(req, authHeaders.email)?.trim() || null;
  const name = readHeader(req, authHeaders.name)?.trim() || null;

  return { sub, email, name };
}
