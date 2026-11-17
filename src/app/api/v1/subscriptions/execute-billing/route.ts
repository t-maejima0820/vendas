import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import type { SalesEntryType } from '@/lib/sales/types';
import {
  executeSubscriptionBilling,
  listSubscriptionBillings,
} from '@/lib/subscriptions/subscriptions-service';

export const GET = withApiHandler({ requiredFeature: 'fixedbill' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const targetMonth = url.searchParams.get('targetMonth');
  const items = await listSubscriptionBillings(tx, user.tenantId, targetMonth);
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({ requiredFeature: 'fixedbill' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    targetMonth?: unknown;
    billingDate?: unknown;
    paymentDueDate?: unknown;
    templateVariant?: unknown;
    targets?: unknown;
  }>(req);

  if (typeof body.targetMonth !== 'string' || body.targetMonth.trim() === '') {
    throw new MasterDataError(400, 'TARGET_MONTH_REQUIRED', '対象年月を指定してください。');
  }
  if (typeof body.billingDate !== 'string' || body.billingDate.trim() === '') {
    throw new MasterDataError(400, 'BILLING_DATE_REQUIRED', '請求日を指定してください。');
  }

  let templateVariant: '10_ROWS' | '20_ROWS' | undefined;
  if (body.templateVariant === '10_ROWS' || body.templateVariant === '20_ROWS') {
    templateVariant = body.templateVariant;
  } else if (body.templateVariant !== undefined && body.templateVariant !== null) {
    throw new MasterDataError(400, 'INVALID_TEMPLATE_VARIANT', 'templateVariant が不正です。');
  }

  let targets: Array<{ partnerId: string; entryType: SalesEntryType }> | undefined;
  if (body.targets !== undefined && body.targets !== null) {
    if (!Array.isArray(body.targets)) {
      throw new MasterDataError(400, 'INVALID_TARGETS', 'targets の形式が不正です。');
    }
    targets = body.targets.map((entry, idx) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new MasterDataError(400, 'INVALID_TARGET', `${idx + 1}件目の対象形式が不正です。`);
      }
      const obj = entry as Record<string, unknown>;
      return {
        partnerId: typeof obj.partnerId === 'string' ? obj.partnerId : '',
        entryType: (typeof obj.entryType === 'string' ? obj.entryType : 'SALE') as SalesEntryType,
      };
    });
  }

  const paymentDueDate = typeof body.paymentDueDate === 'string' ? body.paymentDueDate : null;

  const result = await executeSubscriptionBilling(tx, user.tenantId, user.employeeId, {
    targetMonth: body.targetMonth,
    billingDate: body.billingDate,
    paymentDueDate,
    templateVariant,
    targets,
  });

  return NextResponse.json({ ok: true, ...result }, { status: 201 });
});
