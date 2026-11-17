import ReceivablesClient from '@/app/(dashboard)/receivables/ReceivablesClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import {
  getReceivablesLookups,
  listCashReceipts,
  listReceivableBalances,
  listUnpaidBillings,
} from '@/lib/receivables/receivables-service';

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    partnerId?: string;
    billNo?: string;
    amount?: string;
  }>;
}) {
  const params = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);

  const data = await runWithPageSession(async ({ user, tx }) => {
    const lookups = await getReceivablesLookups(tx, user.tenantId);
    if (!lookups.receivableEnabled && !lookups.depositEnabled) {
      return { allowed: false as const };
    }

    let initialTab: 'BALANCES' | 'UNPAID' | 'RECEIPTS' = 'BALANCES';
    if (params.tab === 'RECEIPTS' && lookups.depositEnabled) {
      initialTab = 'RECEIPTS';
    } else if (params.tab === 'UNPAID') {
      initialTab = 'UNPAID';
    } else if (!lookups.receivableEnabled && lookups.depositEnabled) {
      initialTab = 'RECEIPTS';
    }

    const [initialBalances, initialUnpaid, initialReceipts] = await Promise.all([
      lookups.receivableEnabled
        ? listReceivableBalances(tx, user.tenantId, {})
        : Promise.resolve(null),
      listUnpaidBillings(tx, user.tenantId, { unpaidOnly: false }),
      listCashReceipts(tx, user.tenantId, { page: 1, pageSize: 25 }),
    ]);

    return {
      allowed: true as const,
      lookups,
      initialTab,
      initialBalances,
      initialUnpaid,
      initialReceipts,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「売掛」「入金」機能のいずれも有効化されていません。</p>
      </div>
    );
  }

  return (
    <ReceivablesClient
      initialTab={data.initialTab}
      defaultReceiptDate={todayIso}
      lookups={data.lookups}
      initialBalances={data.initialBalances}
      initialUnpaid={data.initialUnpaid}
      initialReceipts={data.initialReceipts}
      prefillPartnerId={params.partnerId !== undefined ? params.partnerId : null}
      prefillBillNo={params.billNo !== undefined ? params.billNo : null}
      prefillAmount={params.amount !== undefined ? Number(params.amount) : null}
    />
  );
}
