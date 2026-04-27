import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PUBLISHED_PACKAGE_LIMIT,
  fetchPublishedPackagesPage,
  mergePublishedPackageRows,
  normalizePaginationState,
  normalizePublishedPackageFilters,
  normalizePublishedPackageRow,
  normalizePublishedPackagesPagePayload,
  serializePublishedPackagesQuery,
} from './published-packages-service.js';

test('serializePublishedPackagesQuery emits canonical query shape', () => {
  const query = serializePublishedPackagesQuery({
    filters: { title: 'math', subject: 'algebra', owner: 'owner@example.test' },
    pagination: {},
  });
  assert.deepEqual(query, {
    title: 'math',
    subject: 'algebra',
    owner: 'owner@example.test',
    limit: DEFAULT_PUBLISHED_PACKAGE_LIMIT,
    offset: 0,
  });
});

test('normalizePublishedPackageRow keeps snake_case fields and falls back from camelCase', () => {
  const normalized = normalizePublishedPackageRow({
    publishedPackageId: 'pkg_1',
    title: 'Worksheet',
    publishedAt: '2026-04-01T10:00:00.000Z',
    ownerEmail: 'teacher@example.test',
    ownerName: 'Teacher',
    ownerSub: 'sub_1',
  });

  assert.equal(normalized.published_package_id, 'pkg_1');
  assert.equal(normalized.published_at, '2026-04-01T10:00:00.000Z');
  assert.equal(normalized.owner_email, 'teacher@example.test');
  assert.equal(normalized.owner_name, 'Teacher');
  assert.equal(normalized.owner_sub, 'sub_1');
});

test('normalizePublishedPackagesPagePayload normalizes items and pagination metadata', () => {
  const payload = normalizePublishedPackagesPagePayload({
    items: [{ publishedPackageId: 'pkg_2', title: 'Pkg' }],
    hasMore: true,
    nextOffset: '40',
  });

  assert.deepEqual(payload, {
    items: [{
      publishedPackageId: 'pkg_2',
      title: 'Pkg',
      published_package_id: 'pkg_2',
      subject: '',
      published_at: '',
      owner_email: '',
      owner_name: '',
      owner_sub: '',
    }],
    hasMore: true,
    nextOffset: 40,
  });
});

test('fetchPublishedPackagesPage delegates to apiClient and returns normalized success payload', async () => {
  let receivedQuery = null;
  const apiClient = {
    listPublishedPackages: async (query) => {
      receivedQuery = query;
      return {
        ok: true,
        data: {
          items: [{ publishedPackageId: 'pkg_3', title: 'Pkg 3' }],
          hasMore: false,
          nextOffset: null,
        },
      };
    },
  };

  const result = await fetchPublishedPackagesPage({
    apiClient,
    filters: normalizePublishedPackageFilters({ title: 'math' }),
    pagination: normalizePaginationState({}),
  });

  assert.deepEqual(receivedQuery, {
    title: 'math',
    subject: '',
    owner: '',
    limit: DEFAULT_PUBLISHED_PACKAGE_LIMIT,
    offset: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].published_package_id, 'pkg_3');
});

test('fetchPublishedPackagesPage preserves error result without mutation', async () => {
  const apiClient = {
    listPublishedPackages: async () => ({ ok: false, error: { message: 'boom' } }),
  };
  const result = await fetchPublishedPackagesPage({ apiClient });
  assert.deepEqual(result, { ok: false, error: { message: 'boom' } });
});

test('mergePublishedPackageRows handles replace and append modes', () => {
  assert.deepEqual(
    mergePublishedPackageRows({
      existingRows: [{ published_package_id: 'p1' }],
      incomingRows: [{ published_package_id: 'p2' }],
      append: false,
    }),
    [{ published_package_id: 'p2' }]
  );
  assert.deepEqual(
    mergePublishedPackageRows({
      existingRows: [{ published_package_id: 'p1' }],
      incomingRows: [{ published_package_id: 'p2' }],
      append: true,
    }),
    [{ published_package_id: 'p1' }, { published_package_id: 'p2' }]
  );
});
