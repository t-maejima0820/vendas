import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { cancelBilling } from '@/lib/billing/billing-service';
import { MasterDataError } from '@/lib/masters/error-mapper';

function extractBillingIdFromSubpath(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter((s) => s.length > 0);
  const id = segments[segments.length - 2];
  if (id === undefined || id.trim() === '') {
    throw new MasterDataError(400, 'INVALID_ID', '請求IDが指定されていません。');
  }
  return decodeURIComponent(id);
}

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const billingId = extractBillingIdFromSubpath(req);
  const result = await cancelBilling(tx, user.tenantId, user.employeeId, billingId);
  return NextResponse.json({ ok: true, ...result });
});
