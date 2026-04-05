import path from 'node:path';

function requireNonEmpty(name, raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return raw.trim();
}

function parsePort(value, fallback) {
  const raw = value ?? fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid PORT value: ${raw}`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const databaseUrl = requireNonEmpty('DATABASE_URL', env.DATABASE_URL);
  const storageRoot = path.resolve(requireNonEmpty('STORAGE_ROOT', env.STORAGE_ROOT));

  return {
    nodeEnv: env.NODE_ENV || 'development',
    port: parsePort(env.PORT, '8787'),
    databaseUrl,
    storageRoot,
    authHeaders: {
      sub: (env.AUTH_HEADER_SUB || 'x-oidc-sub').toLowerCase(),
      email: (env.AUTH_HEADER_EMAIL || 'x-oidc-email').toLowerCase(),
      name: (env.AUTH_HEADER_NAME || 'x-oidc-name').toLowerCase(),
    },
    draftSlotLimit: 3,
    browsePageLimitDefault: 20,
    browsePageLimitMax: 100,
  };
}
