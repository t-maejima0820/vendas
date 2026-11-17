import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  extractEntityIdFromRequest,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';
import { parseSalesInputBody } from '@/lib/sales/payload-parser';
import {
  deleteSalesSlip,
  getSalesDetail,
  updateSalesSlip,
} from '@/lib/sales/sales-service';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '売上・立替伝票');
  const item = await getSalesDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '売上・立替伝票');
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await updateSalesSlip(
    tx,
    user.tenantId,
    user.employeeId,
    id,
    parseSalesInputBody(body),
  );
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '売上・立替伝票');
  await deleteSalesSlip(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
