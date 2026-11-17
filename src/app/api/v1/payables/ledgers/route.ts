import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import {
  listPayableLedgers,
  updatePayableLedgerStatus,
} from '@/lib/payables/payables-service';
import type { PayableStatus } from '@/lib/purchasing/types';

export const GET = withApiHandler({ requiredFeature: 'payable' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const statusRaw = url.searchParams.get('status');
  const status = statusRaw === 'A1' || statusRaw === 'A2' ? (statusRaw as PayableStatus) : null;

  const items = await listPayableLedgers(tx, user.tenantId, {
    supplierId: url.searchParams.get('supplierId'),
    projectId: url.searchParams.get('projectId'),
    status,
    keyword: url.searchParams.get('q'),
    unpaidOnly: url.searchParams.get('unpaidOnly') === '1',
  });
  return NextResponse.json({ ok: true, items });
});

export const PATCH = withApiHandler({ requiredFeature: 'payment' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const ledgerId = typeof body.ledgerId === 'string' ? body.ledgerId.trim() : '';
  if (ledgerId === '') {
    throw new MasterDataError(400, 'LEDGER_ID_REQUIRED', '買掛台帳IDを指定してください。');
  }
  const status = body.status;
  if (status !== 'A1' && status !== 'A2') {
    throw new MasterDataError(400, 'INVALID_STATUS', '買掛ステータスは A1 / A2 を指定してください。');
  }
  const scheduledPayAt = typeof body.scheduledPayAt === 'string' ? body.scheduledPayAt.trim() : null;

  const item = await updatePayableLedgerStatus(tx, user.tenantId, user.employeeId, {
    ledgerId,
    status,
    scheduledPayAt,
  });
  return NextResponse.json({ ok: true, item });
});
