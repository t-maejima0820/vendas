import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { confirmBilling, listBillingHeaders } from '@/lib/billing/billing-service';
import {
  parseBillingListFilterFromUrl,
  parseConfirmBillingBody,
} from '@/lib/billing/payload-parser';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const result = await listBillingHeaders(tx, user.tenantId, parseBillingListFilterFromUrl(url));
  return NextResponse.json({ ok: true, ...result });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const parsed = parseConfirmBillingBody(body);
  const result = await confirmBilling(tx, user.tenantId, user.employeeId, parsed);
  return NextResponse.json({ ok: true, ...result }, { status: 201 });
});
