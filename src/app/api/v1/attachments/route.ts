import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  listAttachments,
  uploadAttachment,
  type AttachmentEntityType,
} from '@/lib/attachments/attachment-service';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';

function parseEntityType(raw: unknown): AttachmentEntityType {
  if (raw === 'QUOTATION' || raw === 'PROJECT') {
    return raw;
  }
  throw new MasterDataError(
    400,
    'INVALID_ENTITY_TYPE',
    'entityType は QUOTATION または PROJECT を指定してください。',
  );
}

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const entityType = parseEntityType(url.searchParams.get('entityType') ?? 'QUOTATION');
  const entityId = url.searchParams.get('entityId') ?? '';
  const items = await listAttachments(tx, user.tenantId, entityType, entityId);
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const contentType = req.headers.get('content-type') ?? '';

  let entityType: AttachmentEntityType;
  let entityId: string;
  let originalName: string;
  let fileBytes: Uint8Array;
  let comment: string | null = null;

  if (contentType.toLowerCase().includes('multipart/form-data')) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch (err) {
      throw new MasterDataError(
        400,
        'INVALID_MULTIPART',
        err instanceof Error ? 'マルチパートフォームデータの解析に失敗しました。' : 'マルチパート解析失敗',
      );
    }
    entityType = parseEntityType(formData.get('entityType') ?? 'QUOTATION');
    const rawEntityId = formData.get('entityId');
    entityId = typeof rawEntityId === 'string' ? rawEntityId : '';
    const rawComment = formData.get('comment');
    comment = typeof rawComment === 'string' ? rawComment : null;
    const rawFile = formData.get('file');
    if (!(rawFile instanceof Blob)) {
      throw new MasterDataError(400, 'FILE_REQUIRED', 'アップロードする画像ファイル (file) が指定されていません。');
    }
    originalName = rawFile instanceof File ? rawFile.name : 'upload';
    const arrBuf = await rawFile.arrayBuffer();
    fileBytes = new Uint8Array(arrBuf);
  } else {
    const body = await parseMasterJsonBody<{
      entityType?: unknown;
      entityId?: unknown;
      originalName?: unknown;
      contentBase64?: unknown;
      comment?: unknown;
    }>(req);
    entityType = parseEntityType(body.entityType ?? 'QUOTATION');
    entityId = typeof body.entityId === 'string' ? body.entityId : '';
    originalName = typeof body.originalName === 'string' ? body.originalName : 'upload';
    comment = typeof body.comment === 'string' ? body.comment : null;
    if (typeof body.contentBase64 !== 'string' || body.contentBase64.trim() === '') {
      throw new MasterDataError(400, 'FILE_REQUIRED', '画像データ (contentBase64) が指定されていません。');
    }
    const cleanB64 = body.contentBase64.replace(/^data:[^;]+;base64,/, '');
    fileBytes = new Uint8Array(Buffer.from(cleanB64, 'base64'));
  }

  const item = await uploadAttachment(tx, {
    tenantId: user.tenantId,
    employeeId: user.employeeId,
    entityType,
    entityId,
    originalName,
    fileBytes,
    comment,
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
