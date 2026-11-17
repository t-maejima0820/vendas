import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createUnit, listUnits } from '@/lib/masters/codes-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { UnitInput } from '@/lib/masters/types';

function toUnitInput(body: Partial<UnitInput>): UnitInput {
  return {
    unitCode: typeof body.unitCode === 'string' ? body.unitCode : '',
    unitName: typeof body.unitName === 'string' ? body.unitName : '',
    conversionName: typeof body.conversionName === 'string' ? body.conversionName : null,
    conversionRatio: body.conversionRatio === undefined ? 1 : Number(body.conversionRatio),
    displayOrder: body.displayOrder === undefined ? 99999 : Number(body.displayOrder),
    isDeleted: Boolean(body.isDeleted),
  };
}

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const includeDeleted = url.searchParams.get('includeDeleted') !== 'false';
  const items = await listUnits(tx, includeDeleted);
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<UnitInput>>(req);
  const item = await createUnit(tx, user.tenantId, toUnitInput(body));
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
