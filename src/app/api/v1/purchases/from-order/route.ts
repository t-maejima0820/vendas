import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseCreatePurchaseFromOrderPayload } from '@/lib/purchasing/payload-parser';
import { createPurchaseFromOrder } from '@/lib/purchasing/purchases-service';

export const POST = withApiHandler({ requiredFeature: 'purchase' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<unknown>(req);
  const parsed = parseCreatePurchaseFromOrderPayload(body);
  const item = await createPurchaseFromOrder(tx, user.tenantId, user.employeeId, parsed);
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
