import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createCodeMaster, listCodeMasters } from '@/lib/masters/codes-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { CodeMasterInput } from '@/lib/masters/types';

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const domainKey = url.searchParams.get('domainKey');
  const includeInactive = url.searchParams.get('includeInactive') !== 'false';
  const items = await listCodeMasters(tx, domainKey, includeInactive);
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<CodeMasterInput>>(req);
  const item = await createCodeMaster(tx, user.tenantId, {
    domainKey: typeof body.domainKey === 'string' ? body.domainKey : '',
    code: typeof body.code === 'string' ? body.code : '',
    name: typeof body.name === 'string' ? body.name : '',
    isActive: body.isActive === undefined ? true : Boolean(body.isActive),
    displayOrder: body.displayOrder === undefined ? 0 : Number(body.displayOrder),
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
