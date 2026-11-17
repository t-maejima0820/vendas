import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  listBillingCandidates,
  updateCandidateAggregationStatus,
} from '@/lib/billing/billing-service';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const result = await listBillingCandidates(tx, user.tenantId, {
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    closingDayCode: url.searchParams.get('closingDayCode'),
    partnerId: url.searchParams.get('partnerId'),
    keyword: url.searchParams.get('q'),
    balancePeriodStart: url.searchParams.get('balancePeriodStart'),
    balancePeriodEnd: url.searchParams.get('balancePeriodEnd'),
  });
  return NextResponse.json({ ok: true, ...result });
});

export const PATCH = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    slipIds?: unknown;
    targetStatus?: unknown;
  }>(req);

  if (!Array.isArray(body.slipIds) || body.slipIds.length === 0) {
    throw new MasterDataError(400, 'SLIP_IDS_REQUIRED', '対象伝票IDを指定してください。');
  }
  const slipIds = body.slipIds.map((v) => (typeof v === 'string' ? v : ''));
  const targetStatus = body.targetStatus;
  if (targetStatus !== 'K2' && targetStatus !== 'K3') {
    throw new MasterDataError(400, 'INVALID_STATUS', '集計状態は K2 または K3 を指定してください。');
  }

  const result = await updateCandidateAggregationStatus(tx, user.tenantId, user.employeeId, {
    slipIds,
    targetStatus,
  });
  return NextResponse.json({ ok: true, ...result });
});
