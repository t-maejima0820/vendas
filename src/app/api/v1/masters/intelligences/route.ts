import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  createInputIntelligence,
  listInputIntelligences,
} from '@/lib/masters/auxiliary-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { InputIntelligenceInput } from '@/lib/masters/types';

function parseTaxCodeValue(val: unknown): 'A' | 'B' | 'C' | 'D' | 'E' {
  if (val === 'A' || val === 'B' || val === 'C' || val === 'D' || val === 'E') {
    return val;
  }
  return 'A';
}

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const rawPage = url.searchParams.get('page');
  const rawSize = url.searchParams.get('pageSize');
  const result = await listInputIntelligences(tx, {
    keyword: url.searchParams.get('q'),
    taxCode: url.searchParams.get('taxCode'),
    page: rawPage !== null ? Number(rawPage) : 1,
    pageSize: rawSize !== null ? Number(rawSize) : 25,
  });
  return NextResponse.json({ ok: true, ...result });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<InputIntelligenceInput>>(req);
  const item = await createInputIntelligence(tx, user.tenantId, {
    itemName: typeof body.itemName === 'string' ? body.itemName : '',
    unitName: typeof body.unitName === 'string' ? body.unitName : null,
    unitPrice: body.unitPrice === undefined ? 0 : Number(body.unitPrice),
    costPrice: body.costPrice === undefined ? 0 : Number(body.costPrice),
    taxCode: parseTaxCodeValue(body.taxCode),
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
