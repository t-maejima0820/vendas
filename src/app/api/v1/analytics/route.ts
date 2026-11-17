import { NextResponse } from 'next/server';
import {
  type AnalyticsDimension,
  getCustomAnalytics,
} from '@/lib/analytics/analytics-service';
import { withApiHandler } from '@/lib/api/handler';

function parseDimension(raw: string | null): AnalyticsDimension {
  if (raw === 'PARTNER' || raw === 'CATEGORY' || raw === 'EMPLOYEE' || raw === 'PERIOD') {
    return raw;
  }
  return 'PARTNER';
}

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const data = await getCustomAnalytics(tx, user.tenantId, {
    dimension: parseDimension(url.searchParams.get('dimension')),
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    keyword: url.searchParams.get('keyword'),
  });
  return NextResponse.json({ ok: true, ...data });
});
