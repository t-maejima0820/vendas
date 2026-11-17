import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { duplicateQuotation } from '@/lib/estimates/estimates-service';
import { MasterDataError } from '@/lib/masters/error-mapper';

function extractQuotationIdForAction(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter((s) => s.length > 0);
  const id = segments[segments.length - 2];
  if (id === undefined || id.trim() === '') {
    throw new MasterDataError(400, 'INVALID_ID', '複写元の見積IDが指定されていません。');
  }
  return decodeURIComponent(id);
}

export const POST = withApiHandler({ requiredFeature: 'estimate' }, async ({ req, user, tx }) => {
  const sourceId = extractQuotationIdForAction(req);
  const item = await duplicateQuotation(tx, user.tenantId, user.employeeId, sourceId);
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
