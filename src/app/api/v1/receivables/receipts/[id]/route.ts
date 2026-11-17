import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseCashReceiptInputBody } from '@/lib/receivables/payload-parser';
import {
  deleteCashReceipt,
  getCashReceiptDetail,
  updateCashReceipt,
} from '@/lib/receivables/receivables-service';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '入金データ');
  const item = await getCashReceiptDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({ requiredFeature: 'deposit' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '入金データ');
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await updateCashReceipt(
    tx,
    user.tenantId,
    user.employeeId,
    id,
    parseCashReceiptInputBody(body),
  );
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'deposit' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '入金データ');
  await deleteCashReceipt(tx, user.tenantId, user.employeeId, id);
  return NextResponse.json({ ok: true });
});
