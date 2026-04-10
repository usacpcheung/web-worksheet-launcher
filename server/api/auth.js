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

function decodeBase64Utf8(value) {
  try {
    const normalized = String(value || '')
      .replace(/\s+/g, '')
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      return null;
    }

    const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
    const bytes = Buffer.from(padded, 'base64');
    const inputSig = padded.replace(/=+$/, '');
    const outputSig = bytes.toString('base64').replace(/=+$/, '');
    if (outputSig !== inputSig) {
      return null;
    }

    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
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
  const encodedName = readHeader(req, authHeaders.nameB64)?.trim() || null;
  const decodedName = encodedName ? decodeBase64Utf8(encodedName)?.trim() || null : null;
  const headerName = readHeader(req, authHeaders.name)?.trim() || null;
  const name = decodedName || headerName;

  return { sub, email, name };
}
