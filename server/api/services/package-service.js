import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { parseWorksheetPackage, rewriteWorksheetPackageTitle } from '../../editor/worksheet-package.js';

function normalizeText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeConflictText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeUploadConflictAction(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'replace' || normalized === 'copy') return normalized;
  return 'fail_on_conflict';
}

function validateUploadedWorksheetPackage(zipBytes) {
  try {
    parseWorksheetPackage(zipBytes);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'INVALID_WORKSHEET_PACKAGE',
        message: 'Uploaded worksheet package is invalid or corrupted.',
        details: {
          reason: error?.message || 'Package validation failed.',
        },
      },
    };
  }
}

function stripGeneratedCopySuffix(title) {
  const normalizedTitle = normalizeText(title, 'Untitled draft');
  const match = normalizedTitle.match(/^(.*)\s\((\d+)\)$/);
  if (!match) return normalizedTitle;
  const copyIndex = Number(match[2]);
  const baseTitle = normalizeText(match[1], '');
  return copyIndex >= 2 && baseTitle ? baseTitle : normalizedTitle;
}

async function deleteArtifactIfPresent(artifact) {
  if (!artifact?.absolutePath) return;
  try {
    await fs.unlink(artifact.absolutePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function deleteArtifactBestEffort({ artifactStore, artifactPath }) {
  if (!artifactPath) return;
  try {
    await deleteArtifactIfPresent({
      absolutePath: artifactStore.resolveAbsolutePath(artifactPath),
    });
  } catch (error) {
    console.warn('Failed to cleanup deleted uploaded draft artifact.', {
      artifactPath,
      code: error?.code,
      message: error?.message,
    });
  }
}

export class PackageService {
  constructor({ db, artifactStore, config }) {
    this.db = db;
    this.artifactStore = artifactStore;
    this.config = config;
  }

  async listOwnDrafts(identity, clientOverride = null) {
    const executor = clientOverride || this.db;
    const result = await executor.query(
      `SELECT
        d.uploaded_draft_id,
        d.owner_sub,
        d.owner_email,
        d.owner_name,
        d.title,
        d.subject,
        d.artifact_sha256,
        d.artifact_size_bytes,
        d.last_published_artifact_sha256,
        d.last_published_at,
        CASE
          WHEN d.last_published_artifact_sha256 IS NULL THEN 'draft_only'
          WHEN d.artifact_sha256 = d.last_published_artifact_sha256 THEN 'current_version_published'
          ELSE 'unpublished_changes'
        END AS publish_state,
        d.created_at,
        d.updated_at,
        p.published_package_id,
        p.title AS published_title,
        p.subject AS published_subject,
        p.owner_email AS published_owner_email,
        p.owner_name AS published_owner_name,
        p.published_at
       FROM uploaded_drafts d
       LEFT JOIN LATERAL (
         SELECT
           published_package_id,
           title,
           subject,
           owner_email,
           owner_name,
           published_at
         FROM published_packages
         WHERE source_uploaded_draft_id = d.uploaded_draft_id
          ORDER BY published_at DESC, created_at DESC, published_package_id DESC
         LIMIT 1
       ) p ON TRUE
       WHERE d.owner_sub = $1
       ORDER BY d.created_at DESC`,
      [identity.sub]
    );

    return result.rows;
  }

  async findUploadConflict({ client, identity, title, subject }) {
    const result = await client.query(
      `SELECT
        d.uploaded_draft_id,
        d.owner_sub,
        d.owner_email,
        d.owner_name,
        d.title,
        d.subject,
        d.artifact_path,
        d.artifact_sha256,
        d.artifact_size_bytes,
        d.created_at,
        d.updated_at,
        p.published_package_id,
        p.published_at
       FROM uploaded_drafts d
       LEFT JOIN published_packages p
         ON p.source_uploaded_draft_id = d.uploaded_draft_id
       WHERE d.owner_sub = $1
         AND lower(regexp_replace(btrim(coalesce(d.title, '')), '\\s+', ' ', 'g')) = $2
         AND lower(regexp_replace(btrim(coalesce(d.subject, '')), '\\s+', ' ', 'g')) = $3
       ORDER BY d.created_at DESC
       LIMIT 1`,
      [identity.sub, normalizeConflictText(title), normalizeConflictText(subject)]
    );
    return result.rows[0] || null;
  }

  async createUploadedDraftRow({ client, identity, title, subject, artifact, uploadedDraftId = crypto.randomUUID() }) {
    if (!artifact) {
      throw new Error('createUploadedDraftRow requires a stored artifact.');
    }
    const row = await client.query(
      `INSERT INTO uploaded_drafts(
        uploaded_draft_id,
        owner_sub,
        owner_email,
        owner_name,
        title,
        subject,
        artifact_path,
        artifact_sha256,
        artifact_size_bytes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING uploaded_draft_id, owner_sub, owner_email, owner_name, title, subject, artifact_sha256, artifact_size_bytes, last_published_artifact_sha256, last_published_at, created_at, updated_at`,
      [
        uploadedDraftId,
        identity.sub,
        identity.email,
        identity.name,
        normalizeText(title, 'Untitled draft'),
        normalizeText(subject, ''),
        artifact.artifactPath,
        artifact.artifactSha256,
        artifact.artifactSizeBytes,
      ]
    );
    return row.rows[0];
  }

  async createDraftArtifact({ identity, uploadedDraftId, zipBytes }) {
    return this.artifactStore.storeArtifact({
      ownerSub: identity.sub,
      bucket: 'drafts',
      artifactId: uploadedDraftId,
      bytes: zipBytes,
    });
  }

  async findAvailableCopyTitle({ client, identity, title, subject }) {
    const baseTitle = stripGeneratedCopySuffix(title);
    for (let copyIndex = 2; copyIndex < 1000; copyIndex += 1) {
      const candidate = `${baseTitle} (${copyIndex})`;
      const existing = await this.findUploadConflict({ client, identity, title: candidate, subject });
      if (!existing) return candidate;
    }
    return `${baseTitle} (${crypto.randomUUID().slice(0, 8)})`;
  }

  async uploadDraft({ identity, title, subject, zipBytes, conflictAction = 'fail_on_conflict' }) {
    const packageValidation = validateUploadedWorksheetPackage(zipBytes);
    if (!packageValidation.ok) {
      return {
        ok: false,
        statusCode: 400,
        error: packageValidation.error,
      };
    }

    const client = await this.db.connect();
    let artifact = null;
    const cleanupArtifactPathsAfterCommit = [];
    const action = normalizeUploadConflictAction(conflictAction);
    const normalizedTitle = normalizeText(title, 'Untitled draft');
    const normalizedSubject = normalizeText(subject, '');

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identity.sub]);
      const conflict = await this.findUploadConflict({
        client,
        identity,
        title: normalizedTitle,
        subject: normalizedSubject,
      });

      if (conflict && action === 'fail_on_conflict') {
        const drafts = await this.listOwnDrafts(identity, client);
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 409,
          error: {
            code: 'DRAFT_NAME_CONFLICT',
            message: 'An uploaded draft with the same worksheet name and subject already exists.',
            details: {
              existingDraft: conflict,
              uploadedDrafts: drafts,
            },
          },
        };
      }

      if (conflict && action === 'replace') {
        const replacementId = crypto.randomUUID();
        artifact = await this.createDraftArtifact({ identity, uploadedDraftId: replacementId, zipBytes });
        if (conflict.published_package_id) {
          const deleted = await client.query(
            `DELETE FROM uploaded_drafts
             WHERE uploaded_draft_id = $1 AND owner_sub = $2
             RETURNING uploaded_draft_id, artifact_path`,
            [conflict.uploaded_draft_id, identity.sub]
          );
          if (deleted.rowCount > 0) {
            cleanupArtifactPathsAfterCommit.push(deleted.rows[0].artifact_path);
          }
          const row = await this.createUploadedDraftRow({
            client,
            identity,
            title: normalizedTitle,
            subject: normalizedSubject,
            artifact,
            uploadedDraftId: replacementId,
          });
          await client.query('COMMIT');
          for (const artifactPath of cleanupArtifactPathsAfterCommit) {
            await deleteArtifactBestEffort({ artifactStore: this.artifactStore, artifactPath });
          }
          artifact = null;
          return { ok: true, statusCode: 201, data: { ...row, replaced_uploaded_draft_id: conflict.uploaded_draft_id } };
        }

        const updated = await client.query(
          `UPDATE uploaded_drafts
           SET owner_email = $3,
               owner_name = $4,
               title = $5,
               subject = $6,
               artifact_path = $7,
               artifact_sha256 = $8,
               artifact_size_bytes = $9,
               updated_at = now()
           WHERE uploaded_draft_id = $1 AND owner_sub = $2
           RETURNING uploaded_draft_id, owner_sub, owner_email, owner_name, title, subject, artifact_sha256, artifact_size_bytes, last_published_artifact_sha256, last_published_at, created_at, updated_at`,
          [
            conflict.uploaded_draft_id,
            identity.sub,
            identity.email,
            identity.name,
            normalizedTitle,
            normalizedSubject,
            artifact.artifactPath,
            artifact.artifactSha256,
            artifact.artifactSizeBytes,
          ]
        );
        cleanupArtifactPathsAfterCommit.push(conflict.artifact_path);
        await client.query('COMMIT');
        for (const artifactPath of cleanupArtifactPathsAfterCommit) {
          await deleteArtifactBestEffort({ artifactStore: this.artifactStore, artifactPath });
        }
        artifact = null;
        return { ok: true, statusCode: 200, data: { ...updated.rows[0], replaced_uploaded_draft_id: conflict.uploaded_draft_id } };
      }

      const countRes = await client.query('SELECT COUNT(*)::int AS count FROM uploaded_drafts WHERE owner_sub = $1', [
        identity.sub,
      ]);
      if (countRes.rows[0].count >= this.config.draftSlotLimit) {
        const drafts = await this.listOwnDrafts(identity, client);
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 409,
          error: {
            code: 'DRAFT_SLOT_LIMIT_REACHED',
            message: `You already have ${this.config.draftSlotLimit} uploaded drafts. Delete one before uploading another.`,
            details: {
              uploadedDrafts: drafts,
            },
          },
        };
      }

      const finalTitle = action === 'copy' && conflict
        ? await this.findAvailableCopyTitle({ client, identity, title: normalizedTitle, subject: normalizedSubject })
        : normalizedTitle;
      const uploadedDraftId = crypto.randomUUID();
      const storedZipBytes = finalTitle !== normalizedTitle
        ? Buffer.from(rewriteWorksheetPackageTitle(zipBytes, finalTitle))
        : zipBytes;
      artifact = await this.createDraftArtifact({ identity, uploadedDraftId, zipBytes: storedZipBytes });

      const row = await client.query(
        `INSERT INTO uploaded_drafts(
          uploaded_draft_id,
          owner_sub,
          owner_email,
          owner_name,
          title,
          subject,
          artifact_path,
          artifact_sha256,
          artifact_size_bytes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING uploaded_draft_id, owner_sub, owner_email, owner_name, title, subject, artifact_sha256, artifact_size_bytes, last_published_artifact_sha256, last_published_at, created_at, updated_at`,
        [
          uploadedDraftId,
          identity.sub,
          identity.email,
          identity.name,
          finalTitle,
          normalizedSubject,
          artifact.artifactPath,
          artifact.artifactSha256,
          artifact.artifactSizeBytes,
        ]
      );

      await client.query('COMMIT');
      artifact = null;
      return { ok: true, statusCode: 201, data: row.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await deleteArtifactIfPresent(artifact);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadOwnDraftArtifact({ identity, uploadedDraftId }) {
    const result = await this.db.query(
      `SELECT uploaded_draft_id, owner_sub, artifact_path
       FROM uploaded_drafts
       WHERE uploaded_draft_id = $1 AND owner_sub = $2`,
      [uploadedDraftId, identity.sub]
    );

    if (result.rowCount === 0) {
      return null;
    }
    return result.rows[0];
  }

  async deleteOwnDraft({ identity, uploadedDraftId }) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query(
        `DELETE FROM uploaded_drafts
         WHERE uploaded_draft_id = $1 AND owner_sub = $2
         RETURNING uploaded_draft_id, artifact_path`,
        [uploadedDraftId, identity.sub]
      );

      if (deleted.rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 404,
          error: {
            code: 'UPLOADED_DRAFT_NOT_FOUND',
            message: 'Uploaded draft was not found for this owner.',
          },
        };
      }

      await client.query('COMMIT');

      const deletedDraft = deleted.rows[0];
      await deleteArtifactBestEffort({
        artifactStore: this.artifactStore,
        artifactPath: deletedDraft.artifact_path,
      });

      return {
        ok: true,
        statusCode: 200,
        data: {
          uploaded_draft_id: deletedDraft.uploaded_draft_id,
          deleted: true,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteOwnPublishedPackage({ identity, publishedPackageId }) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identity.sub]);

      const publishedPackageRes = await client.query(
        `SELECT published_package_id, artifact_path, source_uploaded_draft_id
         FROM published_packages
         WHERE published_package_id = $1 AND owner_sub = $2`,
        [publishedPackageId, identity.sub]
      );

      if (publishedPackageRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 404,
          error: {
            code: 'PUBLISHED_PACKAGE_NOT_FOUND',
            message: 'Published package was not found for this owner.',
          },
        };
      }

      const publishedPackage = publishedPackageRes.rows[0];
      if (publishedPackage.source_uploaded_draft_id) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`publish:${publishedPackage.source_uploaded_draft_id}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`publish-owner:${identity.sub}`]);
        await client.query(
          `SELECT uploaded_draft_id
           FROM uploaded_drafts
           WHERE uploaded_draft_id = $1 AND owner_sub = $2
           FOR UPDATE`,
          [publishedPackage.source_uploaded_draft_id, identity.sub]
        );
      }

      const deleted = await client.query(
        `DELETE FROM published_packages
         WHERE published_package_id = $1 AND owner_sub = $2
         RETURNING published_package_id, artifact_path, source_uploaded_draft_id`,
        [publishedPackageId, identity.sub]
      );

      if (deleted.rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 404,
          error: {
            code: 'PUBLISHED_PACKAGE_NOT_FOUND',
            message: 'Published package was not found for this owner.',
          },
        };
      }

      const deletedPackage = deleted.rows[0];
      if (deletedPackage.source_uploaded_draft_id) {
        const latestPublishedForDraft = await client.query(
          `SELECT artifact_sha256, published_at
           FROM published_packages
           WHERE source_uploaded_draft_id = $1 AND owner_sub = $2
           ORDER BY published_at DESC, created_at DESC, published_package_id DESC
           LIMIT 1`,
          [deletedPackage.source_uploaded_draft_id, identity.sub]
        );

        if (latestPublishedForDraft.rowCount > 0) {
          const latest = latestPublishedForDraft.rows[0];
          await client.query(
            `UPDATE uploaded_drafts
             SET last_published_artifact_sha256 = $3,
                 last_published_at = $4,
                 updated_at = now()
             WHERE uploaded_draft_id = $1 AND owner_sub = $2`,
            [deletedPackage.source_uploaded_draft_id, identity.sub, latest.artifact_sha256, latest.published_at]
          );
        } else {
          await client.query(
            `UPDATE uploaded_drafts
             SET last_published_artifact_sha256 = NULL,
                 last_published_at = NULL,
                 updated_at = now()
             WHERE uploaded_draft_id = $1 AND owner_sub = $2`,
            [deletedPackage.source_uploaded_draft_id, identity.sub]
          );
        }
      }

      await client.query('COMMIT');
      await deleteArtifactBestEffort({
        artifactStore: this.artifactStore,
        artifactPath: deletedPackage.artifact_path,
      });

      return {
        ok: true,
        statusCode: 200,
        data: {
          published_package_id: deletedPackage.published_package_id,
          deleted: true,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async publishFromDraft({ identity, uploadedDraftId, title = '', subject = '' }) {
    const client = await this.db.connect();
    let artifact = null;

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identity.sub]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`publish:${uploadedDraftId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`publish-owner:${identity.sub}`]);
      const draftRes = await client.query(
        `SELECT uploaded_draft_id, owner_sub, title, subject, artifact_path, artifact_sha256, artifact_size_bytes, last_published_artifact_sha256
         FROM uploaded_drafts
         WHERE uploaded_draft_id = $1 AND owner_sub = $2
         FOR UPDATE`,
        [uploadedDraftId, identity.sub]
      );

      if (draftRes.rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 404,
          error: {
            code: 'UPLOADED_DRAFT_NOT_FOUND',
            message: 'Uploaded draft was not found for this owner.',
          },
        };
      }

      const draft = draftRes.rows[0];

      if (
        normalizeText(draft.artifact_sha256, '') &&
        draft.artifact_sha256 === draft.last_published_artifact_sha256
      ) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 409,
          error: {
            code: 'DRAFT_ARTIFACT_ALREADY_PUBLISHED',
            message: 'This uploaded draft artifact has already been published.',
            details: {
              uploadedDraftId: draft.uploaded_draft_id,
              artifactSha256: draft.artifact_sha256,
            },
          },
        };
      }

      const normalizedPublishedTitle = normalizeText(title, draft.title);
      const normalizedPublishedSubject = normalizeText(subject, draft.subject || '');
      const existingConflictRes = await client.query(
        `SELECT
          published_package_id,
          title,
          subject,
          owner_sub,
          owner_email,
          owner_name,
          published_at,
          source_uploaded_draft_id
         FROM published_packages
         WHERE owner_sub = $1
           AND lower(regexp_replace(btrim(coalesce(title, '')), '\\s+', ' ', 'g')) = $2
           AND lower(regexp_replace(btrim(coalesce(subject, '')), '\\s+', ' ', 'g')) = $3
         ORDER BY published_at DESC, created_at DESC, published_package_id DESC
         LIMIT 1`,
        [identity.sub, normalizeConflictText(normalizedPublishedTitle), normalizeConflictText(normalizedPublishedSubject)]
      );

      if (existingConflictRes.rowCount > 0) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 409,
          error: {
            code: 'PUBLISHED_PACKAGE_CONFLICT',
            message: 'A published package with this worksheet name and subject already exists.',
            details: {
              existingPackage: existingConflictRes.rows[0],
              requestedTitle: normalizedPublishedTitle,
              requestedSubject: normalizedPublishedSubject,
            },
          },
        };
      }

      const bytes = await this.artifactStore.readArtifact(draft.artifact_path);
      const publishedPackageId = crypto.randomUUID();
      artifact = await this.artifactStore.storeArtifact({
        ownerSub: identity.sub,
        bucket: 'published',
        artifactId: publishedPackageId,
        bytes,
      });

      const publishedRes = await client.query(
        `INSERT INTO published_packages(
          published_package_id,
          owner_sub,
          owner_email,
          owner_name,
          source_uploaded_draft_id,
          title,
          subject,
          artifact_path,
          artifact_sha256,
          artifact_size_bytes
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING published_package_id, title, subject, artifact_sha256, artifact_size_bytes, published_at, source_uploaded_draft_id, owner_email, owner_name`,
        [
          publishedPackageId,
          identity.sub,
          identity.email,
          identity.name,
          draft.uploaded_draft_id,
          normalizedPublishedTitle,
          normalizedPublishedSubject,
          artifact.artifactPath,
          artifact.artifactSha256,
          artifact.artifactSizeBytes,
        ]
      );
      await client.query(
        `UPDATE uploaded_drafts
         SET last_published_artifact_sha256 = $2,
             last_published_at = now(),
             updated_at = now()
         WHERE uploaded_draft_id = $1 AND owner_sub = $3`,
        [draft.uploaded_draft_id, draft.artifact_sha256, identity.sub]
      );

      await client.query('COMMIT');
      artifact = null;
      return { ok: true, statusCode: 201, data: publishedRes.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await deleteArtifactIfPresent(artifact);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadPublishedPackage(publishedPackageId) {
    const result = await this.db.query(
      `SELECT published_package_id, owner_sub, title, subject, artifact_sha256, artifact_size_bytes, published_at, artifact_path
       FROM published_packages
       WHERE published_package_id = $1`,
      [publishedPackageId]
    );

    if (result.rowCount === 0) {
      return null;
    }
    return result.rows[0];
  }

  async listPublished({ query = '', title, subject, owner, limit, offset }) {
    const values = [];
    const clauses = [];

    if (query) {
      values.push(`%${query.toLowerCase()}%`);
      clauses.push(
        `(lower(title) LIKE $${values.length} OR lower(subject) LIKE $${values.length} OR lower(owner_email) LIKE $${values.length} OR lower(owner_name) LIKE $${values.length})`
      );
    }

    if (title) {
      values.push(`%${title.toLowerCase()}%`);
      clauses.push(`lower(title) LIKE $${values.length}`);
    }

    if (subject) {
      values.push(`%${subject.toLowerCase()}%`);
      clauses.push(`lower(subject) LIKE $${values.length}`);
    }

    if (owner) {
      values.push(`%${owner.toLowerCase()}%`);
      clauses.push(`(lower(owner_email) LIKE $${values.length} OR lower(owner_name) LIKE $${values.length})`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(limit + 1);
    const limitPlaceholder = `$${values.length}`;
    values.push(offset);
    const offsetPlaceholder = `$${values.length}`;

    const sql = `SELECT published_package_id, title, subject, owner_sub, owner_email, owner_name, artifact_sha256, artifact_size_bytes, published_at
      FROM published_packages
      ${where}
      ORDER BY published_at DESC
      LIMIT ${limitPlaceholder}
      OFFSET ${offsetPlaceholder}`;

    const result = await this.db.query(sql, values);
    const hasMore = result.rows.length > limit;
    const items = hasMore ? result.rows.slice(0, limit) : result.rows;
    return {
      items,
      limit,
      offset,
      hasMore,
      ...(hasMore ? { nextOffset: offset + items.length } : {}),
    };
  }
}
