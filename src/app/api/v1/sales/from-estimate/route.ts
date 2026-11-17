import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { createSalesFromQuotation } from '@/lib/sales/sales-service';
import type { SalesEntryType } from '@/lib/sales/types';

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<{
    quotationId?: unknown;
    entryType?: unknown;
    slipDate?: unknown;
    updateQuotationStatusToQ2?: unknown;
  }>(req);

  const quotationId = typeof body.quotationId === 'string' ? body.quotationId : '';
  let entryType: SalesEntryType | undefined;
  if (body.entryType === 'SALE' || body.entryType === 'ADVANCE') {
    entryType = body.entryType;
  } else if (body.entryType !== undefined && body.entryType !== null) {
    throw new MasterDataError(400, 'INVALID_ENTRY_TYPE', 'entryType は SALE または ADVANCE を指定してください。');
  }

  const slipDate = typeof body.slipDate === 'string' ? body.slipDate : undefined;
  const updateQuotationStatusToQ2 =
    body.updateQuotationStatusToQ2 === undefined ? true : body.updateQuotationStatusToQ2 === true;

  const item = await createSalesFromQuotation(tx, user.tenantId, user.employeeId, {
    quotationId,
    entryType,
    slipDate,
    updateQuotationStatusToQ2,
  });
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
