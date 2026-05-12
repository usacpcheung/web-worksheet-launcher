import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET,
  validateRolePlayScenePackage,
} from './roleplayscene-package.js';

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

function stripGeneratedCopySuffix(title) {
  const normalizedTitle = normalizeText(title, 'Untitled RolePlayScene');
  const match = normalizedTitle.match(/^(.*)\s\((\d+)\)$/);
  if (!match) return normalizedTitle;
  const copyIndex = Number(match[2]);
  const baseTitle = normalizeText(match[1], '');
  return copyIndex >= 2 && baseTitle ? baseTitle : normalizedTitle;
}

function withPublishState(row) {
  if (!row || row.publish_state) return row;
  if (!row.last_published_artifact_sha256) {
    return { ...row, publish_state: 'draft_only' };
  }
  return {
    ...row,
    publish_state: row.artifact_sha256 === row.last_published_artifact_sha256
      ? 'current_version_published'
      : 'unpublished_changes',
  };
}

function toPublicDraftRow(row) {
  if (!row) return row;
  const { artifact_path: _artifactPath, ...publicRow } = withPublishState(row);
  return publicRow;
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
    console.warn('Failed to cleanup deleted RolePlayScene draft artifact.', {
      artifactPath,
      code: error?.code,
      message: error?.message,
    });
  }
}

export class RolePlaySceneDraftService {
  constructor({ db, artifactStore, config }) {
    this.db = db;
    this.artifactStore = artifactStore;
    this.config = config;
  }

  async listOwnRolePlaySceneDrafts(identity, clientOverride = null) {
    const executor = clientOverride || this.db;
    const result = await executor.query(
      `SELECT
        roleplayscene_uploaded_draft_id,
        owner_sub,
        owner_email,
        owner_name,
        title,
        description,
        package_version,
        artifact_sha256,
        artifact_size_bytes,
        scene_count,
        media_count,
        missing_media_count,
        validation_warning_count,
        last_published_artifact_sha256,
        last_published_at,
        CASE
          WHEN last_published_artifact_sha256 IS NULL THEN 'draft_only'
          WHEN artifact_sha256 = last_published_artifact_sha256 THEN 'current_version_published'
          ELSE 'unpublished_changes'
        END AS publish_state,
        created_at,
        updated_at
       FROM roleplayscene_uploaded_drafts
       WHERE owner_sub = $1
       ORDER BY created_at DESC`,
      [identity.sub]
    );
    return result.rows;
  }

  async findUploadConflict({ client, identity, title }) {
    const result = await client.query(
      `SELECT
        roleplayscene_uploaded_draft_id,
        owner_sub,
        owner_email,
        owner_name,
        title,
        description,
        package_version,
        artifact_path,
        artifact_sha256,
        artifact_size_bytes,
        scene_count,
        media_count,
        missing_media_count,
        validation_warning_count,
        last_published_artifact_sha256,
        last_published_at,
        created_at,
        updated_at
       FROM roleplayscene_uploaded_drafts
       WHERE owner_sub = $1
         AND lower(regexp_replace(btrim(coalesce(title, '')), '\\s+', ' ', 'g')) = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [identity.sub, normalizeConflictText(title)]
    );
    return result.rows[0] || null;
  }

  async findAvailableCopyTitle({ client, identity, title }) {
    const baseTitle = stripGeneratedCopySuffix(title);
    for (let copyIndex = 2; copyIndex < 1000; copyIndex += 1) {
      const candidate = `${baseTitle} (${copyIndex})`;
      const existing = await this.findUploadConflict({ client, identity, title: candidate });
      if (!existing) return candidate;
    }
    return `${baseTitle} (${crypto.randomUUID().slice(0, 8)})`;
  }

  async createDraftArtifact({ identity, uploadedDraftId, zipBytes }) {
    return this.artifactStore.storeArtifact({
      ownerSub: identity.sub,
      bucket: ROLEPLAYSCENE_DRAFT_ARTIFACT_BUCKET,
      artifactId: uploadedDraftId,
      bytes: zipBytes,
    });
  }

  async createUploadedDraftRow({
    client,
    identity,
    title,
    description,
    artifact,
    validation,
    uploadedDraftId = crypto.randomUUID(),
  }) {
    const row = await client.query(
      `INSERT INTO roleplayscene_uploaded_drafts(
        roleplayscene_uploaded_draft_id,
        owner_sub,
        owner_email,
        owner_name,
        title,
        description,
        package_version,
        artifact_path,
        artifact_sha256,
        artifact_size_bytes,
        scene_count,
        media_count,
        missing_media_count,
        validation_warning_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING
        roleplayscene_uploaded_draft_id,
        owner_sub,
        owner_email,
        owner_name,
        title,
        description,
        package_version,
        artifact_sha256,
        artifact_size_bytes,
        scene_count,
        media_count,
        missing_media_count,
        validation_warning_count,
        last_published_artifact_sha256,
        last_published_at,
        created_at,
        updated_at`,
      [
        uploadedDraftId,
        identity.sub,
        identity.email,
        identity.name,
        title,
        description,
        validation.metadata.packageVersion,
        artifact.artifactPath,
        artifact.artifactSha256,
        artifact.artifactSizeBytes,
        validation.metadata.sceneCount,
        validation.metadata.mediaCount,
        validation.metadata.missingMediaCount,
        validation.metadata.validationWarningCount,
      ]
    );
    return withPublishState(row.rows[0]);
  }

  async uploadRolePlaySceneDraft({
    identity,
    title,
    description,
    zipBytes,
    conflictAction = 'fail_on_conflict',
  }) {
    const validation = validateRolePlayScenePackage(zipBytes);
    if (!validation.ok) {
      return {
        ok: false,
        statusCode: 400,
        error: validation.error,
      };
    }

    const client = await this.db.connect();
    let artifact = null;
    const cleanupArtifactPathsAfterCommit = [];
    const action = normalizeUploadConflictAction(conflictAction);
    const normalizedTitle = normalizeText(title, validation.metadata.title || 'Untitled RolePlayScene');
    const normalizedDescription = normalizeText(description, validation.metadata.description || '');

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identity.sub]);
      const conflict = await this.findUploadConflict({ client, identity, title: normalizedTitle });

      if (conflict && action === 'fail_on_conflict') {
        const drafts = await this.listOwnRolePlaySceneDrafts(identity, client);
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 409,
          error: {
            code: 'ROLEPLAYSCENE_DRAFT_NAME_CONFLICT',
            message: 'A RolePlayScene uploaded draft with this title already exists.',
            details: {
              existingDraft: toPublicDraftRow(conflict),
              uploadedDrafts: drafts,
            },
          },
        };
      }

      if (conflict && action === 'replace') {
        const replacementId = crypto.randomUUID();
        artifact = await this.createDraftArtifact({ identity, uploadedDraftId: replacementId, zipBytes });

        if (!conflict.last_published_artifact_sha256) {
          const deleted = await client.query(
            `DELETE FROM roleplayscene_uploaded_drafts
             WHERE roleplayscene_uploaded_draft_id = $1 AND owner_sub = $2
             RETURNING roleplayscene_uploaded_draft_id, artifact_path`,
            [conflict.roleplayscene_uploaded_draft_id, identity.sub]
          );
          if (deleted.rowCount === 0) {
            await client.query('ROLLBACK');
            await deleteArtifactIfPresent(artifact);
            artifact = null;
            return {
              ok: false,
              statusCode: 409,
              error: {
                code: 'ROLEPLAYSCENE_DRAFT_REPLACE_TARGET_MISSING',
                message: 'The RolePlayScene uploaded draft to replace no longer exists. Please retry.',
              },
            };
          }
          cleanupArtifactPathsAfterCommit.push(deleted.rows[0].artifact_path);
          const row = await this.createUploadedDraftRow({
            client,
            identity,
            title: normalizedTitle,
            description: normalizedDescription,
            artifact,
            validation,
            uploadedDraftId: replacementId,
          });
          await client.query('COMMIT');
          for (const artifactPath of cleanupArtifactPathsAfterCommit) {
            await deleteArtifactBestEffort({ artifactStore: this.artifactStore, artifactPath });
          }
          artifact = null;
          return {
            ok: true,
            statusCode: 201,
            data: {
              ...row,
              replaced_roleplayscene_uploaded_draft_id: conflict.roleplayscene_uploaded_draft_id,
              warnings: validation.warnings,
            },
          };
        }

        const updated = await client.query(
          `UPDATE roleplayscene_uploaded_drafts
           SET owner_email = $3,
               owner_name = $4,
               title = $5,
               description = $6,
               package_version = $7,
               artifact_path = $8,
               artifact_sha256 = $9,
               artifact_size_bytes = $10,
               scene_count = $11,
               media_count = $12,
               missing_media_count = $13,
               validation_warning_count = $14,
               updated_at = now()
           WHERE roleplayscene_uploaded_draft_id = $1 AND owner_sub = $2
           RETURNING
             roleplayscene_uploaded_draft_id,
             owner_sub,
             owner_email,
             owner_name,
             title,
             description,
             package_version,
             artifact_sha256,
             artifact_size_bytes,
             scene_count,
             media_count,
             missing_media_count,
             validation_warning_count,
             last_published_artifact_sha256,
             last_published_at,
             created_at,
             updated_at`,
          [
            conflict.roleplayscene_uploaded_draft_id,
            identity.sub,
            identity.email,
            identity.name,
            normalizedTitle,
            normalizedDescription,
            validation.metadata.packageVersion,
            artifact.artifactPath,
            artifact.artifactSha256,
            artifact.artifactSizeBytes,
            validation.metadata.sceneCount,
            validation.metadata.mediaCount,
            validation.metadata.missingMediaCount,
            validation.metadata.validationWarningCount,
          ]
        );

        if (updated.rowCount === 0) {
          await client.query('ROLLBACK');
          await deleteArtifactIfPresent(artifact);
          artifact = null;
          return {
            ok: false,
            statusCode: 409,
            error: {
              code: 'ROLEPLAYSCENE_DRAFT_REPLACE_TARGET_MISSING',
              message: 'The RolePlayScene uploaded draft to replace no longer exists. Please retry.',
            },
          };
        }
        cleanupArtifactPathsAfterCommit.push(conflict.artifact_path);
        await client.query('COMMIT');
        for (const artifactPath of cleanupArtifactPathsAfterCommit) {
          await deleteArtifactBestEffort({ artifactStore: this.artifactStore, artifactPath });
        }
        artifact = null;
        return {
          ok: true,
          statusCode: 200,
          data: {
            ...withPublishState(updated.rows[0]),
            replaced_roleplayscene_uploaded_draft_id: conflict.roleplayscene_uploaded_draft_id,
            warnings: validation.warnings,
          },
        };
      }

      const countRes = await client.query(
        'SELECT COUNT(*)::int AS count FROM roleplayscene_uploaded_drafts WHERE owner_sub = $1',
        [identity.sub]
      );
      if (countRes.rows[0].count >= this.config.draftSlotLimit) {
        const drafts = await this.listOwnRolePlaySceneDrafts(identity, client);
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 409,
          error: {
            code: 'ROLEPLAYSCENE_DRAFT_SLOT_LIMIT_REACHED',
            message: `You already have ${this.config.draftSlotLimit} RolePlayScene uploaded drafts. Delete one before uploading another.`,
            details: {
              slotLimit: this.config.draftSlotLimit,
              uploadedDrafts: drafts,
            },
          },
        };
      }

      const finalTitle = action === 'copy' && conflict
        ? await this.findAvailableCopyTitle({ client, identity, title: normalizedTitle })
        : normalizedTitle;
      const uploadedDraftId = crypto.randomUUID();
      artifact = await this.createDraftArtifact({ identity, uploadedDraftId, zipBytes });
      const row = await this.createUploadedDraftRow({
        client,
        identity,
        title: finalTitle,
        description: normalizedDescription,
        artifact,
        validation,
        uploadedDraftId,
      });

      await client.query('COMMIT');
      artifact = null;
      return {
        ok: true,
        statusCode: 201,
        data: {
          ...row,
          warnings: validation.warnings,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await deleteArtifactIfPresent(artifact);
      throw error;
    } finally {
      client.release();
    }
  }

  async loadOwnRolePlaySceneDraftArtifact({ identity, uploadedDraftId }) {
    const result = await this.db.query(
      `SELECT roleplayscene_uploaded_draft_id, owner_sub, artifact_path
       FROM roleplayscene_uploaded_drafts
       WHERE roleplayscene_uploaded_draft_id = $1 AND owner_sub = $2`,
      [uploadedDraftId, identity.sub]
    );
    return result.rowCount === 0 ? null : result.rows[0];
  }

  async deleteOwnRolePlaySceneDraft({ identity, uploadedDraftId }) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const deleted = await client.query(
        `DELETE FROM roleplayscene_uploaded_drafts
         WHERE roleplayscene_uploaded_draft_id = $1 AND owner_sub = $2
         RETURNING roleplayscene_uploaded_draft_id, artifact_path`,
        [uploadedDraftId, identity.sub]
      );

      if (deleted.rowCount === 0) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          statusCode: 404,
          error: {
            code: 'ROLEPLAYSCENE_DRAFT_NOT_FOUND',
            message: 'RolePlayScene uploaded draft was not found for this owner.',
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
          roleplayscene_uploaded_draft_id: deletedDraft.roleplayscene_uploaded_draft_id,
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
}
