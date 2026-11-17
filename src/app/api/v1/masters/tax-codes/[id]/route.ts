import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { updateTaxCode } from '@/lib/masters/codes-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { TaxCodeUpdateInput } from '@/lib/masters/types';

export const PUT = withApiHandler({ requireAdmin: true }, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '税区分');
  const body = await parseMasterJsonBody<Partial<TaxCodeUpdateInput>>(req);
  const item = await updateTaxCode(tx, id, {
    taxName: typeof body.taxName === 'string' ? body.taxName : '',
    taxRate: body.taxRate === undefined ? 0 : Number(body.taxRate),
    markSymbol: typeof body.markSymbol === 'string' ? body.markSymbol : '',
    isInternal: Boolean(body.isInternal),
  });
  return NextResponse.json({ ok: true, item });
});
