import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { deletePaymentMethod, updatePaymentMethod } from '@/lib/masters/codes-service';
import { extractEntityIdFromRequest, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { PaymentMethodInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '支払方法');
  const body = await parseMasterJsonBody<Partial<PaymentMethodInput>>(req);
  const item = await updatePaymentMethod(tx, id, {
    methodCode: typeof body.methodCode === 'string' ? body.methodCode : '',
    methodName: typeof body.methodName === 'string' ? body.methodName : '',
  });
  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '支払方法');
  await deletePaymentMethod(tx, id);
  return NextResponse.json({ ok: true });
});
