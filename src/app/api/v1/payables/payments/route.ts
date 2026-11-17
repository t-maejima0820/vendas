import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseSupplierPaymentInputBody } from '@/lib/payables/payload-parser';
import {
  createSupplierPayment,
  listSupplierPayments,
} from '@/lib/payables/payables-service';

export const GET = withApiHandler({ requiredFeature: 'payment' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const sizeRaw = Number(url.searchParams.get('pageSize') ?? '25');
  const data = await listSupplierPayments(tx, user.tenantId, {
    keyword: url.searchParams.get('q'),
    supplierId: url.searchParams.get('supplierId'),
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    billNo: url.searchParams.get('billNo'),
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    pageSize: Number.isInteger(sizeRaw) && sizeRaw >= 1 ? sizeRaw : 25,
  });
  return NextResponse.json({ ok: true, ...data });
});

export const POST = withApiHandler({ requiredFeature: 'payment' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await createSupplierPayment(
    tx,
    user.tenantId,
    user.employeeId,
    parseSupplierPaymentInputBody(body),
  );
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
