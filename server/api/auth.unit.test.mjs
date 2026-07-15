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

test('requireAuthenticatedIdentity error message uses configured header name', () => {
  const req = { headers: {} };

  assert.throws(
    () => requireAuthenticatedIdentity(req, { sub: 'x-forwarded-custom-sub', email: 'x-email', name: 'x-name' }),
    (error) => error instanceof AuthError && error.message === 'Missing required header: X-Forwarded-Custom-Sub'
  );
});

test('requireAuthenticatedIdentity rejects missing trusted proxy secret before OIDC headers', () => {
  const req = {
    headers: {
      'x-oidc-sub': 'spoofed-user',
    },
  };

  assert.throws(
    () => requireAuthenticatedIdentity(
      req,
      { sub: 'x-oidc-sub', email: 'x-oidc-email', name: 'x-oidc-name' },
      { secret: 'expected-secret', secretHeader: 'x-worksheet-proxy-secret' }
    ),
    (error) => error instanceof AuthError
      && error.code === 'AUTH_REQUIRED'
      && error.message === 'Missing or invalid trusted proxy secret.'
  );
});

test('requireAuthenticatedIdentity rejects wrong trusted proxy secret', () => {
  const req = {
    headers: {
      'x-worksheet-proxy-secret': 'wrong-secret',
      'x-oidc-sub': 'user-sub',
    },
  };

  assert.throws(
    () => requireAuthenticatedIdentity(
      req,
      { sub: 'x-oidc-sub', email: 'x-oidc-email', name: 'x-oidc-name' },
      { secret: 'expected-secret', secretHeader: 'x-worksheet-proxy-secret' }
    ),
    (error) => error instanceof AuthError && error.code === 'AUTH_REQUIRED'
  );
});

test('requireAuthenticatedIdentity accepts correct trusted proxy secret plus OIDC headers', () => {
  const req = {
    headers: {
      'x-worksheet-proxy-secret': 'expected-secret',
      'x-oidc-sub': 'user-sub',
      'x-oidc-email': 'user@example.com',
    },
  };

  const identity = requireAuthenticatedIdentity(
    req,
    { sub: 'x-oidc-sub', email: 'x-oidc-email', name: 'x-oidc-name' },
    { secret: 'expected-secret', secretHeader: 'x-worksheet-proxy-secret' }
  );

  assert.deepEqual(identity, {
    sub: 'user-sub',
    email: 'user@example.com',
    name: null,
  });
});
