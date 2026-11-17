import crypto from 'node:crypto';
import path from 'node:path';
import type { DbExecutor } from '@/lib/db/tenant-client';
import type { AttachmentDto } from '@/lib/estimates/types';
import { requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import {
  createAttachmentSignedUrl,
  removeAttachmentObject,
  uploadAttachmentObject,
} from '@/lib/storage/storage-client';

export const MAX_ATTACHMENT_FILE_BYTES = 5 * 1024 * 1024;
export const ATTACHMENT_SIGNED_URL_TTL_SECONDS = 900;

export type AttachmentEntityType = 'QUOTATION' | 'PROJECT';

interface AttachmentRow extends Record<string, unknown> {
  id: string;
  entity_type: AttachmentEntityType;
  entity_id: string;
  sort_order: number;
  storage_key: string;
  original_name: string;
  mime_type: string;
  file_size: string | number;
  comment: string | null;
  uploaded_by: string | null;
  created_at: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

function normalizeOptionalComment(comment: string | null | undefined): string | null {
  if (comment === null || comment === undefined) {
    return null;
  }
  const trimmed = comment.trim();
  if (trimmed.length > 500) {
    throw new MasterDataError(400, 'COMMENT_TOO_LONG', '画像コメントは500文字以内で入力してください。');
  }
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeOriginalFilename(rawName: string, fallbackExt: string): string {
  const base = path.basename(rawName.trim()).replace(/[\u0000-\u001F\u007F]/g, '');
  if (base.length === 0) {
    return `attachment.${fallbackExt}`;
  }
  return base.slice(0, 200);
}

export interface DetectedImageType {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: 'jpg' | 'png' | 'webp';
}

/**
 * ファイルバイナリ先頭のマジックナンバーとサイズ（5MB上限）を厳密検証する
 * - クライアント申告の拡張子 / Content-Type は一切信用しない
 */
export function detectAndValidateImageBinary(bytes: Uint8Array): DetectedImageType {
  if (bytes.byteLength === 0) {
    throw new MasterDataError(400, 'EMPTY_FILE', '空のファイルはアップロードできません。');
  }
  if (bytes.byteLength > MAX_ATTACHMENT_FILE_BYTES) {
    throw new MasterDataError(
      400,
      'FILE_TOO_LARGE',
      '添付ファイルのサイズは 5MB 以下にしてください。',
    );
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.byteLength >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { mimeType: 'image/png', ext: 'png' };
  }

  // JPEG: FF D8 FF
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }

  throw new MasterDataError(
    400,
    'INVALID_IMAGE_MAGIC_BYTES',
    'JPEG / PNG / WebP の実体画像ファイルのみアップロードできます（SVG・HTML等の偽装ファイルは拒否されます）。',
  );
}

async function assertAttachmentFeatures(
  tx: DbExecutor,
  tenantId: string,
  entityType: AttachmentEntityType,
): Promise<void> {
  if (entityType === 'QUOTATION') {
    await requireFeature(tx, tenantId, 'estimate');
    await requireFeature(tx, tenantId, 'estimateimage');
    return;
  }
  await requireFeature(tx, tenantId, 'construction');
  await requireFeature(tx, tenantId, 'constructionimage');
}

async function mapRowWithSignedUrl(row: AttachmentRow): Promise<AttachmentDto> {
  const signedUrl = await createAttachmentSignedUrl({
    storageKey: row.storage_key,
    expiresInSeconds: ATTACHMENT_SIGNED_URL_TTL_SECONDS,
  });
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sortOrder: Number(row.sort_order),
    storageKey: row.storage_key,
    originalName: row.original_name,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size),
    comment: row.comment,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    signedUrl,
  };
}

async function normalizeSiblingSortOrders(
  tx: DbExecutor,
  entityType: AttachmentEntityType,
  entityId: string,
  orderedIds: readonly string[],
): Promise<void> {
  if (orderedIds.length === 0) {
    return;
  }
  const tempOrders = orderedIds.map((_, idx) => -(idx + 10001));
  await tx.query(
    `UPDATE attachments AS a
        SET sort_order = u.ord
       FROM UNNEST($3::uuid[], $4::int[]) AS u(id, ord)
      WHERE a.entity_type = $1
        AND a.entity_id = $2::uuid
        AND a.id = u.id`,
    [entityType, entityId, orderedIds, tempOrders],
  );

  const finalOrders = orderedIds.map((_, idx) => idx + 1);
  await tx.query(
    `UPDATE attachments AS a
        SET sort_order = u.ord
       FROM UNNEST($3::uuid[], $4::int[]) AS u(id, ord)
      WHERE a.entity_type = $1
        AND a.entity_id = $2::uuid
        AND a.id = u.id`,
    [entityType, entityId, orderedIds, finalOrders],
  );
}

export async function listAttachments(
  tx: DbExecutor,
  tenantId: string,
  entityType: AttachmentEntityType,
  entityId: string,
): Promise<AttachmentDto[]> {
  validateUuid(entityId, '対象伝票');
  await assertAttachmentFeatures(tx, tenantId, entityType);

  const rows = await tx.query<AttachmentRow>(
    `SELECT id, entity_type, entity_id, sort_order, storage_key, original_name,
            mime_type, file_size::text AS file_size, comment, uploaded_by,
            created_at::text AS created_at
       FROM attachments
      WHERE entity_type = $1
        AND entity_id = $2::uuid
      ORDER BY sort_order ASC, created_at ASC`,
    [entityType, entityId],
  );

  const out: AttachmentDto[] = [];
  for (const row of rows) {
    out.push(await mapRowWithSignedUrl(row));
  }
  return out;
}

export async function uploadAttachment(
  tx: DbExecutor,
  params: {
    tenantId: string;
    employeeId: string;
    entityType: AttachmentEntityType;
    entityId: string;
    originalName: string;
    fileBytes: Uint8Array;
    comment: string | null;
  },
): Promise<AttachmentDto> {
  validateUuid(params.entityId, '対象伝票');
  await assertAttachmentFeatures(tx, params.tenantId, params.entityType);

  // 親伝票の存在確認＆排他ロック
  if (params.entityType === 'QUOTATION') {
    const qRows = await tx.query<{ id: string }>(
      'SELECT id FROM quotations WHERE id = $1::uuid FOR UPDATE',
      [params.entityId],
    );
    if (qRows.length === 0) {
      throw new MasterDataError(404, 'QUOTATION_NOT_FOUND', '対象の見積が見つかりません。');
    }
  } else {
    const pRows = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1::uuid FOR UPDATE',
      [params.entityId],
    );
    if (pRows.length === 0) {
      throw new MasterDataError(404, 'PROJECT_NOT_FOUND', '対象の案件が見つかりません。');
    }
  }

  const detected = detectAndValidateImageBinary(params.fileBytes);
  const cleanName = sanitizeOriginalFilename(params.originalName, detected.ext);
  const cleanComment = normalizeOptionalComment(params.comment);

  const folderSegment = params.entityType === 'QUOTATION' ? 'quotations' : 'projects';
  const storageKey = `${params.tenantId}/${folderSegment}/${params.entityId}/${crypto.randomUUID()}.${detected.ext}`;

  await uploadAttachmentObject({
    storageKey,
    body: params.fileBytes,
    contentType: detected.mimeType,
  });

  try {
    const nextOrderRows = await tx.query<{ next_order: number }>(
      `SELECT COALESCE(MAX(sort_order), 0)::int + 1 AS next_order
         FROM attachments
        WHERE entity_type = $1
          AND entity_id = $2::uuid`,
      [params.entityType, params.entityId],
    );
    const nextOrder =
      nextOrderRows[0] !== undefined ? Number(nextOrderRows[0].next_order) : 1;

    const inserted = await tx.query<AttachmentRow>(
      `INSERT INTO attachments (
         tenant_id, entity_type, entity_id, sort_order, storage_key,
         original_name, mime_type, file_size, comment, uploaded_by
       ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10::uuid)
       RETURNING id, entity_type, entity_id, sort_order, storage_key, original_name,
                 mime_type, file_size::text AS file_size, comment, uploaded_by,
                 created_at::text AS created_at`,
      [
        params.tenantId,
        params.entityType,
        params.entityId,
        nextOrder,
        storageKey,
        cleanName,
        detected.mimeType,
        params.fileBytes.byteLength,
        cleanComment,
        params.employeeId,
      ],
    );

    const row = inserted[0];
    if (row === undefined) {
      throw new MasterDataError(500, 'ATTACHMENT_INSERT_FAILED', '添付画像の登録結果を取得できませんでした。');
    }
    return mapRowWithSignedUrl(row);
  } catch (err) {
    try {
      await removeAttachmentObject({ storageKey });
    } catch (cleanupErr) {
      console.error('[ATTACHMENT_STORAGE_CLEANUP_FAILED]', cleanupErr);
      throw mapPgConstraintError(err, { entityLabel: '添付画像' });
    }
    throw mapPgConstraintError(err, { entityLabel: '添付画像' });
  }
}

export async function updateAttachment(
  tx: DbExecutor,
  tenantId: string,
  id: string,
  params: {
    comment?: string | null;
    moveDirection?: 'UP' | 'DOWN';
    sortOrder?: number;
  },
): Promise<AttachmentDto> {
  validateUuid(id, '添付画像');

  const currentRows = await tx.query<AttachmentRow>(
    `SELECT id, entity_type, entity_id, sort_order, storage_key, original_name,
            mime_type, file_size::text AS file_size, comment, uploaded_by,
            created_at::text AS created_at
       FROM attachments
      WHERE id = $1::uuid
      FOR UPDATE`,
    [id],
  );
  const current = currentRows[0];
  if (current === undefined) {
    throw new MasterDataError(404, 'ATTACHMENT_NOT_FOUND', '指定された添付画像が見つかりません。');
  }

  await assertAttachmentFeatures(tx, tenantId, current.entity_type);

  if (params.comment !== undefined) {
    const cleanComment = normalizeOptionalComment(params.comment);
    await tx.query(
      'UPDATE attachments SET comment = $2 WHERE id = $1::uuid',
      [id, cleanComment],
    );
  }

  if (params.moveDirection !== undefined || params.sortOrder !== undefined) {
    const siblings = await tx.query<{ id: string }>(
      `SELECT id
         FROM attachments
        WHERE entity_type = $1
          AND entity_id = $2::uuid
        ORDER BY sort_order ASC, created_at ASC
        FOR UPDATE`,
      [current.entity_type, current.entity_id],
    );
    const ids = siblings.map((s) => s.id);
    const curIndex = ids.indexOf(id);
    if (curIndex >= 0) {
      let targetIndex = curIndex;
      if (params.moveDirection === 'UP' && curIndex > 0) {
        targetIndex = curIndex - 1;
      } else if (params.moveDirection === 'DOWN' && curIndex < ids.length - 1) {
        targetIndex = curIndex + 1;
      } else if (params.sortOrder !== undefined && Number.isInteger(params.sortOrder)) {
        const clamped = Math.max(1, Math.min(ids.length, params.sortOrder));
        targetIndex = clamped - 1;
      }
      if (targetIndex !== curIndex) {
        ids.splice(curIndex, 1);
        ids.splice(targetIndex, 0, id);
        await normalizeSiblingSortOrders(tx, current.entity_type, current.entity_id, ids);
      }
    }
  }

  const refreshed = await tx.query<AttachmentRow>(
    `SELECT id, entity_type, entity_id, sort_order, storage_key, original_name,
            mime_type, file_size::text AS file_size, comment, uploaded_by,
            created_at::text AS created_at
       FROM attachments
      WHERE id = $1::uuid`,
    [id],
  );
  const updated = refreshed[0];
  if (updated === undefined) {
    throw new MasterDataError(404, 'ATTACHMENT_NOT_FOUND', '更新後の添付画像が見つかりません。');
  }
  return mapRowWithSignedUrl(updated);
}

export async function deleteAttachment(
  tx: DbExecutor,
  tenantId: string,
  id: string,
): Promise<{ deletedId: string; storageKey: string }> {
  validateUuid(id, '添付画像');

  const currentRows = await tx.query<{
    id: string;
    entity_type: AttachmentEntityType;
    entity_id: string;
    storage_key: string;
  }>(
    `SELECT id, entity_type, entity_id, storage_key
       FROM attachments
      WHERE id = $1::uuid
      FOR UPDATE`,
    [id],
  );
  const current = currentRows[0];
  if (current === undefined) {
    throw new MasterDataError(404, 'ATTACHMENT_NOT_FOUND', '指定された添付画像が見つかりません。');
  }

  await assertAttachmentFeatures(tx, tenantId, current.entity_type);

  await tx.query('DELETE FROM attachments WHERE id = $1::uuid', [id]);

  const remaining = await tx.query<{ id: string }>(
    `SELECT id
       FROM attachments
      WHERE entity_type = $1
        AND entity_id = $2::uuid
      ORDER BY sort_order ASC, created_at ASC`,
    [current.entity_type, current.entity_id],
  );
  if (remaining.length > 0) {
    await normalizeSiblingSortOrders(
      tx,
      current.entity_type,
      current.entity_id,
      remaining.map((r) => r.id),
    );
  }

  await removeAttachmentObject({ storageKey: current.storage_key });

  return {
    deletedId: current.id,
    storageKey: current.storage_key,
  };
}
