import crypto from 'node:crypto';

function normalizeText(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function parseLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseOffset(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

export class PackageService {
  constructor({ db, artifactStore, config }) {
    this.db = db;
    this.artifactStore = artifactStore;
    this.config = config;
  }

  async uploadDraft({ identity, title, subject, zipBytes }) {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');
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
      const artifact = await this.artifactStore.storeArtifact({
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
      return { ok: true, statusCode: 201, data: row.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listOwnDrafts(identity) {
    const result = await this.db.query(
      `SELECT uploaded_draft_id, title, subject, artifact_sha256, artifact_size_bytes, created_at, updated_at
       FROM uploaded_drafts
       WHERE owner_sub = $1
       ORDER BY created_at DESC`,
      [identity.sub]
    );

    return result.rows;
  }

  async publishFromDraft({ identity, uploadedDraftId }) {
    const client = await this.db.connect();

    try {
      await client.query('BEGIN');
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
      const bytes = await this.artifactStore.readArtifact(draft.artifact_path);
      const publishedPackageId = crypto.randomUUID();
      const artifact = await this.artifactStore.storeArtifact({
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
        RETURNING published_package_id, title, subject, artifact_sha256, artifact_size_bytes, published_at, source_uploaded_draft_id`,
        [
          publishedPackageId,
          identity.sub,
          identity.email,
          identity.name,
          draft.uploaded_draft_id,
          draft.title,
          draft.subject,
          artifact.artifactPath,
          artifact.artifactSha256,
          artifact.artifactSizeBytes,
        ]
      );

      await client.query('COMMIT');
      return { ok: true, statusCode: 201, data: publishedRes.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
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

  async listPublished({ query, subject, limit, offset }) {
    const values = [];
    const clauses = [];

    if (query) {
      values.push(`%${query.toLowerCase()}%`);
      clauses.push(`lower(title) LIKE $${values.length}`);
    }

    if (subject) {
      values.push(`%${subject.toLowerCase()}%`);
      clauses.push(`lower(subject) LIKE $${values.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(parseLimit(limit, this.config.browsePageLimitDefault, this.config.browsePageLimitMax));
    const limitPlaceholder = `$${values.length}`;
    values.push(parseOffset(offset));
    const offsetPlaceholder = `$${values.length}`;

    const sql = `SELECT published_package_id, title, subject, owner_sub, artifact_sha256, artifact_size_bytes, published_at
      FROM published_packages
      ${where}
      ORDER BY published_at DESC
      LIMIT ${limitPlaceholder}
      OFFSET ${offsetPlaceholder}`;

    const result = await this.db.query(sql, values);
    return result.rows;
  }
}
