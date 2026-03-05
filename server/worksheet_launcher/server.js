#!/usr/bin/env node
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8787);
const AUTH_TOKEN = process.env.LAUNCH_API_TOKEN || 'dev-launch-token';
const LAUNCH_TTL_MS = Number(process.env.LAUNCH_TTL_MS || 5 * 60 * 1000);
const CLEANUP_INTERVAL_MS = Number(process.env.LAUNCH_CLEANUP_INTERVAL_MS || 30 * 1000);
const EXPIRED_RETENTION_MS = Number(process.env.LAUNCH_EXPIRED_RETENTION_MS || 60 * 1000);
const RETURN_ORIGIN_ALLOWLIST = (process.env.RETURN_ORIGIN_ALLOWLIST || 'https://parent.example')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const CREATE_RATE_LIMIT_MAX = Number(process.env.CREATE_RATE_LIMIT_MAX || 60);
const CONSUME_RATE_LIMIT_MAX = Number(process.env.CONSUME_RATE_LIMIT_MAX || 120);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60 * 1000);

const WEB_ROOT = __dirname;

function integrationKey(tenantId, clientId) {
  return `${tenantId}::${clientId}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqualHex(hashA, hashB) {
  const a = Buffer.from(hashA, 'hex');
  const b = Buffer.from(hashB, 'hex');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

class InMemoryLaunchStore {
  constructor() {
    /** @type {Map<string, {
     * launchId: string,
     * rid: string,
     * worksheet: any,
     * returnOrigin: string,
     * tenantId: string,
     * clientId: string,
     * createdBy: string,
     * rendererSessionId: string,
     * createdAt: string,
     * expiresAt: string,
     * consumedAt: string | null
     * }>} */
    this.launches = new Map();
  }

  create(input) {
    const now = Date.now();
    let launchId = crypto.randomBytes(32).toString('base64url');
    while (this.launches.has(launchId)) {
      launchId = crypto.randomBytes(32).toString('base64url');
    }
    const record = {
      launchId,
      ...input,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LAUNCH_TTL_MS).toISOString(),
      consumedAt: null
    };

    this.launches.set(launchId, record);
    return { launchId: record.launchId, expiresAt: record.expiresAt };
  }

  get(launchId) {
    return this.launches.get(launchId) || null;
  }

  consumeAtomic(launchId, nowMs) {
    const record = this.launches.get(launchId);
    if (!record) {
      return { error: { status: 404, code: 'not_found', message: 'Launch not found' } };
    }

    const expiresAtMs = Date.parse(record.expiresAt);
    if (Number.isNaN(expiresAtMs) || nowMs > expiresAtMs) {
      return {
        error: {
          status: 410,
          code: 'expired',
          message: 'Launch has expired',
          details: { expiresAt: record.expiresAt }
        }
      };
    }

    if (record.consumedAt) {
      return {
        error: {
          status: 409,
          code: 'already_consumed',
          message: 'Launch has already been consumed',
          details: { consumedAt: record.consumedAt }
        }
      };
    }

    const consumedAt = new Date(nowMs).toISOString();
    record.consumedAt = consumedAt;
    this.launches.set(launchId, record);
    return { record };
  }

  purgeExpired(nowMs) {
    for (const [launchId, record] of this.launches.entries()) {
      const expiresAtMs = Date.parse(record.expiresAt);
      if (Number.isNaN(expiresAtMs)) {
        this.launches.delete(launchId);
        continue;
      }

      const hardDeleteAt = expiresAtMs + EXPIRED_RETENTION_MS;
      if (nowMs > hardDeleteAt) {
        this.launches.delete(launchId);
      }
    }
  }
}

class InMemoryRateLimiter {
  constructor() {
    /** @type {Map<string, {count:number, resetAt:number}>} */
    this.entries = new Map();
  }

  check({ action, key, max, nowMs }) {
    const bucketKey = `${action}:${key}`;
    const existing = this.entries.get(bucketKey);

    if (!existing || nowMs > existing.resetAt) {
      this.entries.set(bucketKey, { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW_MS });
      return { allowed: true };
    }

    if (existing.count >= max) {
      return { allowed: false, retryAfterMs: Math.max(0, existing.resetAt - nowMs) };
    }

    existing.count += 1;
    this.entries.set(bucketKey, existing);
    return { allowed: true };
  }

  purgeExpired(nowMs) {
    for (const [key, entry] of this.entries.entries()) {
      if (nowMs > entry.resetAt) {
        this.entries.delete(key);
      }
    }
  }
}

class InMemoryIntegrationStore {
  constructor() {
    /** @type {Map<string, {
     * tenantId:string,
     * clientId:string,
     * allowedReturnOrigins:string[],
     * ownerMetadata:Record<string,any>,
     * authMethod:string,
     * createdAt:string,
     * updatedAt:string,
     * credentials:Array<{credentialId:string, status:'active'|'revoked'|'rotated', createdAt:string, updatedAt:string, revokedAt:string|null, hash:string, secretLast4:string}>
     * }>} */
    this.integrations = new Map();
    /** @type {Array<{timestamp:string, actor:string, action:string, tenantId:string, clientId:string, details:Record<string,any>}>} */
    this.audit = [];
  }

  register({ tenantId, clientId, allowedReturnOrigins, ownerMetadata, actor }) {
    const key = integrationKey(tenantId, clientId);
    if (this.integrations.has(key)) {
      return { error: { status: 409, code: 'already_exists', message: 'Integration already exists' } };
    }

    const now = new Date().toISOString();
    const provisioned = this.provisionCredentialInternal();

    const integration = {
      tenantId,
      clientId,
      allowedReturnOrigins,
      ownerMetadata,
      authMethod: 'bearer_client_secret',
      createdAt: now,
      updatedAt: now,
      credentials: [provisioned.stored]
    };

    this.integrations.set(key, integration);
    this.audit.push({
      timestamp: now,
      actor,
      action: 'integration_registered',
      tenantId,
      clientId,
      details: {
        allowedReturnOrigins,
        ownerMetadata,
        credentialId: provisioned.output.credentialId,
        authMethod: integration.authMethod
      }
    });

    return { integration, credentialOutput: provisioned.output };
  }

  get(tenantId, clientId) {
    return this.integrations.get(integrationKey(tenantId, clientId)) || null;
  }

  rotateCredential({ tenantId, clientId, actor, reason }) {
    const integration = this.get(tenantId, clientId);
    if (!integration) {
      return { error: { status: 404, code: 'not_found', message: 'Integration not found' } };
    }

    const now = new Date().toISOString();
    for (const cred of integration.credentials) {
      if (cred.status === 'active') {
        cred.status = 'rotated';
        cred.updatedAt = now;
      }
    }

    const provisioned = this.provisionCredentialInternal();
    integration.credentials.push(provisioned.stored);
    integration.updatedAt = now;

    this.audit.push({
      timestamp: now,
      actor,
      action: 'credential_rotated',
      tenantId,
      clientId,
      details: {
        credentialId: provisioned.output.credentialId,
        reason: reason || null
      }
    });

    return { integration, credentialOutput: provisioned.output };
  }

  revokeCredential({ tenantId, clientId, credentialId, actor, reason }) {
    const integration = this.get(tenantId, clientId);
    if (!integration) {
      return { error: { status: 404, code: 'not_found', message: 'Integration not found' } };
    }

    const cred = integration.credentials.find((c) => c.credentialId === credentialId);
    if (!cred) {
      return { error: { status: 404, code: 'not_found', message: 'Credential not found' } };
    }

    if (cred.status === 'revoked') {
      return { error: { status: 409, code: 'already_revoked', message: 'Credential already revoked' } };
    }

    const now = new Date().toISOString();
    cred.status = 'revoked';
    cred.revokedAt = now;
    cred.updatedAt = now;
    integration.updatedAt = now;

    this.audit.push({
      timestamp: now,
      actor,
      action: 'credential_revoked',
      tenantId,
      clientId,
      details: {
        credentialId,
        reason: reason || null
      }
    });

    return { integration };
  }

  verifyClientSecret(tenantId, clientId, clientSecret) {
    const integration = this.get(tenantId, clientId);
    if (!integration) {
      return null;
    }

    const secretHash = sha256(clientSecret);
    const credential = integration.credentials.find((cred) => cred.status === 'active' && safeEqualHex(cred.hash, secretHash));
    if (!credential) {
      return null;
    }

    return integration;
  }

  getOnboardingOutput({ tenantId, clientId, req }) {
    const integration = this.get(tenantId, clientId);
    if (!integration) {
      return { error: { status: 404, code: 'not_found', message: 'Integration not found' } };
    }

    return {
      onboarding: {
        apiBaseUrl: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`,
        authMethod: integration.authMethod,
        tenantId: integration.tenantId,
        clientId: integration.clientId,
        allowedReturnOrigins: integration.allowedReturnOrigins,
        activeCredentialIds: integration.credentials.filter((c) => c.status === 'active').map((c) => c.credentialId)
      }
    };
  }

  listAudit({ tenantId, clientId }) {
    return this.audit.filter((item) => {
      if (tenantId && item.tenantId !== tenantId) return false;
      if (clientId && item.clientId !== clientId) return false;
      return true;
    });
  }

  provisionCredentialInternal() {
    const secret = crypto.randomBytes(32).toString('base64url');
    const credentialId = crypto.randomUUID();
    const now = new Date().toISOString();
    return {
      output: {
        credentialId,
        clientSecret: secret
      },
      stored: {
        credentialId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        revokedAt: null,
        hash: sha256(secret),
        secretLast4: secret.slice(-4)
      }
    };
  }
}

const launchStore = new InMemoryLaunchStore();
const rateLimiter = new InMemoryRateLimiter();
const integrationStore = new InMemoryIntegrationStore();

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message, details) {
  const payload = {
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  };
  sendJson(res, status, payload);
}

function logSecurityEvent(event, context = {}) {
  const safeContext = { ...context };
  if (safeContext.launchId && typeof safeContext.launchId === 'string') {
    safeContext.launchId = `${safeContext.launchId.slice(0, 8)}...`;
  }
  if (safeContext.rid && typeof safeContext.rid === 'string') {
    safeContext.rid = safeContext.rid.slice(0, 64);
  }
  if (safeContext.worksheet) {
    delete safeContext.worksheet;
  }
  console.warn(`[security] ${event}`, safeContext);
}

function notFound(res) {
  sendError(res, 404, 'not_found', 'Resource not found');
}

function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendError(res, 405, 'method_not_allowed', 'Method not allowed');
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function getClientIp(req) {
  const fwd = typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : '';
  const fromFwd = fwd.split(',')[0].trim();
  if (fromFwd) {
    return fromFwd;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function parseAuthn(req) {
  const auth = req.headers.authorization || '';
  const [scheme, token] = auth.split(' ');

  const tenantId = typeof req.headers['x-tenant-id'] === 'string' ? req.headers['x-tenant-id'].trim() : '';
  const clientId = typeof req.headers['x-client-id'] === 'string' ? req.headers['x-client-id'].trim() : '';
  const createdBy = typeof req.headers['x-user-id'] === 'string'
    ? req.headers['x-user-id'].trim()
    : typeof req.headers['x-owner-id'] === 'string'
      ? req.headers['x-owner-id'].trim()
      : '';

  if (!tenantId || !clientId || !createdBy) {
    return null;
  }

  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  if (token === AUTH_TOKEN) {
    return { tenantId, clientId, createdBy, authMethod: 'admin' };
  }

  const integration = integrationStore.verifyClientSecret(tenantId, clientId, token);
  if (!integration) {
    return null;
  }

  return { tenantId, clientId, createdBy, authMethod: integration.authMethod, integration };
}

function parseAdminAuthn(req) {
  const auth = req.headers.authorization || '';
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token || token !== AUTH_TOKEN) {
    return null;
  }

  const adminId = typeof req.headers['x-admin-id'] === 'string' && req.headers['x-admin-id'].trim()
    ? req.headers['x-admin-id'].trim()
    : 'system-admin';

  return { adminId };
}

function parseRendererSession(req) {
  const rendererSessionId = typeof req.headers['x-renderer-session-id'] === 'string'
    ? req.headers['x-renderer-session-id'].trim()
    : '';

  if (!rendererSessionId || !/^[A-Za-z0-9._:-]{12,200}$/.test(rendererSessionId)) {
    return null;
  }

  return { rendererSessionId };
}

function enforceRateLimit(req, res, identity, action) {
  const clientIp = getClientIp(req);
  const clientKey = identity ? `${identity.clientId}:${clientIp}` : `anon:${clientIp}`;
  const max = action === 'create' ? CREATE_RATE_LIMIT_MAX : CONSUME_RATE_LIMIT_MAX;
  const checked = rateLimiter.check({ action, key: clientKey, max, nowMs: Date.now() });

  if (checked.allowed) {
    return true;
  }

  const retryAfterSec = Math.ceil((checked.retryAfterMs || RATE_LIMIT_WINDOW_MS) / 1000);
  res.setHeader('Retry-After', String(retryAfterSec));
  sendError(res, 429, 'rate_limited', 'Too many requests', { retryAfterSec });
  logSecurityEvent('rate_limited', { action, clientIp, clientId: identity?.clientId });
  return false;
}

function validateWorksheet(worksheet) {
  if (!worksheet || typeof worksheet !== 'object') {
    return 'worksheet must be an object';
  }
  if (worksheet.v !== 1) {
    return 'worksheet.v must equal 1';
  }
  if (!Array.isArray(worksheet.q) || worksheet.q.length < 1) {
    return 'worksheet.q must be a non-empty array';
  }
  if (!worksheet.q.every((item) => typeof item === 'string')) {
    return 'worksheet.q must contain only strings';
  }
  if (worksheet.title !== undefined && typeof worksheet.title !== 'string') {
    return 'worksheet.title must be a string when provided';
  }
  if (worksheet.rewrite !== undefined && typeof worksheet.rewrite !== 'boolean') {
    return 'worksheet.rewrite must be a boolean when provided';
  }
  return null;
}

function validateReturnOrigin(value, allowedOrigins) {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'returnOrigin must be a non-empty string' };
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'returnOrigin must use http or https' };
    }

    if (!allowedOrigins.includes(parsed.origin)) {
      return { error: 'returnOrigin is not in allowlist', code: 'origin_not_allowed' };
    }

    return { value: parsed.origin };
  } catch {
    return { error: 'returnOrigin must be a valid absolute URL' };
  }
}

function validateCreateLaunchPayload(body, allowedOrigins) {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }

  if (typeof body.rid !== 'string' || !body.rid.trim()) {
    return { error: 'rid must be a non-empty string' };
  }

  const worksheetError = validateWorksheet(body.worksheet);
  if (worksheetError) {
    return { error: worksheetError };
  }

  const origin = validateReturnOrigin(body.returnOrigin, allowedOrigins);
  if (origin.error) {
    return { error: origin.error, code: origin.code };
  }

  return {
    value: {
      rid: body.rid.trim(),
      worksheet: body.worksheet,
      returnOrigin: origin.value
    }
  };
}

function validateIntegrationPayload(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'Request body must be a JSON object' };
  }
  if (typeof body.tenantId !== 'string' || !body.tenantId.trim()) {
    return { error: 'tenantId must be a non-empty string' };
  }
  if (typeof body.clientId !== 'string' || !body.clientId.trim()) {
    return { error: 'clientId must be a non-empty string' };
  }
  if (!Array.isArray(body.allowedReturnOrigins) || body.allowedReturnOrigins.length < 1) {
    return { error: 'allowedReturnOrigins must be a non-empty array' };
  }

  const normalized = [];
  for (const origin of body.allowedReturnOrigins) {
    const validated = validateReturnOrigin(origin, RETURN_ORIGIN_ALLOWLIST);
    if (validated.error) {
      return { error: `allowedReturnOrigins entry invalid: ${validated.error}`, code: validated.code };
    }
    normalized.push(validated.value);
  }

  if (!body.ownerMetadata || typeof body.ownerMetadata !== 'object' || Array.isArray(body.ownerMetadata)) {
    return { error: 'ownerMetadata must be an object' };
  }

  return {
    value: {
      tenantId: body.tenantId.trim(),
      clientId: body.clientId.trim(),
      allowedReturnOrigins: [...new Set(normalized)],
      ownerMetadata: body.ownerMetadata
    }
  };
}

function extractLaunchIdFromPath(pathname) {
  const match = pathname.match(/^\/api\/launches\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function extractOnboardingPath(pathname) {
  const match = pathname.match(/^\/api\/integrations\/([^/]+)\/([^/]+)\/onboarding$/);
  if (!match) return null;
  return {
    tenantId: decodeURIComponent(match[1]),
    clientId: decodeURIComponent(match[2])
  };
}

function validateLaunchId(launchId) {
  if (typeof launchId !== 'string' || !launchId.trim()) {
    return false;
  }
  return /^[A-Za-z0-9_-]{32,128}$/.test(launchId);
}

function verifyAccess(record, identity, rendererSession) {
  if (!record) {
    return { error: { status: 404, code: 'not_found', message: 'Launch not found' } };
  }

  if (
    record.tenantId !== identity.tenantId ||
    record.clientId !== identity.clientId
  ) {
    return { error: { status: 401, code: 'unauthorized', message: 'Not authorized for this launch' } };
  }

  if (rendererSession && record.rendererSessionId !== rendererSession.rendererSessionId) {
    return { error: { status: 401, code: 'unauthorized', message: 'Invalid renderer session' } };
  }

  return { ok: true };
}

function launchPayload(record) {
  return {
    rid: record.rid,
    worksheet: record.worksheet,
    returnOrigin: record.returnOrigin
  };
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === '/' ? 'render.html' : pathname.replace(/^\/+/, '');
  const normalized = path.normalize(requestedPath);
  const filePath = path.join(WEB_ROOT, normalized);

  if (!filePath.startsWith(WEB_ROOT) || normalized.startsWith('..')) {
    notFound(res);
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      notFound(res);
      return;
    }

    const ext = path.extname(filePath);
    const contentType = (
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      'application/octet-stream'
    );

    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/api/integrations/register') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, ['POST']);
      return;
    }

    const admin = parseAdminAuthn(req);
    if (!admin) {
      sendError(res, 401, 'unauthorized', 'Missing or invalid admin authentication');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, 'invalid_payload', err.message);
      return;
    }

    const validated = validateIntegrationPayload(body);
    if (validated.error) {
      sendError(res, 400, validated.code || 'invalid_payload', validated.error);
      return;
    }

    const registered = integrationStore.register({ ...validated.value, actor: admin.adminId });
    if (registered.error) {
      sendError(res, registered.error.status, registered.error.code, registered.error.message);
      return;
    }

    sendJson(res, 201, {
      tenantId: registered.integration.tenantId,
      clientId: registered.integration.clientId,
      allowedReturnOrigins: registered.integration.allowedReturnOrigins,
      ownerMetadata: registered.integration.ownerMetadata,
      authMethod: registered.integration.authMethod,
      apiBaseUrl: `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`,
      credential: registered.credentialOutput
    });
    return;
  }

  if (pathname === '/api/integrations/credentials/rotate') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, ['POST']);
      return;
    }

    const admin = parseAdminAuthn(req);
    if (!admin) {
      sendError(res, 401, 'unauthorized', 'Missing or invalid admin authentication');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, 'invalid_payload', err.message);
      return;
    }

    if (!body || typeof body !== 'object' || !body.tenantId || !body.clientId) {
      sendError(res, 400, 'invalid_payload', 'tenantId and clientId are required');
      return;
    }

    const rotated = integrationStore.rotateCredential({
      tenantId: String(body.tenantId).trim(),
      clientId: String(body.clientId).trim(),
      actor: admin.adminId,
      reason: typeof body.reason === 'string' ? body.reason : null
    });

    if (rotated.error) {
      sendError(res, rotated.error.status, rotated.error.code, rotated.error.message);
      return;
    }

    sendJson(res, 200, {
      tenantId: rotated.integration.tenantId,
      clientId: rotated.integration.clientId,
      authMethod: rotated.integration.authMethod,
      credential: rotated.credentialOutput
    });
    return;
  }

  if (pathname === '/api/integrations/credentials/revoke') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, ['POST']);
      return;
    }

    const admin = parseAdminAuthn(req);
    if (!admin) {
      sendError(res, 401, 'unauthorized', 'Missing or invalid admin authentication');
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, 'invalid_payload', err.message);
      return;
    }

    if (!body || typeof body !== 'object' || !body.tenantId || !body.clientId || !body.credentialId) {
      sendError(res, 400, 'invalid_payload', 'tenantId, clientId, and credentialId are required');
      return;
    }

    const revoked = integrationStore.revokeCredential({
      tenantId: String(body.tenantId).trim(),
      clientId: String(body.clientId).trim(),
      credentialId: String(body.credentialId).trim(),
      actor: admin.adminId,
      reason: typeof body.reason === 'string' ? body.reason : null
    });

    if (revoked.error) {
      sendError(res, revoked.error.status, revoked.error.code, revoked.error.message);
      return;
    }

    sendJson(res, 200, {
      tenantId: revoked.integration.tenantId,
      clientId: revoked.integration.clientId,
      activeCredentialIds: revoked.integration.credentials.filter((c) => c.status === 'active').map((c) => c.credentialId)
    });
    return;
  }

  if (pathname === '/api/integrations/audit') {
    if (req.method !== 'GET') {
      methodNotAllowed(res, ['GET']);
      return;
    }

    const admin = parseAdminAuthn(req);
    if (!admin) {
      sendError(res, 401, 'unauthorized', 'Missing or invalid admin authentication');
      return;
    }

    const tenantId = typeof url.searchParams.get('tenantId') === 'string' ? url.searchParams.get('tenantId') : undefined;
    const clientId = typeof url.searchParams.get('clientId') === 'string' ? url.searchParams.get('clientId') : undefined;
    sendJson(res, 200, { items: integrationStore.listAudit({ tenantId, clientId }) });
    return;
  }

  const onboardingPath = extractOnboardingPath(pathname);
  if (onboardingPath) {
    if (req.method !== 'GET') {
      methodNotAllowed(res, ['GET']);
      return;
    }

    const admin = parseAdminAuthn(req);
    if (!admin) {
      sendError(res, 401, 'unauthorized', 'Missing or invalid admin authentication');
      return;
    }

    const output = integrationStore.getOnboardingOutput({ ...onboardingPath, req });
    if (output.error) {
      sendError(res, output.error.status, output.error.code, output.error.message);
      return;
    }

    sendJson(res, 200, output.onboarding);
    return;
  }

  if (pathname === '/api/launches') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, ['POST']);
      return;
    }

    const identity = parseAuthn(req);
    if (!identity) {
      logSecurityEvent('invalid_auth_create', { clientIp: getClientIp(req) });
      sendError(res, 401, 'unauthorized', 'Missing or invalid authentication');
      return;
    }

    if (!enforceRateLimit(req, res, identity, 'create')) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, 'invalid_payload', err.message);
      return;
    }

    const integration = integrationStore.get(identity.tenantId, identity.clientId);
    const allowedOrigins = integration ? integration.allowedReturnOrigins : RETURN_ORIGIN_ALLOWLIST;
    const validated = validateCreateLaunchPayload(body, allowedOrigins);
    if (validated.error) {
      if (validated.code === 'origin_not_allowed') {
        logSecurityEvent('origin_allowlist_mismatch', {
          clientId: identity.clientId,
          tenantId: identity.tenantId,
          returnOrigin: body?.returnOrigin
        });
      }
      sendError(res, 400, validated.code || 'invalid_payload', validated.error);
      return;
    }

    const rendererSession = parseRendererSession(req);
    if (!rendererSession) {
      logSecurityEvent('invalid_renderer_session_create', { clientId: identity.clientId, tenantId: identity.tenantId });
      sendError(res, 401, 'unauthorized', 'Missing or invalid renderer session');
      return;
    }

    const created = launchStore.create({
      ...validated.value,
      tenantId: identity.tenantId,
      clientId: identity.clientId,
      createdBy: identity.createdBy,
      rendererSessionId: rendererSession.rendererSessionId
    });
    sendJson(res, 201, created);
    return;
  }

  if (pathname === '/api/launches/consume') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, ['POST']);
      return;
    }

    const identity = parseAuthn(req);
    if (!identity) {
      logSecurityEvent('invalid_auth_consume', { clientIp: getClientIp(req) });
      sendError(res, 401, 'unauthorized', 'Missing or invalid authentication');
      return;
    }

    const rendererSession = parseRendererSession(req);
    if (!rendererSession) {
      logSecurityEvent('invalid_renderer_session_consume', { clientId: identity.clientId, tenantId: identity.tenantId });
      sendError(res, 401, 'unauthorized', 'Missing or invalid renderer session');
      return;
    }

    if (!enforceRateLimit(req, res, identity, 'consume')) {
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, 'invalid_payload', err.message);
      return;
    }

    const launchId = body.launchId;
    if (!validateLaunchId(launchId)) {
      sendError(res, 400, 'invalid_payload', 'launchId format is invalid');
      return;
    }

    const record = launchStore.get(launchId);
    const access = verifyAccess(record, identity, rendererSession);
    if (access.error) {
      logSecurityEvent('consume_access_denied', {
        launchId,
        clientId: identity.clientId,
        tenantId: identity.tenantId,
        userId: identity.createdBy
      });
      sendError(res, access.error.status, access.error.code, access.error.message);
      return;
    }

    const consumed = launchStore.consumeAtomic(launchId, Date.now());
    if (consumed.error) {
      if (consumed.error.code === 'already_consumed') {
        logSecurityEvent('replay_attempt', {
          launchId,
          clientId: identity.clientId,
          tenantId: identity.tenantId,
          consumedAt: consumed.error.details?.consumedAt
        });
      }
      sendError(res, consumed.error.status, consumed.error.code, consumed.error.message, consumed.error.details);
      return;
    }

    sendJson(res, 200, launchPayload(consumed.record));
    return;
  }

  const launchIdFromPath = extractLaunchIdFromPath(pathname);
  if (launchIdFromPath !== null) {
    if (req.method !== 'GET') {
      methodNotAllowed(res, ['GET']);
      return;
    }

    const identity = parseAuthn(req);
    if (!identity) {
      logSecurityEvent('invalid_auth_consume_get', { clientIp: getClientIp(req) });
      sendError(res, 401, 'unauthorized', 'Missing or invalid authentication');
      return;
    }

    const rendererSession = parseRendererSession(req);
    if (!rendererSession) {
      logSecurityEvent('invalid_renderer_session_consume_get', { clientId: identity.clientId, tenantId: identity.tenantId });
      sendError(res, 401, 'unauthorized', 'Missing or invalid renderer session');
      return;
    }

    if (!enforceRateLimit(req, res, identity, 'consume')) {
      return;
    }

    if (!validateLaunchId(launchIdFromPath)) {
      sendError(res, 400, 'invalid_payload', 'launchId format is invalid');
      return;
    }

    const record = launchStore.get(launchIdFromPath);
    const access = verifyAccess(record, identity, rendererSession);
    if (access.error) {
      logSecurityEvent('consume_get_access_denied', {
        launchId: launchIdFromPath,
        clientId: identity.clientId,
        tenantId: identity.tenantId,
        userId: identity.createdBy
      });
      sendError(res, access.error.status, access.error.code, access.error.message);
      return;
    }

    const consumed = launchStore.consumeAtomic(launchIdFromPath, Date.now());
    if (consumed.error) {
      if (consumed.error.code === 'already_consumed') {
        logSecurityEvent('replay_attempt_get', {
          launchId: launchIdFromPath,
          clientId: identity.clientId,
          tenantId: identity.tenantId,
          consumedAt: consumed.error.details?.consumedAt
        });
      }
      sendError(res, consumed.error.status, consumed.error.code, consumed.error.message, consumed.error.details);
      return;
    }

    sendJson(res, 200, launchPayload(consumed.record));
    return;
  }

  if (req.method !== 'GET') {
    methodNotAllowed(res, ['GET']);
    return;
  }

  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    sendError(res, 500, 'internal_error', 'Unexpected server error', { message: err.message });
  });
});

const cleanupTimer = setInterval(() => {
  launchStore.purgeExpired(Date.now());
  rateLimiter.purgeExpired(Date.now());
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`Worksheet launcher server listening on http://${HOST}:${PORT}`);
});
