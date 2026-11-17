import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  createQuotation,
  listQuotations,
  type QuotationListFilter,
} from '@/lib/estimates/estimates-service';
import { parseQuotationInputBody } from '@/lib/estimates/payload-parser';
import type { QuotationStatus } from '@/lib/estimates/types';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';

function parseListFilterFromUrl(url: URL): QuotationListFilter {
  const statusParam = url.searchParams.get('status');
  const status: QuotationStatus | null =
    statusParam === 'Q1' || statusParam === 'Q2' || statusParam === 'Q3' ? statusParam : null;
  const projectLinkParam = url.searchParams.get('projectLink');
  const projectLink =
    projectLinkParam === 'LINKED' || projectLinkParam === 'UNLINKED' ? projectLinkParam : 'ALL';
  const selectedParam = url.searchParams.get('selected');
  const selectedFilter =
    selectedParam === 'SELECTED' || selectedParam === 'UNSELECTED' ? selectedParam : 'ALL';
  const rawPage = url.searchParams.get('page');
  const rawSize = url.searchParams.get('pageSize');

  return {
    keyword: url.searchParams.get('q'),
    status,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    projectLink,
    selectedFilter,
    page: rawPage !== null ? Number(rawPage) : 1,
    pageSize: rawSize !== null ? Number(rawSize) : 25,
  };
}

export const GET = withApiHandler({ requiredFeature: 'estimate' }, async ({ req, tx }) => {
  const url = new URL(req.url);
  const result = await listQuotations(tx, parseListFilterFromUrl(url));
  return NextResponse.json({ ok: true, ...result });
});

export const POST = withApiHandler({ requiredFeature: 'estimate' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  const item = await createQuotation(tx, user.tenantId, user.employeeId, parseQuotationInputBody(body));
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
