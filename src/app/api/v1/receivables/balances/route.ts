import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import type { ReceivableStatus } from '@/lib/billing/types';
import { parseReceivableBalanceFilterFromUrl } from '@/lib/receivables/payload-parser';
import { listReceivableBalances, listUnpaidBillings } from '@/lib/receivables/receivables-service';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode');

  if (mode === 'unpaid') {
    const statusParam = url.searchParams.get('status');
    const status: ReceivableStatus | null =
      statusParam === 'N1' || statusParam === 'N2' || statusParam === 'N3' || statusParam === 'N4'
        ? statusParam
        : null;
    const unpaidItems = await listUnpaidBillings(tx, user.tenantId, {
      partnerId: url.searchParams.get('partnerId'),
      status,
      keyword: url.searchParams.get('q'),
      unpaidOnly: url.searchParams.get('unpaidOnly') === '1',
    });
    return NextResponse.json({ ok: true, items: unpaidItems });
  }

  const filter = parseReceivableBalanceFilterFromUrl(url);
  const result = await listReceivableBalances(tx, user.tenantId, filter);
  return NextResponse.json({ ok: true, ...result });
});
