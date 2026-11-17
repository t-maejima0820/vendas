import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parsePayableBalanceFilterFromUrl } from '@/lib/payables/payload-parser';
import { getPayablesLookups, listPayableBalances } from '@/lib/payables/payables-service';

export const GET = withApiHandler({ requiredFeature: 'payable' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  if (url.searchParams.get('include') === 'lookups') {
    const lookups = await getPayablesLookups(tx, user.tenantId);
    return NextResponse.json({ ok: true, lookups });
  }
  const result = await listPayableBalances(
    tx,
    user.tenantId,
    parsePayableBalanceFilterFromUrl(url),
  );
  return NextResponse.json({ ok: true, ...result });
});
