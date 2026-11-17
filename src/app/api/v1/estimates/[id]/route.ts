import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  deleteQuotation,
  getQuotationDetail,
  updateQuotation,
} from '@/lib/estimates/estimates-service';
import { parseQuotationInputBody } from '@/lib/estimates/payload-parser';
import {
  extractEntityIdFromRequest,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';

export const GET = withApiHandler({ requiredFeature: 'estimate' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '見積');
  const item = await getQuotationDetail(tx, user.tenantId, id);
  return NextResponse.json({ ok: true, item });
});

export const PUT = withApiHandler({ requiredFeature: 'estimate' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, '見積');
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await updateQuotation(
    tx,
    user.tenantId,
    user.employeeId,
    id,
    parseQuotationInputBody(body),
  );
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'estimate' }, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '見積');
  await deleteQuotation(tx, id);
  return NextResponse.json({ ok: true });
});
