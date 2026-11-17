import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseSalesInputBody } from '@/lib/sales/payload-parser';
import {
  createSalesSlip,
  listSalesSlips,
  type SalesListFilter,
} from '@/lib/sales/sales-service';
import type { ApprovalStatus, SalesEntryType, SalesStatus } from '@/lib/sales/types';

function parseSalesListFilter(url: URL): SalesListFilter {
  const rawEntry = url.searchParams.get('entryType');
  const entryType: SalesEntryType = rawEntry === 'ADVANCE' ? 'ADVANCE' : 'SALE';

  const statusParam = url.searchParams.get('status');
  const status: SalesStatus | null =
    statusParam === 'K1' ||
    statusParam === 'K2' ||
    statusParam === 'K3' ||
    statusParam === 'K4' ||
    statusParam === 'K5' ||
    statusParam === 'K6'
      ? statusParam
      : null;

  const approvalParam = url.searchParams.get('approvalStatus');
  const approvalStatus: ApprovalStatus | null =
    approvalParam === '0' ? 0 : approvalParam === '1' ? 1 : approvalParam === '2' ? 2 : null;

  const projectLinkParam = url.searchParams.get('projectLink');
  const projectLink =
    projectLinkParam === 'LINKED' || projectLinkParam === 'UNLINKED' ? projectLinkParam : 'ALL';

  const rawPage = url.searchParams.get('page');
  const rawSize = url.searchParams.get('pageSize');

  return {
    entryType,
    keyword: url.searchParams.get('q'),
    status,
    approvalStatus,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    projectLink,
    page: rawPage !== null ? Number(rawPage) : 1,
    pageSize: rawSize !== null ? Number(rawSize) : 25,
  };
}

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const result = await listSalesSlips(tx, user.tenantId, parseSalesListFilter(url));
  return NextResponse.json({ ok: true, ...result });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await createSalesSlip(tx, user.tenantId, user.employeeId, parseSalesInputBody(body));
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
