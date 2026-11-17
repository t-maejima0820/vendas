import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parsePurchaseOrderPayload } from '@/lib/purchasing/payload-parser';
import {
  deletePurchaseOrder,
  getPurchaseOrderDetail,
  updatePurchaseOrder,
} from '@/lib/purchasing/purchase-orders-service';

export const GET = withApiHandler({ requiredFeature: 'order' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '発注データ');
  const item = await getPurchaseOrderDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({ requiredFeature: 'order' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '発注データ');
  const body = await parseMasterJsonBody<unknown>(req);
  const payload = parsePurchaseOrderPayload(body);
  const item = await updatePurchaseOrder(tx, user.tenantId, user.employeeId, id, payload);
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'order' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '発注データ');
  await deletePurchaseOrder(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
