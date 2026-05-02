import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

dotenv.config({
  path: path.join(repoRoot, '.env'),
  override: false,
});

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

function parsePositiveInt(value, fallback, name) {
  const raw = value ?? fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name} value: ${raw}`);
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
    attemptSlotLimit: 3,
    browsePageLimitDefault: 20,
    browsePageLimitMax: 100,
    packageUploadMaxBytes: parsePositiveInt(env.PACKAGE_UPLOAD_MAX_BYTES, '31457280', 'PACKAGE_UPLOAD_MAX_BYTES'),
  };
}
