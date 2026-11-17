import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { deleteCodeMaster, updateCodeMaster } from '@/lib/masters/codes-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { CodeMasterInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '汎用区分');
  const body = await parseMasterJsonBody<Partial<CodeMasterInput>>(req);
  const item = await updateCodeMaster(tx, id, {
    domainKey: typeof body.domainKey === 'string' ? body.domainKey : '',
    code: typeof body.code === 'string' ? body.code : '',
    name: typeof body.name === 'string' ? body.name : '',
    isActive: body.isActive === undefined ? true : Boolean(body.isActive),
    displayOrder: body.displayOrder === undefined ? 0 : Number(body.displayOrder),
  });
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '汎用区分');
  await deleteCodeMaster(tx, id);
  return NextResponse.json({ ok: true });
});
