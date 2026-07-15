import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

function createEnv(overrides = {}) {
  return {
    DATABASE_URL: 'postgres://example.test/worksheet',
    STORAGE_ROOT: 'C:\\tmp\\worksheet-storage',
    ...overrides,
  };
}

test('loadConfig defaults API host to loopback without trusted proxy secret', () => {
  const config = loadConfig(createEnv());

  assert.equal(config.host, '127.0.0.1');
  assert.deepEqual(config.trustedProxy, {
    secret: null,
    secretHeader: 'x-worksheet-proxy-secret',
  });
});

test('loadConfig allows trusted proxy secret and custom header from env', () => {
  const config = loadConfig(createEnv({
    TRUSTED_PROXY_SECRET: 'long-random-secret',
    TRUSTED_PROXY_SECRET_HEADER: 'X-Custom-Proxy-Secret',
  }));

  assert.deepEqual(config.trustedProxy, {
    secret: 'long-random-secret',
    secretHeader: 'x-custom-proxy-secret',
  });
});

test('loadConfig rejects non-loopback HOST without trusted proxy secret', () => {
  assert.throws(
    () => loadConfig(createEnv({ HOST: '0.0.0.0' })),
    /TRUSTED_PROXY_SECRET is required when HOST is not loopback/
  );
});

test('loadConfig allows non-loopback HOST when trusted proxy secret is configured', () => {
  const config = loadConfig(createEnv({
    HOST: '0.0.0.0',
    TRUSTED_PROXY_SECRET: 'long-random-secret',
  }));

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.trustedProxy.secret, 'long-random-secret');
});

test('loadConfig exposes default RolePlayScene package resource limits', () => {
  const config = loadConfig(createEnv());

  assert.deepEqual(config.rolePlayScenePackageLimits, {
    maxUncompressedBytes: 67108864,
    maxEntryBytes: 33554432,
    maxEntries: 200,
    maxEntryNameLength: 512,
  });
});

test('loadConfig allows RolePlayScene package resource limits from env', () => {
  const config = loadConfig(createEnv({
    ROLEPLAYSCENE_PACKAGE_MAX_UNCOMPRESSED_BYTES: '104857600',
    ROLEPLAYSCENE_PACKAGE_MAX_ENTRY_BYTES: '52428800',
    ROLEPLAYSCENE_PACKAGE_MAX_ENTRIES: '300',
    ROLEPLAYSCENE_PACKAGE_MAX_ENTRY_NAME_LENGTH: '768',
  }));

  assert.deepEqual(config.rolePlayScenePackageLimits, {
    maxUncompressedBytes: 104857600,
    maxEntryBytes: 52428800,
    maxEntries: 300,
    maxEntryNameLength: 768,
  });
});

test('loadConfig rejects invalid RolePlayScene package resource limits', () => {
  assert.throws(
    () => loadConfig(createEnv({
      ROLEPLAYSCENE_PACKAGE_MAX_UNCOMPRESSED_BYTES: '0',
    })),
    /Invalid ROLEPLAYSCENE_PACKAGE_MAX_UNCOMPRESSED_BYTES value: 0/
  );
});
