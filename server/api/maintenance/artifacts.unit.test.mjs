import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  parseArtifactMaintenanceArgs,
  runArtifactMaintenanceCli,
} from './artifacts.js';

function outputBuffer() {
  const stream = new PassThrough();
  let value = '';
  stream.on('data', (chunk) => {
    value += chunk.toString();
  });
  return { stream, value: () => value };
}

test('CLI accepts a published ID once and parses reason and automation flags', () => {
  const options = parseArtifactMaintenanceArgs([
    'quarantine',
    'worksheet',
    '11111111-1111-4111-8111-111111111111',
    '--reason',
    'obsolete',
    '--yes',
  ]);
  assert.deepEqual(options.positional, [
    'worksheet',
    '11111111-1111-4111-8111-111111111111',
  ]);
  assert.equal(options.reason, 'obsolete');
  assert.equal(options.yes, true);
});

test('non-interactive quarantine fails before mutation unless --yes is supplied', async () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  let quarantineCalls = 0;
  const exitCode = await runArtifactMaintenanceCli({
    argv: [
      'quarantine',
      'worksheet',
      '11111111-1111-4111-8111-111111111111',
      '--reason',
      'obsolete',
    ],
    env: { USER: 'admin', DATABASE_URL: 'postgres://unused', STORAGE_ROOT: '.' },
    output: stdout.stream,
    errorOutput: stderr.stream,
    isInteractive: false,
    configLoader: () => ({ databaseUrl: 'unused', storageRoot: '.' }),
    poolFactory: () => ({ async end() {} }),
    serviceFactory: () => ({
      async inspectPublication() {
        return {
          state: 'active',
          artifactKind: 'worksheet',
          publication: {
            published_package_id: '11111111-1111-4111-8111-111111111111',
            title: 'Worksheet',
            owner_sub: 'owner',
            published_at: '2026-06-01T00:00:00.000Z',
            artifact_path: 'published/owner/a.zip',
            artifact_size_bytes: 10,
          },
        };
      },
      async quarantinePublication() {
        quarantineCalls += 1;
        return { ok: true };
      },
    }),
  });

  assert.equal(exitCode, 2);
  assert.equal(quarantineCalls, 0);
  assert.match(stderr.value(), /requires --yes/);
});

test('purge-expired is dry-run unless --apply is supplied', async () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  let applyCalls = 0;
  const exitCode = await runArtifactMaintenanceCli({
    argv: ['purge-expired'],
    env: { DATABASE_URL: 'postgres://unused', STORAGE_ROOT: '.' },
    output: stdout.stream,
    errorOutput: stderr.stream,
    isInteractive: false,
    configLoader: () => ({ databaseUrl: 'unused', storageRoot: '.' }),
    poolFactory: () => ({ async end() {} }),
    serviceFactory: () => ({
      async purgeExpired({ apply }) {
        if (apply) applyCalls += 1;
        return { applied: false, candidates: [] };
      },
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(applyCalls, 0);
  assert.match(stdout.value(), /Dry-run only/);
});

test('quarantine-orphans resumes pending moves even when there are no fresh candidates', async () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  let quarantineCalls = 0;
  const exitCode = await runArtifactMaintenanceCli({
    argv: ['quarantine-orphans', '--all', '--reason', 'resume pending', '--yes'],
    env: { USER: 'admin', DATABASE_URL: 'postgres://unused', STORAGE_ROOT: '.' },
    output: stdout.stream,
    errorOutput: stderr.stream,
    isInteractive: false,
    configLoader: () => ({ databaseUrl: 'unused', storageRoot: '.' }),
    poolFactory: () => ({ async end() {} }),
    serviceFactory: () => ({
      async audit() {
        return {
          orphaned: [],
          quarantined: [{ artifact_kind: 'orphan', status: 'pending_quarantine' }],
        };
      },
      async quarantineOrphans() {
        quarantineCalls += 1;
        return { resumed: 1, candidates: 0, results: [{ ok: true }] };
      },
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(quarantineCalls, 1);
  assert.match(stdout.value(), /quarantined or resumed: 1\/1/);
});
