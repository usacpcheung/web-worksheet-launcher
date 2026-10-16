import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUploadResult, classifyProtectedUploadResult } from './upload-result.js';

const resources = [
  ['worksheet-draft', 'DRAFT_NAME_CONFLICT', 'DRAFT_SLOT_LIMIT_REACHED'],
  ['worksheet-attempt', 'ATTEMPT_NAME_CONFLICT', 'ATTEMPT_SLOT_LIMIT_REACHED'],
  ['roleplayscene-draft', 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT', 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED'],
];
for (const [resource, conflict, slot] of resources) {
  test(`${resource}: result classification retains resource data and recovery details`, () => {
    for (const [code, kind] of [[conflict, 'conflict'], [slot, 'slot_limit'], ['ABORTED', 'canceled'], ['NETWORK_ERROR', 'uncertain'], ['UPLOAD_TIMEOUT', 'uncertain'], ['AUTH_REQUIRED', 'auth_required'], ['INVALID_PACKAGE', 'failure']]) {
      const result = Object.freeze({ ok: false, operationId: 'operation', error: Object.freeze({ code: code.toLowerCase(), details: { slotLimit: 3, existingDraft: { id: 'draft' } } }) });
      const outcome = classifyUploadResult(result, resource);
      assert.equal(outcome.kind, kind);
      assert.equal(outcome.code, code);
      assert.equal(outcome.result, result);
    }
    const recovered = Object.freeze({ ok: true, recovered: true, operationId: 'operation', status: 201, data: { id: 'saved', warnings: ['warning'] } });
    assert.equal(classifyUploadResult(recovered, resource).kind, 'success');
    assert.equal(classifyUploadResult(recovered, resource).result, recovered);
    for (const [otherResource, otherConflict] of resources) {
      if (resource !== otherResource) assert.equal(classifyUploadResult({ ok: false, error: { code: otherConflict } }, resource).kind, 'failure');
    }
  });
}

test('absent/malformed results cannot imply success, auth or conflict', () => {
  for (const result of [null, undefined, false, {}, { ok: 'true' }, { status: 'executed' }, { error: { code: 'DRAFT_NAME_CONFLICT' } }]) {
    const outcome = classifyUploadResult(result, 'worksheet-draft');
    assert.equal(outcome.kind, 'failure');
    assert.equal(outcome.requiresSignIn, false);
  }
});

test('auth metadata survives transport classification without losing uncertain/canceled semantics', () => {
  for (const code of ['NETWORK_ERROR', 'UPLOAD_TIMEOUT', 'ABORTED']) {
    for (const metadata of [{ status: 401 }, { status: '403' }, { requiresSignIn: true }]) {
      for (const result of [{ ok: false, ...metadata, error: { code } }, { ok: false, error: { code, ...metadata } }]) {
        const outcome = classifyUploadResult(result, 'worksheet-attempt');
        assert.equal(outcome.kind, code === 'ABORTED' ? 'canceled' : 'uncertain');
        assert.equal(outcome.requiresSignIn, true);
        assert.equal(outcome.result, result);
      }
    }
  }
  assert.equal(classifyUploadResult({ ok: false, error: { status: 401 } }, 'worksheet-attempt').kind, 'auth_required');
  assert.equal(classifyUploadResult({ ok: false, error: { status: 503 } }, 'worksheet-attempt').requiresSignIn, false);
});

test('gate envelopes remain separate from executed upload failures', () => {
  for (const status of ['executed', 'redirected']) assert.equal(classifyProtectedUploadResult({ status }, 'worksheet-attempt').kind, status);
  for (const status of ['blocked_session_probe', 'blocked_no_local_id', 'invalid_intent', 'intent_invalid']) {
    const result = { status, result: { ok: false, error: { code: 'NETWORK_ERROR' } } };
    const outcome = classifyProtectedUploadResult(result, 'worksheet-attempt');
    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.reason, status);
    assert.equal(outcome.result, result);
  }
  for (const result of [null, undefined, {}, { ok: true }]) assert.equal(classifyProtectedUploadResult(result, 'worksheet-attempt').kind, 'blocked');
  const result = { ok: false, error: { code: 'ATTEMPT_NAME_CONFLICT' } };
  const outcome = classifyProtectedUploadResult(result, 'worksheet-attempt');
  assert.equal(outcome.kind, 'upload');
  assert.equal(outcome.outcome.kind, 'conflict');
  assert.equal(outcome.result, result);
});
