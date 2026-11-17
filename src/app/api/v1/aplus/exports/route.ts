import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { generateAplusExports, listAplusExports } from '@/lib/aplus/aplus-service';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({ requiredFeature: 'aplus' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const transferDate = url.searchParams.get('transferDate');
  const items = await listAplusExports(tx, user.tenantId, { transferDate });
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({ requiredFeature: 'aplus' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    transferDate?: unknown;
    consignorCode?: unknown;
    breakdownNo?: unknown;
    periodStart?: unknown;
    periodEnd?: unknown;
    replaceUnexported?: unknown;
  }>(req);

  const transferDate = typeof body.transferDate === 'string' ? body.transferDate : '';
  const consignorCode = typeof body.consignorCode === 'string' ? body.consignorCode : '';
  const periodStart = typeof body.periodStart === 'string' ? body.periodStart : '';
  const periodEnd = typeof body.periodEnd === 'string' ? body.periodEnd : '';
  const breakdownNo = typeof body.breakdownNo === 'string' ? body.breakdownNo : undefined;

  if (transferDate === '' || consignorCode === '' || periodStart === '' || periodEnd === '') {
    throw new MasterDataError(
      400,
      'APLUS_GENERATE_PARAMS_REQUIRED',
      '振替日・委託者コード・集計期間開始/終了日を指定してください。',
    );
  }

  const items = await generateAplusExports(tx, user.tenantId, {
    transferDate,
    consignorCode,
    breakdownNo,
    periodStart,
    periodEnd,
    replaceUnexported: body.replaceUnexported !== false,
  });

  return NextResponse.json({ ok: true, items }, { status: 201 });
});
