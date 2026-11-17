import PayablesClient from '@/app/(dashboard)/payables/PayablesClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';
import {
  getPayablesLookups,
  listPayableBalances,
  listPayableLedgers,
  listSupplierPayments,
} from '@/lib/payables/payables-service';

export default async function PayablesPage({
  searchParams,
}: {
  searchParams: Promise<{
    tab?: string;
    supplierId?: string;
    billNo?: string;
    amount?: string;
  }>;
}) {
  const params = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);

  const data = await runWithPageSession(async ({ user, tx }) => {
    const [payableEnabled, paymentEnabled] = await Promise.all([
      isFeatureEnabled(tx, user.tenantId, 'payable'),
      isFeatureEnabled(tx, user.tenantId, 'payment'),
    ]);
    if (!payableEnabled && !paymentEnabled) {
      return { allowed: false as const };
    }

    const lookups = await getPayablesLookups(tx, user.tenantId);

    let initialTab: 'BALANCES' | 'LEDGERS' | 'PAYMENTS' = 'BALANCES';
    if (params.tab === 'PAYMENTS' && lookups.paymentEnabled) {
      initialTab = 'PAYMENTS';
    } else if (params.tab === 'LEDGERS' && lookups.payableEnabled) {
      initialTab = 'LEDGERS';
    } else if (!lookups.payableEnabled && lookups.paymentEnabled) {
      initialTab = 'PAYMENTS';
    }

    const [initialBalances, initialLedgers, initialPayments] = await Promise.all([
      lookups.payableEnabled
        ? listPayableBalances(tx, user.tenantId, { onlyWithBalance: true })
        : Promise.resolve(null),
      lookups.payableEnabled
        ? listPayableLedgers(tx, user.tenantId, { unpaidOnly: false })
        : Promise.resolve([]),
      lookups.paymentEnabled
        ? listSupplierPayments(tx, user.tenantId, { page: 1, pageSize: 25 })
        : Promise.resolve(null),
    ]);

    return {
      allowed: true as const,
      lookups,
      initialTab,
      initialBalances,
      initialLedgers,
      initialPayments,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「買掛」「支払」機能のいずれも有効化されていません。</p>
      </div>
    );
  }

  return (
    <PayablesClient
      initialTab={data.initialTab}
      defaultPaymentDate={todayIso}
      lookups={data.lookups}
      initialBalances={data.initialBalances}
      initialLedgers={data.initialLedgers}
      initialPayments={data.initialPayments}
      prefillSupplierId={params.supplierId !== undefined ? params.supplierId : null}
      prefillBillNo={params.billNo !== undefined ? params.billNo : null}
      prefillAmount={params.amount !== undefined ? Number(params.amount) : null}
    />
  );
}
