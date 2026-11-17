import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { deleteTaxOffice, updateTaxOffice } from '@/lib/masters/auxiliary-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { TaxOfficeInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '税務署');
  const body = await parseMasterJsonBody<Partial<TaxOfficeInput>>(req);
  const item = await updateTaxOffice(tx, id, {
    taxOfficeCode: typeof body.taxOfficeCode === 'string' ? body.taxOfficeCode : '',
    taxOfficeName: typeof body.taxOfficeName === 'string' ? body.taxOfficeName : '',
    taxOfficeNo: typeof body.taxOfficeNo === 'string' ? body.taxOfficeNo : null,
  });
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '税務署');
  await deleteTaxOffice(tx, id);
  return NextResponse.json({ ok: true });
});
