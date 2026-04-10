import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAuthenticatedIdentity, AuthError } from './auth.js';

test('requireAuthenticatedIdentity reads trusted headers', () => {
  const req = {
    headers: {
      'x-oidc-sub': 'sub-123',
      'x-oidc-email': 'user@example.com',
      'x-oidc-name': 'Example User',
    },
  };

  const identity = requireAuthenticatedIdentity(req, {
    sub: 'x-oidc-sub',
    email: 'x-oidc-email',
    name: 'x-oidc-name',
    nameB64: 'x-oidc-name-b64',
  });

  assert.deepEqual(identity, {
    sub: 'sub-123',
    email: 'user@example.com',
    name: 'Example User',
  });
});

test('requireAuthenticatedIdentity preserves mixed-script unicode name from base64 header', () => {
  const unicodeName = 'Cheung Chin Pang張';
  const req = {
    headers: {
      'x-oidc-sub': 'sub-123',
      'x-oidc-email': 'user@example.com',
      'x-oidc-name': 'fallback-name',
      'x-oidc-name-b64': Buffer.from(unicodeName, 'utf8').toString('base64'),
    },
  };

  const identity = requireAuthenticatedIdentity(req, {
    sub: 'x-oidc-sub',
    email: 'x-oidc-email',
    name: 'x-oidc-name',
    nameB64: 'x-oidc-name-b64',
  });

  assert.equal(identity.name, unicodeName);
  assert.equal(identity.name.includes('?'), false);
});

test('requireAuthenticatedIdentity falls back to plain name when base64 header is malformed', () => {
  const req = {
    headers: {
      'x-oidc-sub': 'sub-123',
      'x-oidc-email': 'user@example.com',
      'x-oidc-name': 'Plain Header Name',
      'x-oidc-name-b64': 'not-base64%%%$',
    },
  };

  const identity = requireAuthenticatedIdentity(req, {
    sub: 'x-oidc-sub',
    email: 'x-oidc-email',
    name: 'x-oidc-name',
    nameB64: 'x-oidc-name-b64',
  });

  assert.equal(identity.name, 'Plain Header Name');
});

test('requireAuthenticatedIdentity throws when sub header missing', () => {
  const req = { headers: {} };

  assert.throws(
    () => requireAuthenticatedIdentity(req, { sub: 'x-oidc-sub', email: 'x-oidc-email', name: 'x-oidc-name' }),
    (error) => error instanceof AuthError && error.code === 'AUTH_REQUIRED'
  );
});

test('requireAuthenticatedIdentity error message uses configured header name', () => {
  const req = { headers: {} };

  assert.throws(
    () => requireAuthenticatedIdentity(req, { sub: 'x-forwarded-custom-sub', email: 'x-email', name: 'x-name' }),
    (error) => error instanceof AuthError && error.message === 'Missing required header: X-Forwarded-Custom-Sub'
  );
});
