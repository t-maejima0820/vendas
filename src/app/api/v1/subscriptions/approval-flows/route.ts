import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { ApprovalStatus, SalesEntryType } from '@/lib/sales/types';
import {
  listMonthlyApprovalFlows,
  updateMonthlyApprovalFlows,
} from '@/lib/subscriptions/subscriptions-service';

function currentYearMonth(): string {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}${m}`;
}

export const GET = withApiHandler({ requiredFeature: 'fixedbill' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const targetMonth = url.searchParams.get('targetMonth') ?? currentYearMonth();
  const rawEntry = url.searchParams.get('entryType');
  const entryType: 'ALL' | SalesEntryType =
    rawEntry === 'SALE' || rawEntry === 'ADVANCE' ? rawEntry : 'ALL';

  const result = await listMonthlyApprovalFlows(tx, user.tenantId, targetMonth, {
    keyword: url.searchParams.get('q'),
    entryType,
  });
  return NextResponse.json({ ok: true, ...result });
});

export const PUT = withApiHandler({ requiredFeature: 'fixedbill' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    targetMonth?: unknown;
    items?: unknown;
  }>(req);

  const targetMonth = typeof body.targetMonth === 'string' ? body.targetMonth : '';
  if (!Array.isArray(body.items)) {
    throw new MasterDataError(400, 'ITEMS_REQUIRED', '承認更新対象配列 (items) を指定してください。');
  }

  const parsedItems = body.items.map((entry, idx) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new MasterDataError(400, 'INVALID_ITEM', `${idx + 1}件目の形式が不正です。`);
    }
    const obj = entry as Record<string, unknown>;
    const partnerId = typeof obj.partnerId === 'string' ? obj.partnerId : '';
    const entryType = (obj.entryType === 'ADVANCE' ? 'ADVANCE' : 'SALE') as SalesEntryType;
    const rawStatus = obj.flowStatus;
    if (rawStatus !== 0 && rawStatus !== 1 && rawStatus !== 2) {
      throw new MasterDataError(400, 'INVALID_FLOW_STATUS', `${idx + 1}件目の承認ステータスが不正です。`);
    }
    const remarks =
      typeof obj.remarks === 'string' ? obj.remarks : obj.remarks === null ? null : undefined;
    return {
      partnerId,
      entryType,
      flowStatus: rawStatus as ApprovalStatus,
      remarks,
    };
  });

  const result = await updateMonthlyApprovalFlows(tx, user.tenantId, user.employeeId, {
    targetMonth,
    items: parsedItems,
  });
  return NextResponse.json({ ok: true, ...result });
});
