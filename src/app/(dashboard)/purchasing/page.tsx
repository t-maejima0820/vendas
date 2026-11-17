import PurchasingClient from '@/app/(dashboard)/purchasing/PurchasingClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';
import {
  getPurchasingLookups,
  listPurchaseOrders,
} from '@/lib/purchasing/purchase-orders-service';
import { listPurchases } from '@/lib/purchasing/purchases-service';

export default async function PurchasingPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const params = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);

  const data = await runWithPageSession(async ({ user, tx }) => {
    const [orderEnabled, purchaseEnabled] = await Promise.all([
      isFeatureEnabled(tx, user.tenantId, 'order'),
      isFeatureEnabled(tx, user.tenantId, 'purchase'),
    ]);
    if (!orderEnabled && !purchaseEnabled) {
      return { allowed: false as const };
    }

    const lookups = await getPurchasingLookups(tx, user.tenantId);

    let initialTab: 'ORDERS' | 'PURCHASES' = 'ORDERS';
    if (params.tab === 'PURCHASES' && lookups.purchaseEnabled) {
      initialTab = 'PURCHASES';
    } else if (!lookups.orderEnabled && lookups.purchaseEnabled) {
      initialTab = 'PURCHASES';
    }

    const [initialOrders, initialPurchases] = await Promise.all([
      lookups.orderEnabled
        ? listPurchaseOrders(tx, user.tenantId, { page: 1, pageSize: 25 })
        : Promise.resolve(null),
      lookups.purchaseEnabled
        ? listPurchases(tx, user.tenantId, { page: 1, pageSize: 25 })
        : Promise.resolve(null),
    ]);

    return {
      allowed: true as const,
      lookups,
      initialTab,
      initialOrders,
      initialPurchases,
    };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「発注」「仕入」機能のいずれも有効化されていません。</p>
      </div>
    );
  }

  return (
    <PurchasingClient
      initialTab={data.initialTab}
      todayIso={todayIso}
      lookups={data.lookups}
      initialOrders={data.initialOrders}
      initialPurchases={data.initialPurchases}
    />
  );
}
