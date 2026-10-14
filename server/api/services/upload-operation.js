import { createHash } from 'node:crypto';
import { isUuid } from '../validation.js';
import { uploadFingerprintInput } from '../../app/api/upload-operation-contract.js';

export function createUploadOperation({ operationId, kind, metadata, zipBytes }) {
  if (operationId == null) return null; // Legacy callers retain their existing behavior.
  if (!isUuid(operationId)) throw new TypeError('Upload operation ID must be a UUID.');
  const packageHash = createHash('sha256').update(zipBytes).digest('hex');
  const requestHash = createHash('sha256').update(uploadFingerprintInput(kind, metadata, packageHash)).digest('hex');
  return { id: operationId.trim().toLowerCase(), kind, requestHash };
}

// Called only after acquiring the upload service's owner transaction lock.
export async function replayUploadOperation(client, identity, operation) {
  if (!operation) return null;
  const { rows } = await client.query(
    'SELECT request_sha256, response FROM upload_operations WHERE owner_sub=$1 AND operation_id=$2',
    [identity.sub, operation.id]
  );
  if (!rows.length) return null;
  if (rows[0].request_sha256 !== operation.requestHash) {
    return { ok: false, statusCode: 409, error: {
      code: 'UPLOAD_OPERATION_MISMATCH',
      message: 'This operation ID already completed a different upload. Use its original package and metadata to retry.',
    } };
  }
  return rows[0].response;
}

export async function recordUploadOperation(client, identity, operation, result) {
  if (!operation) return result;
  const response = { ...result, data: { ...result.data, upload_operation_id: operation.id } };
  await client.query(
    `INSERT INTO upload_operations(owner_sub, operation_id, kind, request_sha256, response)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [identity.sub, operation.id, operation.kind, operation.requestHash, JSON.stringify(response)]
  );
  return response;
}

export async function getUploadOperation(db, identity, operationId) {
  const { rows } = await db.query(
    'SELECT kind, request_sha256, response, completed_at FROM upload_operations WHERE owner_sub=$1 AND operation_id=$2',
    [identity.sub, operationId]
  );
  if (!rows.length) return { operationId, state: 'unknown' };
  const row = rows[0];
  return { operationId, state: 'completed', kind: row.kind, requestSha256: row.request_sha256, result: row.response, completedAt: row.completed_at };
}
