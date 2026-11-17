import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { updateSalesApproval } from '@/lib/sales/sales-service';
import type { ApprovalStatus } from '@/lib/sales/types';

export const PATCH = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    ids?: unknown;
    approvalStatus?: unknown;
    approvalRemarks?: unknown;
    nextStatus?: unknown;
  }>(req);

  if (!Array.isArray(body.ids)) {
    throw new MasterDataError(400, 'IDS_REQUIRED', '対象伝票ID配列 (ids) を指定してください。');
  }
  const ids = body.ids.filter((v): v is string => typeof v === 'string');

  if (body.approvalStatus !== 0 && body.approvalStatus !== 1 && body.approvalStatus !== 2) {
    throw new MasterDataError(400, 'INVALID_APPROVAL_STATUS', 'approvalStatus は 0 / 1 / 2 を指定してください。');
  }
  const approvalStatus = body.approvalStatus as ApprovalStatus;

  let approvalRemarks: string | null | undefined;
  if (body.approvalRemarks === null) {
    approvalRemarks = null;
  } else if (typeof body.approvalRemarks === 'string') {
    approvalRemarks = body.approvalRemarks;
  }

  let nextStatus: 'K1' | 'K2' | 'K3' | 'K6' | undefined;
  if (
    body.nextStatus === 'K1' ||
    body.nextStatus === 'K2' ||
    body.nextStatus === 'K3' ||
    body.nextStatus === 'K6'
  ) {
    nextStatus = body.nextStatus;
  } else if (body.nextStatus !== undefined && body.nextStatus !== null) {
    throw new MasterDataError(400, 'INVALID_STATUS', 'nextStatus は K1 / K2 / K3 / K6 のみ指定できます。');
  }

  const result = await updateSalesApproval(tx, user.tenantId, user.employeeId, {
    ids,
    approvalStatus,
    approvalRemarks,
    nextStatus,
  });
  return NextResponse.json({ ok: true, ...result });
});
