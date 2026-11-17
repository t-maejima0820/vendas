import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { deleteAplusExportRow, updateAplusExportRow } from '@/lib/aplus/aplus-service';
import {
  extractEntityIdFromRequest,
  MasterDataError,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';

export const PATCH = withApiHandler({ requiredFeature: 'aplus' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, 'アプラス出力行');
  const body = await parseMasterJsonBody<{
    variableAmount?: unknown;
    uncollectedTotal?: unknown;
    consignorCode?: unknown;
    customerNo?: unknown;
    breakdownNo?: unknown;
  }>(req);

  let variableAmount: number | undefined;
  if (body.variableAmount !== undefined) {
    const num = Number(body.variableAmount);
    if (!Number.isFinite(num) || !Number.isInteger(num)) {
      throw new MasterDataError(400, 'INVALID_AMOUNT', '変動調整額は整数で指定してください。');
    }
    variableAmount = num;
  }

  let uncollectedTotal: number | undefined;
  if (body.uncollectedTotal !== undefined) {
    const num = Number(body.uncollectedTotal);
    if (!Number.isFinite(num) || !Number.isInteger(num)) {
      throw new MasterDataError(400, 'INVALID_AMOUNT', '未回収残高は整数で指定してください。');
    }
    uncollectedTotal = num;
  }

  const item = await updateAplusExportRow(tx, user.tenantId, id, {
    variableAmount,
    uncollectedTotal,
    consignorCode: typeof body.consignorCode === 'string' ? body.consignorCode : undefined,
    customerNo: typeof body.customerNo === 'string' ? body.customerNo : undefined,
    breakdownNo: typeof body.breakdownNo === 'string' ? body.breakdownNo : undefined,
  });

  return NextResponse.json({ ok: true, item });
});

export const DELETE = withApiHandler({ requiredFeature: 'aplus' }, async ({ req, user, tx }) => {
  const id = extractEntityIdFromRequest(req, 'アプラス出力行');
  await deleteAplusExportRow(tx, user.tenantId, id);
  return NextResponse.json({ ok: true });
});
