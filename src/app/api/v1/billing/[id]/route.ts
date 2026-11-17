import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { cancelBilling, getBillingDetail } from '@/lib/billing/billing-service';
import { extractEntityIdFromRequest } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '請求データ');
  const item = await getBillingDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '請求データ');
  const result = await cancelBilling(tx, user.tenantId, user.employeeId, id);
  return NextResponse.json({ ok: true, ...result });
});
