import http from 'node:http';
import fs from 'node:fs/promises';
import { loadConfig } from './config.js';
import { requireAuthenticatedIdentity, AuthError } from './auth.js';
import { PackageArtifactStore } from './storage/package-artifact-store.js';
import { PackageService } from './services/package-service.js';
import { assertUuid, parseOptionalNonNegativeInt } from './validation.js';

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function ok(data) {
  return { ok: true, data };
}

function fail(code, message, details = null) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

async function readRequestBody(req, maxBytes = 30 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += part.length;
    if (total > maxBytes) {
      throw new Error('Request body too large.');
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const bytes = await readRequestBody(req);
  if (!bytes.length) return {};
  return JSON.parse(bytes.toString('utf8'));
}

function parseRoute(url) {
  const trimmed = url.pathname.replace(/\/+$/, '') || '/';
  const segments = trimmed.split('/').filter(Boolean);
  return { segments };
}

function isPublishedDetailRoute(segments) {
  return segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'published' && !!segments[3];
}

function isDraftDetailRoute(segments) {
  return segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'drafts' && !!segments[3];
}

export function createRequestHandler({ service, artifactStore, config }) {
  return async function requestHandler(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const { segments } = parseRoute(url);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return json(res, 200, ok({ status: 'ok' }));
      }

      const identity = requireAuthenticatedIdentity(req, config.authHeaders);

      if (req.method === 'GET' && url.pathname === '/api/v1/session') {
        const displayName = identity.name || identity.email || identity.sub;
        return json(
          res,
          200,
          ok({
            ready: true,
            user: {
              sub: identity.sub,
              email: identity.email,
              name: displayName,
            },
          })
        );
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/drafts/upload') {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.includes('application/zip')) {
          return json(res, 415, fail('UNSUPPORTED_MEDIA_TYPE', 'Upload draft requires Content-Type: application/zip'));
        }
        const zipBytes = await readRequestBody(req);
        const title = url.searchParams.get('title') || '';
        const subject = url.searchParams.get('subject') || '';
        const result = await service.uploadDraft({ identity, title, subject, zipBytes });
        if (!result.ok) {
          return json(res, result.statusCode, fail(result.error.code, result.error.message));
        }
        return json(res, result.statusCode, ok(result.data));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/drafts') {
        const rows = await service.listOwnDrafts(identity);
        return json(res, 200, ok({ items: rows }));
      }

      if (req.method === 'DELETE' && isDraftDetailRoute(segments)) {
        if (segments.length !== 4) {
          return json(res, 404, fail('NOT_FOUND', 'Route not found.'));
        }
        const uploadedDraftId = segments[3];
        const validatedUploadedDraftId = assertUuid(uploadedDraftId, {
          code: 'INVALID_UPLOADED_DRAFT_ID',
          message: 'uploadedDraftId must be a valid UUID.',
        });
        if (!validatedUploadedDraftId.ok) {
          return json(res, 400, fail(validatedUploadedDraftId.error.code, validatedUploadedDraftId.error.message));
        }
        const result = await service.deleteOwnDraft({
          identity,
          uploadedDraftId: validatedUploadedDraftId.value,
        });
        if (!result.ok) {
          return json(res, result.statusCode, fail(result.error.code, result.error.message));
        }
        return json(res, result.statusCode, ok(result.data));
      }

      if (req.method === 'GET' && isDraftDetailRoute(segments)) {
        if (!(segments.length === 5 && segments[4] === 'artifact')) {
          return json(res, 404, fail('NOT_FOUND', 'Route not found.'));
        }

        const uploadedDraftId = segments[3];
        const validatedUploadedDraftId = assertUuid(uploadedDraftId, {
          code: 'INVALID_UPLOADED_DRAFT_ID',
          message: 'uploadedDraftId must be a valid UUID.',
        });
        if (!validatedUploadedDraftId.ok) {
          return json(res, 400, fail(validatedUploadedDraftId.error.code, validatedUploadedDraftId.error.message));
        }

        const draft = await service.loadOwnDraftArtifact({
          identity,
          uploadedDraftId: validatedUploadedDraftId.value,
        });
        if (!draft) {
          return json(res, 404, fail('UPLOADED_DRAFT_NOT_FOUND', 'Uploaded draft was not found for this owner.'));
        }

        const zipBytes = await artifactStore.readArtifact(draft.artifact_path);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/zip');
        res.setHeader('content-length', String(zipBytes.byteLength));
        res.end(zipBytes);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/v1/published') {
        const payload = await readJsonBody(req);
        if (!payload.uploadedDraftId) {
          return json(
            res,
            400,
            fail('INVALID_REQUEST', 'publish requires uploadedDraftId in JSON body for this phase foundation.')
          );
        }

        const validatedUploadedDraftId = assertUuid(payload.uploadedDraftId, {
          code: 'INVALID_UPLOADED_DRAFT_ID',
          message: 'uploadedDraftId must be a valid UUID.',
        });
        if (!validatedUploadedDraftId.ok) {
          return json(res, 400, fail(validatedUploadedDraftId.error.code, validatedUploadedDraftId.error.message));
        }

        const title = typeof payload.title === 'string' ? payload.title : '';
        const subject = typeof payload.subject === 'string' ? payload.subject : '';
        const result = await service.publishFromDraft({
          identity,
          uploadedDraftId: validatedUploadedDraftId.value,
          title,
          subject,
        });
        if (!result.ok) {
          return json(res, result.statusCode, fail(result.error.code, result.error.message));
        }
        return json(res, result.statusCode, ok(result.data));
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/published') {
        const parsedLimit = parseOptionalNonNegativeInt(url.searchParams.get('limit'), {
          field: 'limit',
          max: config.browsePageLimitMax,
          defaultValue: config.browsePageLimitDefault,
        });
        if (!parsedLimit.ok) {
          return json(res, 400, fail(parsedLimit.error.code, parsedLimit.error.message));
        }

        const parsedOffset = parseOptionalNonNegativeInt(url.searchParams.get('offset'), {
          field: 'offset',
          max: Number.MAX_SAFE_INTEGER,
          defaultValue: 0,
        });
        if (!parsedOffset.ok) {
          return json(res, 400, fail(parsedOffset.error.code, parsedOffset.error.message));
        }

        const rows = await service.listPublished({
          query: url.searchParams.get('q') || '',
          title: url.searchParams.get('title') || '',
          subject: url.searchParams.get('subject') || '',
          owner: url.searchParams.get('owner') || '',
          limit: parsedLimit.value,
          offset: parsedOffset.value,
        });

        return json(res, 200, ok({ items: rows }));
      }

      if (req.method === 'GET' && isPublishedDetailRoute(segments)) {
        if (!(segments.length === 4 || (segments.length === 5 && segments[4] === 'artifact'))) {
          return json(res, 404, fail('NOT_FOUND', 'Route not found.'));
        }

        const publishedPackageId = segments[3];
        const validatedPublishedPackageId = assertUuid(publishedPackageId, {
          code: 'INVALID_PUBLISHED_PACKAGE_ID',
          message: 'publishedPackageId must be a valid UUID.',
        });
        if (!validatedPublishedPackageId.ok) {
          return json(res, 400, fail(validatedPublishedPackageId.error.code, validatedPublishedPackageId.error.message));
        }

        const row = await service.loadPublishedPackage(validatedPublishedPackageId.value);
        if (!row) {
          return json(res, 404, fail('PUBLISHED_PACKAGE_NOT_FOUND', 'Published package was not found.'));
        }

        if (segments[4] === 'artifact') {
          const zipBytes = await artifactStore.readArtifact(row.artifact_path);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/zip');
          res.setHeader('content-length', String(zipBytes.byteLength));
          res.end(zipBytes);
          return;
        }

        return json(
          res,
          200,
          ok({
            publishedPackageId: row.published_package_id,
            ownerSub: row.owner_sub,
            title: row.title,
            subject: row.subject,
            artifactSha256: row.artifact_sha256,
            artifactSizeBytes: row.artifact_size_bytes,
            publishedAt: row.published_at,
          })
        );
      }

      return json(res, 404, fail('NOT_FOUND', 'Route not found.'));
    } catch (error) {
      if (error instanceof AuthError) {
        return json(res, error.statusCode, fail(error.code, error.message));
      }
      if (error instanceof SyntaxError) {
        return json(res, 400, fail('INVALID_JSON', 'Malformed JSON body.'));
      }
      // eslint-disable-next-line no-console
      console.error(error);
      const message = config.nodeEnv === 'development' ? error.message || 'Unexpected server error.' : 'Unexpected server error.';
      return json(res, 500, fail('INTERNAL_ERROR', message));
    }
  };
}

export async function createApiServer(overrides = {}) {
  const config = overrides.config || loadConfig();
  await fs.mkdir(config.storageRoot, { recursive: true });

  let db = overrides.db;
  if (!db) {
    const { createPool } = await import('./db/pool.js');
    db = createPool(config);
  }
  const artifactStore = overrides.artifactStore || new PackageArtifactStore({ storageRoot: config.storageRoot });
  const service = overrides.service || new PackageService({ db, artifactStore, config });

  const server = http.createServer(createRequestHandler({ service, artifactStore, config }));

  return {
    config,
    server,
    async close() {
      await db.end();
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createApiServer()
    .then(({ server, config }) => {
      server.listen(config.port, () => {
        // eslint-disable-next-line no-console
        console.log(`API listening on http://127.0.0.1:${config.port}`);
      });
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exitCode = 1;
    });
}
