import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import type { ReceivableStatus } from '@/lib/billing/types';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { updateBillingReceivableStatus } from '@/lib/receivables/receivables-service';

export const PATCH = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    billingId?: unknown;
    status?: unknown;
    receivedAt?: unknown;
  }>(req);

  const billingId = typeof body.billingId === 'string' ? body.billingId.trim() : '';
  if (billingId === '') {
    throw new MasterDataError(400, 'BILLING_ID_REQUIRED', '請求IDを指定してください。');
  }
  const status = body.status as ReceivableStatus;
  const receivedAt = typeof body.receivedAt === 'string' ? body.receivedAt : null;

  const result = await updateBillingReceivableStatus(tx, user.tenantId, user.employeeId, {
    billingId,
    status,
    receivedAt,
  });

  return NextResponse.json({ ok: true, ...result });
});
