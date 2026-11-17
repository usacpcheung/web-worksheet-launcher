import test from 'node:test';
import assert from 'node:assert/strict';
import * as mod from './uploaded-drafts-view.js';
import { t } from '../app/i18n/index.js';

test('formatUploadedDraftTimestamp uses local browser formatting and handles invalid timestamps', async () => {
  const originalFormatter = Intl.DateTimeFormat;
  const calls = [];

  Intl.DateTimeFormat = function fakeDateTimeFormat(locale, options) {
    calls.push({ locale, options });
    return {
      format(value) {
        const iso = value instanceof Date ? value.toISOString() : String(value);
        return `LOCAL(${iso})`;
      },
    };
  };

  try {
    const formatted = mod.formatUploadedDraftTimestamp('2026-04-07T15:42:00.000Z');
    assert.equal(formatted.startsWith('LOCAL('), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    assert.equal(mod.formatUploadedDraftTimestamp('not-a-date'), t('common.values.unknownUploadTime'));
    assert.equal(mod.formatUploadedDraftTimestamp(''), t('common.values.unknownUploadTime'));
  } finally {
    Intl.DateTimeFormat = originalFormatter;
  }
});

test('uploaded draft publish badge labels distinguish live and deleted published packages', async () => {
  assert.equal(
    mod.getUploadedDraftPublishBadge({ publish_state: 'draft_only' }).text,
    t('editor.uploadedDraft.publishBadge.notPublished')
  );
  assert.equal(
    mod.getUploadedDraftPublishBadge({
      publish_state: 'current_version_published',
      published_package_id: 'p-live',
    }).text,
    t('editor.uploadedDraft.publishBadge.live')
  );
  assert.equal(
    mod.getUploadedDraftPublishBadge({
      publish_state: 'current_version_published',
      published_package_id: '',
    }).text,
    t('editor.uploadedDraft.publishBadge.deleted')
  );
  assert.equal(
    mod.getUploadedDraftPublishBadge({ publish_state: 'unpublished_changes' }).text,
    t('editor.uploadedDraft.publishBadge.updated')
  );
  assert.equal(
    mod.getUploadedDraftPublishBadge({
      artifact_sha256: 'sha',
      last_published_artifact_sha256: 'sha',
    }).text,
    t('editor.uploadedDraft.publishBadge.deleted')
  );
});

test('toUploadedDraftDisplay includes fallback title and uploaded label', async () => {
  const originalFormatter = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function fakeDateTimeFormat() {
    return {
      format() {
        return 'Apr 7, 2026, 3:42 PM';
      },
    };
  };
  try {
    const withTitle = mod.toUploadedDraftDisplay({
      title: '  Algebra worksheet  ',
      created_at: '2026-04-07T15:42:00.000Z',
    });
    assert.equal(withTitle.title, 'Algebra worksheet');
    assert.equal(withTitle.uploadedLabel, t('common.meta.uploaded', { value: 'Apr 7, 2026, 3:42 PM' }));

    const untitled = mod.toUploadedDraftDisplay({
      title: '',
      created_at: '',
    });
    assert.equal(untitled.title, t('common.values.untitled'));
    assert.equal(untitled.uploadedLabel, t('common.meta.uploaded', { value: t('common.values.unknownUploadTime') }));
  } finally {
    Intl.DateTimeFormat = originalFormatter;
  }
});
