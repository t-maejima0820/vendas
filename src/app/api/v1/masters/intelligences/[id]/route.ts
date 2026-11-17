import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  deleteInputIntelligence,
  updateInputIntelligence,
} from '@/lib/masters/auxiliary-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { InputIntelligenceInput } from '@/lib/masters/types';

function parseTaxCodeValue(val: unknown): 'A' | 'B' | 'C' | 'D' | 'E' {
  if (val === 'A' || val === 'B' || val === 'C' || val === 'D' || val === 'E') {
    return val;
  }
  return 'A';
}

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '入力候補');
  const body = await parseMasterJsonBody<Partial<InputIntelligenceInput>>(req);
  const item = await updateInputIntelligence(tx, id, {
    itemName: typeof body.itemName === 'string' ? body.itemName : '',
    unitName: typeof body.unitName === 'string' ? body.unitName : null,
    unitPrice: body.unitPrice === undefined ? 0 : Number(body.unitPrice),
    costPrice: body.costPrice === undefined ? 0 : Number(body.costPrice),
    taxCode: parseTaxCodeValue(body.taxCode),
  });
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '入力候補');
  await deleteInputIntelligence(tx, id);
  return NextResponse.json({ ok: true });
});
