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
  });

  assert.deepEqual(identity, {
    sub: 'sub-123',
    email: 'user@example.com',
    name: 'Example User',
  });
});

test('requireAuthenticatedIdentity throws when sub header missing', () => {
  const req = { headers: {} };

  assert.throws(
    () => requireAuthenticatedIdentity(req, { sub: 'x-oidc-sub', email: 'x-oidc-email', name: 'x-oidc-name' }),
    (error) => error instanceof AuthError && error.code === 'AUTH_REQUIRED'
  );
});
