import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { getDashboardOverview } from '@/lib/dashboard/dashboard-service';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const targetMonth = url.searchParams.get('targetMonth');
  const overview = await getDashboardOverview(tx, user.tenantId, targetMonth);
  return NextResponse.json({ ok: true, overview });
});
