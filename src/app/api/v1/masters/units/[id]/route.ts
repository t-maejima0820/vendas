import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { updateUnit } from '@/lib/masters/codes-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { UnitInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '単位');
  const body = await parseMasterJsonBody<Partial<UnitInput>>(req);
  const item = await updateUnit(tx, id, {
    unitCode: typeof body.unitCode === 'string' ? body.unitCode : '',
    unitName: typeof body.unitName === 'string' ? body.unitName : '',
    conversionName: typeof body.conversionName === 'string' ? body.conversionName : null,
    conversionRatio: body.conversionRatio === undefined ? 1 : Number(body.conversionRatio),
    displayOrder: body.displayOrder === undefined ? 99999 : Number(body.displayOrder),
    isDeleted: Boolean(body.isDeleted),
  });
  return NextResponse.json({ ok: true, item });
});
