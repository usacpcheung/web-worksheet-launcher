import crypto from 'node:crypto';

const ARTIFACT_KINDS = new Set(['worksheet', 'roleplayscene']);
const DEFAULT_ORPHAN_MIN_AGE_MS = 72 * 60 * 60 * 1000;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function portablePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function publicationDefinition(kind) {
  if (kind === 'worksheet') {
    return {
      table: 'published_packages',
      idColumn: 'published_package_id',
      sourceColumn: 'source_uploaded_draft_id',
      sourceTable: 'uploaded_drafts',
      sourceIdColumn: 'uploaded_draft_id',
      fields: [
        'published_package_id',
        'owner_sub',
        'owner_email',
        'owner_name',
        'source_uploaded_draft_id',
        'title',
        'subject',
        'artifact_path',
        'artifact_sha256',
        'artifact_size_bytes',
        'created_at',
        'published_at',
      ],
    };
  }
  if (kind === 'roleplayscene') {
    return {
      table: 'roleplayscene_published_scenes',
      idColumn: 'roleplayscene_published_scene_id',
      sourceColumn: 'source_roleplayscene_uploaded_draft_id',
      sourceTable: 'roleplayscene_uploaded_drafts',
      sourceIdColumn: 'roleplayscene_uploaded_draft_id',
      fields: [
        'roleplayscene_published_scene_id',
        'owner_sub',
        'owner_email',
        'owner_name',
        'source_roleplayscene_uploaded_draft_id',
        'title',
        'description',
        'package_version',
        'artifact_path',
        'artifact_sha256',
        'artifact_size_bytes',
        'scene_count',
        'media_count',
        'missing_media_count',
        'validation_warning_count',
        'created_at',
        'published_at',
      ],
    };
  }
  throw new Error(`Unsupported published artifact kind: ${kind}`);
}

function normalizeMetadata(value) {
  if (!value) return {};
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class ArtifactMaintenanceService {
  constructor({
    db,
    artifactStore,
    now = () => new Date(),
    orphanMinAgeMs = DEFAULT_ORPHAN_MIN_AGE_MS,
    retentionMs = DEFAULT_RETENTION_MS,
  }) {
    this.db = db;
    this.artifactStore = artifactStore;
    this.now = now;
    this.orphanMinAgeMs = orphanMinAgeMs;
    this.retentionMs = retentionMs;
  }

  async audit() {
    const [worksheetRows, rolePlaySceneRows, quarantineRows, storedArtifacts] = await Promise.all([
      this.db.query(
        `SELECT published_package_id AS published_id, artifact_path, artifact_sha256, artifact_size_bytes
         FROM published_packages`
      ),
      this.db.query(
        `SELECT roleplayscene_published_scene_id AS published_id, artifact_path, artifact_sha256, artifact_size_bytes
         FROM roleplayscene_published_scenes`
      ),
      this.db.query(
        `SELECT quarantine_id, artifact_kind, original_artifact_path, quarantine_artifact_path, status
         FROM published_artifact_quarantine
         WHERE status NOT IN ('purged', 'restored')`
      ),
      this.artifactStore.listPublishedArtifacts(),
    ]);

    const activeRows = [
      ...worksheetRows.rows.map((row) => ({ ...row, artifactKind: 'worksheet' })),
      ...rolePlaySceneRows.rows.map((row) => ({ ...row, artifactKind: 'roleplayscene' })),
    ];
    const storedByPath = new Map(
      storedArtifacts.map((artifact) => [portablePath(artifact.artifactPath), artifact])
    );
    const referencedPaths = new Set(activeRows.map((row) => portablePath(row.artifact_path)));
    const pendingQuarantinePaths = new Set(
      quarantineRows.rows
        .filter((row) => row.status === 'pending_quarantine')
        .map((row) => portablePath(row.original_artifact_path))
    );

    const healthy = [];
    const missing = [];
    for (const row of activeRows) {
      const artifactPath = portablePath(row.artifact_path);
      const stored = storedByPath.get(artifactPath);
      if (stored) {
        healthy.push({
          artifactKind: row.artifactKind,
          publishedId: row.published_id,
          artifactPath,
          expectedSizeBytes: Number(row.artifact_size_bytes),
          actualSizeBytes: stored.sizeBytes,
        });
      } else {
        missing.push({
          artifactKind: row.artifactKind,
          publishedId: row.published_id,
          artifactPath,
        });
      }
    }

    const cutoff = this.now().getTime() - this.orphanMinAgeMs;
    const orphaned = [];
    const youngUnreferenced = [];
    for (const artifact of storedArtifacts) {
      const artifactPath = portablePath(artifact.artifactPath);
      if (referencedPaths.has(artifactPath) || pendingQuarantinePaths.has(artifactPath)) continue;
      const candidate = {
        artifactPath,
        sizeBytes: artifact.sizeBytes,
        modifiedAt: toIso(artifact.modifiedAt),
      };
      if (artifact.modifiedAt.getTime() <= cutoff) orphaned.push(candidate);
      else youngUnreferenced.push(candidate);
    }

    return {
      generatedAt: this.now().toISOString(),
      healthy,
      missing,
      orphaned,
      youngUnreferenced,
      quarantined: quarantineRows.rows,
      totals: {
        healthy: healthy.length,
        missing: missing.length,
        orphaned: orphaned.length,
        youngUnreferenced: youngUnreferenced.length,
        quarantined: quarantineRows.rowCount,
      },
    };
  }

  async inspectPublication(kind, publishedId) {
    this.#validatePublicationIdentity(kind, publishedId);
    const definition = publicationDefinition(kind);
    const active = await this.db.query(
      `SELECT ${definition.fields.join(', ')}
       FROM ${definition.table}
       WHERE ${definition.idColumn} = $1`,
      [publishedId]
    );
    if (active.rowCount > 0) {
      return { state: 'active', artifactKind: kind, publication: active.rows[0] };
    }

    const quarantined = await this.db.query(
      `SELECT *
       FROM published_artifact_quarantine
       WHERE artifact_kind = $1 AND original_published_id = $2
         AND status NOT IN ('purged', 'restored')
       ORDER BY created_at DESC
       LIMIT 1`,
      [kind, publishedId]
    );
    if (quarantined.rowCount > 0) {
      return { state: 'quarantine', artifactKind: kind, quarantine: quarantined.rows[0] };
    }
    return null;
  }

  async quarantinePublication({
    kind,
    publishedId,
    requestedBy,
    reason,
    automatedConfirmation = false,
  }) {
    this.#validatePublicationIdentity(kind, publishedId);
    this.#validateAuditInput(requestedBy, reason);
    const definition = publicationDefinition(kind);
    const client = await this.db.connect();
    let quarantineRow;

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`maintenance:${kind}:${publishedId}`]);
      const active = await client.query(
        `SELECT ${definition.fields.join(', ')}
         FROM ${definition.table}
         WHERE ${definition.idColumn} = $1
         FOR UPDATE`,
        [publishedId]
      );

      if (active.rowCount === 0) {
        const existing = await client.query(
          `SELECT *
           FROM published_artifact_quarantine
           WHERE artifact_kind = $1 AND original_published_id = $2
             AND status NOT IN ('purged', 'restored')
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [kind, publishedId]
        );
        if (existing.rowCount === 0) {
          await client.query('ROLLBACK');
          return { ok: false, code: 'PUBLISHED_ARTIFACT_NOT_FOUND' };
        }
        quarantineRow = existing.rows[0];
        await client.query('COMMIT');
        return this.#completeQuarantineMove(quarantineRow);
      }

      const publication = active.rows[0];
      const quarantineId = crypto.randomUUID();
      const quarantinePath = this.artifactStore.quarantinePath({
        artifactKind: kind,
        quarantineId,
      });
      const purgeAfter = new Date(this.now().getTime() + this.retentionMs);
      const inserted = await client.query(
        `INSERT INTO published_artifact_quarantine(
          quarantine_id,
          artifact_kind,
          original_published_id,
          original_artifact_path,
          quarantine_artifact_path,
          owner_sub,
          owner_email,
          owner_name,
          title,
          artifact_sha256,
          artifact_size_bytes,
          publication_metadata,
          status,
          requested_by,
          reason,
          automated_confirmation,
          purge_after
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'pending_quarantine',$13,$14,$15,$16)
        RETURNING *`,
        [
          quarantineId,
          kind,
          publishedId,
          portablePath(publication.artifact_path),
          quarantinePath,
          publication.owner_sub,
          publication.owner_email,
          publication.owner_name,
          publication.title,
          publication.artifact_sha256,
          publication.artifact_size_bytes,
          JSON.stringify(publication),
          requestedBy,
          reason,
          automatedConfirmation,
          purgeAfter,
        ]
      );
      await client.query(
        `DELETE FROM ${definition.table} WHERE ${definition.idColumn} = $1`,
        [publishedId]
      );
      await client.query('COMMIT');
      quarantineRow = inserted.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return this.#completeQuarantineMove(quarantineRow);
  }

  async quarantineOrphans({
    requestedBy,
    reason,
    automatedConfirmation = false,
  }) {
    this.#validateAuditInput(requestedBy, reason);
    const pending = await this.db.query(
      `SELECT *
       FROM published_artifact_quarantine
       WHERE artifact_kind = 'orphan' AND status = 'pending_quarantine'
       ORDER BY created_at`
    );
    const results = [];
    for (const row of pending.rows) {
      results.push(await this.#completeQuarantineMove(row));
    }

    const audit = await this.audit();
    for (const orphan of audit.orphaned) {
      const quarantineId = crypto.randomUUID();
      const quarantinePath = this.artifactStore.quarantinePath({
        artifactKind: 'orphan',
        quarantineId,
      });
      const purgeAfter = new Date(this.now().getTime() + this.retentionMs);
      let row;
      try {
        const inserted = await this.db.query(
          `INSERT INTO published_artifact_quarantine(
            quarantine_id,
            artifact_kind,
            original_artifact_path,
            quarantine_artifact_path,
            artifact_size_bytes,
            publication_metadata,
            status,
            requested_by,
            reason,
            automated_confirmation,
            purge_after
          ) VALUES ($1,'orphan',$2,$3,$4,$5::jsonb,'pending_quarantine',$6,$7,$8,$9)
          ON CONFLICT DO NOTHING
          RETURNING *`,
          [
            quarantineId,
            orphan.artifactPath,
            quarantinePath,
            orphan.sizeBytes,
            JSON.stringify({ modifiedAt: orphan.modifiedAt }),
            requestedBy,
            reason,
            automatedConfirmation,
            purgeAfter,
          ]
        );
        if (inserted.rowCount === 0) {
          results.push({ artifactPath: orphan.artifactPath, ok: false, code: 'ALREADY_QUARANTINED' });
          continue;
        }
        [row] = inserted.rows;
        results.push(await this.#completeQuarantineMove(row));
      } catch (error) {
        results.push({
          artifactPath: orphan.artifactPath,
          ok: false,
          code: 'QUARANTINE_FAILED',
          error: error.message,
        });
      }
    }
    return { resumed: pending.rowCount, candidates: audit.orphaned.length, results };
  }

  async inspectQuarantine(quarantineId) {
    if (!isUuid(quarantineId)) throw new Error('Invalid quarantine ID.');
    const result = await this.db.query(
      'SELECT * FROM published_artifact_quarantine WHERE quarantine_id = $1',
      [quarantineId]
    );
    return result.rowCount > 0 ? result.rows[0] : null;
  }

  async restore({ quarantineId, requestedBy, automatedConfirmation = false }) {
    if (!isUuid(quarantineId)) throw new Error('Invalid quarantine ID.');
    if (!String(requestedBy || '').trim()) throw new Error('Administrator identity is required.');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`maintenance:quarantine:${quarantineId}`]);
      const selected = await client.query(
        'SELECT * FROM published_artifact_quarantine WHERE quarantine_id = $1 FOR UPDATE',
        [quarantineId]
      );
      if (selected.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, code: 'QUARANTINE_NOT_FOUND' };
      }
      const row = selected.rows[0];
      if (row.status === 'restored') {
        await client.query('COMMIT');
        return { ok: true, alreadyRestored: true, quarantine: row };
      }
      if (!['quarantined', 'pending_restore'].includes(row.status)) {
        await client.query('ROLLBACK');
        return { ok: false, code: 'QUARANTINE_NOT_RESTORABLE', status: row.status };
      }
      const purgeAfter = new Date(row.purge_after);
      if (!Number.isFinite(purgeAfter.getTime()) || purgeAfter.getTime() <= this.now().getTime()) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          code: 'QUARANTINE_EXPIRED',
          purgeAfter: row.purge_after,
        };
      }

      let restoreMetadata = null;
      if (row.artifact_kind !== 'orphan') {
        restoreMetadata = await this.#resolveRestoredPublicationMetadata(client, row);
        await this.#assertPublicationCanRestore(client, row, restoreMetadata);
      }

      await client.query(
        `UPDATE published_artifact_quarantine
         SET status = 'pending_restore',
             restore_requested_at = COALESCE(restore_requested_at, now()),
             restored_by = $3,
             automated_confirmation = automated_confirmation OR $2,
             last_error = NULL,
             updated_at = now()
         WHERE quarantine_id = $1`,
        [quarantineId, automatedConfirmation, requestedBy]
      );

      try {
        await this.artifactStore.moveArtifact({
          sourcePath: row.quarantine_artifact_path,
          destinationPath: row.original_artifact_path,
        });
      } catch (error) {
        await client.query(
          `UPDATE published_artifact_quarantine
           SET last_error = $2, updated_at = now()
           WHERE quarantine_id = $1`,
          [quarantineId, error.message]
        );
        await client.query('COMMIT');
        return { ok: false, code: 'RESTORE_MOVE_FAILED', error: error.message };
      }

      if (row.artifact_kind !== 'orphan') {
        await this.#insertRestoredPublication(client, row, restoreMetadata);
      }
      const restored = await client.query(
        `UPDATE published_artifact_quarantine
         SET status = 'restored',
             restored_at = now(),
             last_error = NULL,
             updated_at = now()
         WHERE quarantine_id = $1
         RETURNING *`,
        [quarantineId]
      );
      await client.query('COMMIT');
      return { ok: true, alreadyRestored: false, quarantine: restored.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listExpired() {
    const result = await this.db.query(
      `SELECT *
       FROM published_artifact_quarantine
       WHERE status IN ('quarantined', 'pending_purge', 'missing')
         AND purge_after <= $1
       ORDER BY purge_after, created_at`,
      [this.now()]
    );
    return result.rows;
  }

  async purgeExpired({
    apply = false,
    requestedBy = '',
    automatedConfirmation = false,
  } = {}) {
    const expired = await this.listExpired();
    if (!apply) return { applied: false, candidates: expired };
    if (!String(requestedBy || '').trim()) throw new Error('Administrator identity is required.');

    const results = [];
    for (const row of expired) {
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`maintenance:quarantine:${row.quarantine_id}`]);
        const selected = await client.query(
          `SELECT *
           FROM published_artifact_quarantine
           WHERE quarantine_id = $1
             AND status IN ('quarantined', 'pending_purge', 'missing')
             AND purge_after <= $2
           FOR UPDATE`,
          [row.quarantine_id, this.now()]
        );
        if (selected.rowCount === 0) {
          await client.query('ROLLBACK');
          results.push({ quarantineId: row.quarantine_id, ok: false, code: 'NO_LONGER_PURGEABLE' });
          continue;
        }
        await client.query(
          `UPDATE published_artifact_quarantine
           SET status = 'pending_purge',
               automated_confirmation = automated_confirmation OR $2,
               purged_by = $3,
               last_error = NULL,
               updated_at = now()
           WHERE quarantine_id = $1`,
          [row.quarantine_id, automatedConfirmation, requestedBy]
        );
        try {
          await this.artifactStore.deleteArtifact(row.quarantine_artifact_path);
        } catch (error) {
          await client.query(
            `UPDATE published_artifact_quarantine
             SET last_error = $2, updated_at = now()
             WHERE quarantine_id = $1`,
            [row.quarantine_id, error.message]
          );
          await client.query('COMMIT');
          results.push({
            quarantineId: row.quarantine_id,
            ok: false,
            code: 'PURGE_DELETE_FAILED',
            error: error.message,
          });
          continue;
        }
        const purged = await client.query(
          `UPDATE published_artifact_quarantine
           SET status = 'purged',
               purged_at = now(),
               last_error = NULL,
               updated_at = now()
           WHERE quarantine_id = $1
           RETURNING *`,
          [row.quarantine_id]
        );
        await client.query('COMMIT');
        results.push({ quarantineId: row.quarantine_id, ok: true, quarantine: purged.rows[0] });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        results.push({
          quarantineId: row.quarantine_id,
          ok: false,
          code: 'PURGE_FAILED',
          error: error.message,
        });
      } finally {
        client.release();
      }
    }
    return { applied: true, candidates: expired, results };
  }

  async #completeQuarantineMove(row) {
    if (row.status === 'quarantined') {
      return { ok: true, alreadyQuarantined: true, quarantine: row };
    }
    try {
      await this.artifactStore.moveArtifact({
        sourcePath: row.original_artifact_path,
        destinationPath: row.quarantine_artifact_path,
      });
      const updated = await this.db.query(
        `UPDATE published_artifact_quarantine
         SET status = 'quarantined',
             quarantined_at = COALESCE(quarantined_at, now()),
             last_error = NULL,
             updated_at = now()
         WHERE quarantine_id = $1
         RETURNING *`,
        [row.quarantine_id]
      );
      return { ok: true, alreadyQuarantined: false, quarantine: updated.rows[0] };
    } catch (error) {
      const [source, destination] = await Promise.all([
        this.artifactStore.statArtifact(row.original_artifact_path),
        this.artifactStore.statArtifact(row.quarantine_artifact_path),
      ]);
      const status = !source && !destination ? 'missing' : 'pending_quarantine';
      await this.db.query(
        `UPDATE published_artifact_quarantine
         SET status = $2, last_error = $3, updated_at = now()
         WHERE quarantine_id = $1`,
        [row.quarantine_id, status, error.message]
      );
      return {
        ok: false,
        code: status === 'missing' ? 'ARTIFACT_MISSING' : 'QUARANTINE_MOVE_FAILED',
        error: error.message,
        quarantineId: row.quarantine_id,
      };
    }
  }

  async #resolveRestoredPublicationMetadata(client, quarantineRow) {
    const definition = publicationDefinition(quarantineRow.artifact_kind);
    const metadata = { ...normalizeMetadata(quarantineRow.publication_metadata) };
    const sourceId = metadata[definition.sourceColumn];
    if (!sourceId) return metadata;

    const source = await client.query(
      `SELECT 1
       FROM ${definition.sourceTable}
       WHERE ${definition.sourceIdColumn} = $1
       FOR KEY SHARE`,
      [sourceId]
    );
    if (source.rowCount === 0) {
      metadata[definition.sourceColumn] = null;
    }
    return metadata;
  }

  async #assertPublicationCanRestore(client, quarantineRow, metadata) {
    const definition = publicationDefinition(quarantineRow.artifact_kind);
    const idConflict = await client.query(
      `SELECT 1 FROM ${definition.table} WHERE ${definition.idColumn} = $1`,
      [quarantineRow.original_published_id]
    );
    if (idConflict.rowCount > 0) {
      throw Object.assign(new Error('The original published ID is already active.'), {
        code: 'RESTORE_ID_CONFLICT',
      });
    }

    if (quarantineRow.artifact_kind === 'worksheet') {
      const titleConflict = await client.query(
        `SELECT 1
         FROM published_packages
         WHERE owner_sub = $1
           AND lower(regexp_replace(btrim(coalesce(title, '')), '\\s+', ' ', 'g'))
             = lower(regexp_replace(btrim(coalesce($2, '')), '\\s+', ' ', 'g'))
           AND lower(regexp_replace(btrim(coalesce(subject, '')), '\\s+', ' ', 'g'))
             = lower(regexp_replace(btrim(coalesce($3, '')), '\\s+', ' ', 'g'))
         LIMIT 1`,
        [metadata.owner_sub, metadata.title, metadata.subject || '']
      );
      if (titleConflict.rowCount > 0) {
        throw Object.assign(new Error('A worksheet with the same owner, title, and subject is active.'), {
          code: 'RESTORE_TITLE_CONFLICT',
        });
      }
    } else {
      const titleConflict = await client.query(
        `SELECT 1
         FROM roleplayscene_published_scenes
         WHERE owner_sub = $1
           AND lower(regexp_replace(btrim(coalesce(title, '')), '\\s+', ' ', 'g'))
             = lower(regexp_replace(btrim(coalesce($2, '')), '\\s+', ' ', 'g'))
         LIMIT 1`,
        [metadata.owner_sub, metadata.title]
      );
      if (titleConflict.rowCount > 0) {
        throw Object.assign(new Error('A RolePlayScene with the same owner and title is active.'), {
          code: 'RESTORE_TITLE_CONFLICT',
        });
      }
    }
  }

  async #insertRestoredPublication(client, quarantineRow, metadata) {
    const definition = publicationDefinition(quarantineRow.artifact_kind);
    const values = definition.fields.map((field) => {
      if (field === 'artifact_path') return portablePath(quarantineRow.original_artifact_path);
      return metadata[field] ?? null;
    });
    const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
    await client.query(
      `INSERT INTO ${definition.table} (${definition.fields.join(', ')})
       VALUES (${placeholders})`,
      values
    );
  }

  #validatePublicationIdentity(kind, publishedId) {
    if (!ARTIFACT_KINDS.has(kind)) {
      throw new Error('Published artifact type must be worksheet or roleplayscene.');
    }
    if (!isUuid(publishedId)) {
      throw new Error('Published artifact ID must be a UUID.');
    }
  }

  #validateAuditInput(requestedBy, reason) {
    if (!String(requestedBy || '').trim()) {
      throw new Error('Administrator identity is required.');
    }
    if (!String(reason || '').trim()) {
      throw new Error('A quarantine reason is required.');
    }
  }
}

export const ARTIFACT_MAINTENANCE_DEFAULTS = {
  orphanMinAgeMs: DEFAULT_ORPHAN_MIN_AGE_MS,
  retentionMs: DEFAULT_RETENTION_MS,
};
