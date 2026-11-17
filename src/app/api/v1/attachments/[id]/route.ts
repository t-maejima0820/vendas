import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { deleteAttachment, updateAttachment } from '@/lib/attachments/attachment-service';
import {
  extractEntityIdFromRequest,
  MasterDataError,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';

export const PATCH = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '添付画像');
  const body = await parseMasterJsonBody<{
    comment?: unknown;
    moveDirection?: unknown;
    sortOrder?: unknown;
  }>(req);

  let comment: string | null | undefined;
  if (body.comment === null) {
    comment = null;
  } else if (typeof body.comment === 'string') {
    comment = body.comment;
  } else if (body.comment !== undefined) {
    throw new MasterDataError(400, 'INVALID_COMMENT', 'コメントは文字列または null で指定してください。');
  }

  let moveDirection: 'UP' | 'DOWN' | undefined;
  if (body.moveDirection === 'UP' || body.moveDirection === 'DOWN') {
    moveDirection = body.moveDirection;
  } else if (body.moveDirection !== undefined && body.moveDirection !== null) {
    throw new MasterDataError(400, 'INVALID_MOVE_DIRECTION', 'moveDirection は UP または DOWN を指定してください。');
  }

  let sortOrder: number | undefined;
  if (typeof body.sortOrder === 'number' && Number.isInteger(body.sortOrder)) {
    sortOrder = body.sortOrder;
  } else if (body.sortOrder !== undefined && body.sortOrder !== null) {
    throw new MasterDataError(400, 'INVALID_SORT_ORDER', 'sortOrder は整数で指定してください。');
  }

  const item = await updateAttachment(tx, user.tenantId, id, {
    comment,
    moveDirection,
    sortOrder,
  });
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '添付画像');
  await deleteAttachment(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
