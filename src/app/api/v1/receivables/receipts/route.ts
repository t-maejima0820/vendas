import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseCashReceiptInputBody } from '@/lib/receivables/payload-parser';
import { createCashReceipt, listCashReceipts } from '@/lib/receivables/receivables-service';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const rawSource = url.searchParams.get('sourceKind');
  const sourceKind =
    rawSource === 'MANUAL' || rawSource === 'APLUS' ? rawSource : 'ALL';
  const rawPage = url.searchParams.get('page');
  const rawSize = url.searchParams.get('pageSize');

  const result = await listCashReceipts(tx, user.tenantId, {
    keyword: url.searchParams.get('q'),
    partnerId: url.searchParams.get('partnerId'),
    sourceKind,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    billNo: url.searchParams.get('billNo'),
    page: rawPage !== null ? Number(rawPage) : 1,
    pageSize: rawSize !== null ? Number(rawSize) : 25,
  });

  return NextResponse.json({ ok: true, ...result });
});

export const POST = withApiHandler({ requiredFeature: 'deposit' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const parsed = parseCashReceiptInputBody(body);
  const item = await createCashReceipt(tx, user.tenantId, user.employeeId, parsed);
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
