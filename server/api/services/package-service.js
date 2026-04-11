import crypto from 'node:crypto';
import fs from 'node:fs/promises';

function normalizeText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
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

  async uploadDraft({ identity, title, subject, zipBytes }) {
    const client = await this.db.connect();
    let artifact = null;

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identity.sub]);
      const countRes = await client.query('SELECT COUNT(*)::int AS count FROM uploaded_drafts WHERE owner_sub = $1', [
        identity.sub,
      ]);
      if (countRes.rows[0].count >= this.config.draftSlotLimit) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 409,
          error: {
            code: 'DRAFT_SLOT_LIMIT_REACHED',
            message: `You already have ${this.config.draftSlotLimit} uploaded drafts. Delete one before uploading another.`,
          },
        };
      }

      const uploadedDraftId = crypto.randomUUID();
      artifact = await this.artifactStore.storeArtifact({
        ownerSub: identity.sub,
        bucket: 'drafts',
        artifactId: uploadedDraftId,
        bytes: zipBytes,
      });

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
        RETURNING uploaded_draft_id, owner_sub, title, subject, artifact_sha256, artifact_size_bytes, created_at`,
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

  async listOwnDrafts(identity) {
    const result = await this.db.query(
      `SELECT
        d.uploaded_draft_id,
        d.title,
        d.subject,
        d.artifact_sha256,
        d.artifact_size_bytes,
        d.created_at,
        d.updated_at,
        p.published_package_id,
        p.title AS published_title,
        p.subject AS published_subject,
        p.owner_email AS published_owner_email,
        p.owner_name AS published_owner_name,
        p.published_at
       FROM uploaded_drafts d
       LEFT JOIN published_packages p
         ON p.source_uploaded_draft_id = d.uploaded_draft_id
       WHERE d.owner_sub = $1
       ORDER BY d.created_at DESC`,
      [identity.sub]
    );

    return result.rows;
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

  async publishFromDraft({ identity, uploadedDraftId, title = '', subject = '' }) {
    const client = await this.db.connect();
    let artifact = null;

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`publish:${uploadedDraftId}`]);
      const draftRes = await client.query(
        `SELECT uploaded_draft_id, owner_sub, title, subject, artifact_path, artifact_sha256, artifact_size_bytes
         FROM uploaded_drafts
         WHERE uploaded_draft_id = $1 AND owner_sub = $2`,
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
      const existingRes = await client.query(
        `SELECT published_package_id, title, subject, artifact_sha256, artifact_size_bytes, published_at, source_uploaded_draft_id, owner_email, owner_name
         FROM published_packages
         WHERE source_uploaded_draft_id = $1 AND owner_sub = $2
         ORDER BY published_at DESC
         LIMIT 1`,
        [draft.uploaded_draft_id, identity.sub]
      );
      if (existingRes.rowCount > 0) {
        await client.query('COMMIT');
        return { ok: true, statusCode: 200, data: existingRes.rows[0] };
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
          normalizeText(title, draft.title),
          normalizeText(subject, draft.subject || ''),
          artifact.artifactPath,
          artifact.artifactSha256,
          artifact.artifactSizeBytes,
        ]
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

  async listPublished({ query, title, subject, owner, limit, offset }) {
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
    values.push(limit);
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
    return result.rows;
  }
}
