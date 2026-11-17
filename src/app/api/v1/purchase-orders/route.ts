import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parsePurchaseOrderPayload } from '@/lib/purchasing/payload-parser';
import {
  createPurchaseOrder,
  getPurchasingLookups,
  listPurchaseOrders,
} from '@/lib/purchasing/purchase-orders-service';
import type { OrderStatus } from '@/lib/purchasing/types';

function parseFilter(url: URL) {
  const statusRaw = url.searchParams.get('status');
  const status =
    statusRaw === 'O1' || statusRaw === 'O2' || statusRaw === 'O3'
      ? (statusRaw as OrderStatus)
      : null;

  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const sizeRaw = Number(url.searchParams.get('pageSize') ?? '25');

  return {
    keyword: url.searchParams.get('keyword'),
    supplierId: url.searchParams.get('supplierId'),
    projectId: url.searchParams.get('projectId'),
    status,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    pageSize: Number.isInteger(sizeRaw) && sizeRaw >= 1 ? sizeRaw : 25,
  };
}

export const GET = withApiHandler({ requiredFeature: 'order' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  if (url.searchParams.get('include') === 'lookups') {
    const lookups = await getPurchasingLookups(tx, user.tenantId);
    return NextResponse.json({ ok: true, lookups });
  }
  const pageData = await listPurchaseOrders(tx, user.tenantId, parseFilter(url));
  return NextResponse.json({ ok: true, ...pageData });
});

export const POST = withApiHandler({ requiredFeature: 'order' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<unknown>(req);
  if (body === null || typeof body !== 'object') {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', '発注データが不正です。');
  }
  const payload = parsePurchaseOrderPayload(body);
  const item = await createPurchaseOrder(tx, user.tenantId, user.employeeId, payload);
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
