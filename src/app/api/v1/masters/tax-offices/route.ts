import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createTaxOffice, listTaxOffices } from '@/lib/masters/auxiliary-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { TaxOfficeInput } from '@/lib/masters/types';

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const items = await listTaxOffices(tx, url.searchParams.get('q'));
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<TaxOfficeInput>>(req);
  const item = await createTaxOffice(tx, user.tenantId, {
    taxOfficeCode: typeof body.taxOfficeCode === 'string' ? body.taxOfficeCode : '',
    taxOfficeName: typeof body.taxOfficeName === 'string' ? body.taxOfficeName : '',
    taxOfficeNo: typeof body.taxOfficeNo === 'string' ? body.taxOfficeNo : null,
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
