import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequestHandler } from '../../server/api/server.js';
import { PackageService } from '../../server/api/services/package-service.js';
import { RolePlaySceneDraftService } from '../../server/api/services/roleplayscene-draft-service.js';
import { createServerApiClient } from '../../server/app/api/server-api-client.js';

// Exercise the real browser-client fetch fallback, HTTP routing, ZIP validation,
// PostgreSQL transaction, filesystem artifact and status response together.
export async function verifyLateCommitOverHttp({ db, store, config, spec }) {
  let enteredCommit;
  let releaseCommit;
  const ready = new Promise(resolve => { enteredCommit = resolve; });
  const proceed = new Promise(resolve => { releaseCommit = resolve; });
  const delayedDb = {
    query: (...args) => db.query(...args),
    async connect() {
      const client = await db.connect();
      return { release: () => client.release(), async query(sql, values) {
        if (sql === 'COMMIT') { enteredCommit(); await proceed; }
        return client.query(sql, values);
      } };
    },
  };
  const handler = createRequestHandler({
    service: new PackageService({ db: delayedDb, artifactStore: store, config }),
    rolePlaySceneDraftService: new RolePlaySceneDraftService({ db: delayedDb, artifactStore: store, config }),
    artifactStore: store,
    config: { ...config, authHeaders: { sub: 'x-oidc-sub', email: 'x-oidc-email', name: 'x-oidc-name' } },
  });
  const handling = [];
  const server = http.createServer((req, res) => {
    handling.push(handler(req, res));
    if (req.method === 'POST') void ready.then(() => res.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.window = { location: { origin } };
  const operationId = randomUUID();
  const identity = { sub: `http-${spec.kind}` };
  let posts = 0;
  let unknownReads = 0;
  let completedReads = 0;
  try {
    globalThis.fetch = async (url, request) => {
      if (request.method === 'POST') posts++;
      const response = await originalFetch(`${origin}${url.replace('/api/worksheet-launcher/v1', '/api/v1')}`, {
        ...request, headers: { ...request.headers, 'x-oidc-sub': identity.sub },
      });
      if (request.method === 'GET') {
        const data = (await response.clone().json()).data;
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        if (data.state === 'unknown') {
          unknownReads++;
          releaseCommit();
          await handling[0];
        } else if (data.state === 'completed') completedReads++;
      }
      return response;
    };
    const method = { 'worksheet-draft': 'uploadDraftPackage', 'worksheet-attempt': 'uploadAttemptPackage', 'roleplayscene-draft': 'uploadRolePlaySceneDraftPackage' }[spec.kind];
    const result = await createServerApiClient({ operationLookupTimeoutMs: 2000 })[method](spec.zipBytes,
      { title: 'HTTP 工作紙 + & \ud800', subject: 'Subject', description: '描述', conflictAction: 'copy' }, { operationId });
    assert.equal(result.recovered, true, JSON.stringify(result));
    assert.equal(result.data.upload_operation_id, operationId);
    assert.equal(posts, 1);
    assert.equal(unknownReads, 1);
    assert.equal(completedReads, 1);
    const rows = await db.query(`SELECT artifact_path FROM ${spec.table} WHERE owner_sub=$1`, [identity.sub]);
    assert.equal(rows.rowCount, 1);
    assert.ok(await store.statArtifact(rows.rows[0].artifact_path));
    console.log(`PASS: ${spec.kind} real HTTP reset before COMMIT, unknown status, later recovery without resend`);
  } finally {
    releaseCommit();
    globalThis.fetch = originalFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
    await Promise.all(handling);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
