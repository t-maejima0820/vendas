import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createPaymentMethod, listPaymentMethods } from '@/lib/masters/codes-service';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { PaymentMethodInput } from '@/lib/masters/types';

export const GET = withApiHandler({}, async ({ tx }) => {
  const items = await listPaymentMethods(tx);
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<PaymentMethodInput>>(req);
  const item = await createPaymentMethod(tx, user.tenantId, {
    methodCode: typeof body.methodCode === 'string' ? body.methodCode : '',
    methodName: typeof body.methodName === 'string' ? body.methodName : '',
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
