import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError } from '@/lib/masters/error-mapper';
import { cancelPurchaseConfirmation } from '@/lib/purchasing/purchases-service';

function extractPurchaseIdFromCancelPath(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter((s) => s.length > 0);
  const id = segments[segments.length - 2];
  if (id === undefined || id.trim() === '') {
    throw new MasterDataError(400, 'INVALID_ID', '仕入IDが指定されていません。');
  }
  return decodeURIComponent(id);
}

export const POST = withApiHandler({ requiredFeature: 'purchase' }, async ({ req, user, tx }) => {
  const id = extractPurchaseIdFromCancelPath(req);
  const item = await cancelPurchaseConfirmation(tx, user.tenantId, user.employeeId, id);
  return NextResponse.json({ ok: true, item });
});
