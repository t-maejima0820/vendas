import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parsePurchasePayload } from '@/lib/purchasing/payload-parser';
import {
  deletePurchase,
  getPurchaseDetail,
  updatePurchase,
} from '@/lib/purchasing/purchases-service';

export const GET = withApiHandler({ requiredFeature: 'purchase' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '仕入データ');
  const item = await getPurchaseDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({ requiredFeature: 'purchase' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '仕入データ');
  const body = await parseMasterJsonBody<unknown>(req);
  const payload = parsePurchasePayload(body);
  const item = await updatePurchase(tx, user.tenantId, user.employeeId, id, payload);
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'purchase' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '仕入データ');
  await deletePurchase(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
