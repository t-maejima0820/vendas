import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { getSalesProductSummary } from '@/lib/sales/sales-service';
import type { SalesEntryType } from '@/lib/sales/types';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const rawEntry = url.searchParams.get('entryTypeFilter');
  const entryTypeFilter: 'ALL' | SalesEntryType =
    rawEntry === 'SALE' || rawEntry === 'ADVANCE' ? rawEntry : 'ALL';

  const result = await getSalesProductSummary(tx, user.tenantId, {
    entryTypeFilter,
    partnerId: url.searchParams.get('partnerId'),
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    keyword: url.searchParams.get('q'),
  });
  return NextResponse.json({ ok: true, ...result });
});
