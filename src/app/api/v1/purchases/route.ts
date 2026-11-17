import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parsePurchasePayload } from '@/lib/purchasing/payload-parser';
import { createPurchase, listPurchases } from '@/lib/purchasing/purchases-service';
import type { PurchaseStatus } from '@/lib/purchasing/types';

function parseFilter(url: URL) {
  const statusRaw = url.searchParams.get('status');
  const status =
    statusRaw === 'P1' || statusRaw === 'P2' || statusRaw === 'P3'
      ? (statusRaw as PurchaseStatus)
      : null;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const sizeRaw = Number(url.searchParams.get('pageSize') ?? '25');
  return {
    keyword: url.searchParams.get('keyword'),
    supplierId: url.searchParams.get('supplierId'),
    status,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    pageSize: Number.isInteger(sizeRaw) && sizeRaw >= 1 ? sizeRaw : 25,
  };
}

export const GET = withApiHandler({ requiredFeature: 'purchase' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const pageData = await listPurchases(tx, user.tenantId, parseFilter(url));
  return NextResponse.json({ ok: true, ...pageData });
});

export const POST = withApiHandler({ requiredFeature: 'purchase' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<unknown>(req);
  const payload = parsePurchasePayload(body);
  const item = await createPurchase(tx, user.tenantId, user.employeeId, payload);
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
