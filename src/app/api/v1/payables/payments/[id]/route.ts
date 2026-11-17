import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseSupplierPaymentInputBody } from '@/lib/payables/payload-parser';
import {
  deleteSupplierPayment,
  getSupplierPaymentDetail,
  updateSupplierPayment,
} from '@/lib/payables/payables-service';

export const GET = withApiHandler({ requiredFeature: 'payment' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '支払データ');
  const item = await getSupplierPaymentDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({ requiredFeature: 'payment' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '支払データ');
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await updateSupplierPayment(
    tx,
    user.tenantId,
    user.employeeId,
    id,
    parseSupplierPaymentInputBody(body),
  );
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'payment' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '支払データ');
  await deleteSupplierPayment(tx, user.tenantId, user.employeeId, id);
  return NextResponse.json({ ok: true });
});
