import StockClient from '@/app/(dashboard)/stock/StockClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { isFeatureEnabled } from '@/lib/feature-flags/gate';
import { listStockProducts } from '@/lib/stock/stock-service';

export default async function StockPage() {
  const data = await runWithPageSession(async ({ user, tx }) => {
    const stockEnabled = await isFeatureEnabled(tx, user.tenantId, 'stock');
    if (!stockEnabled) {
      return { allowed: false as const };
    }
    const initialPage = await listStockProducts(tx, user.tenantId, {});
    return { allowed: true as const, initialPage };
  });

  if (!data.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>このテナントでは「在庫管理」機能（stock）が有効化されていません。</p>
      </div>
    );
  }

  return <StockClient initialPage={data.initialPage} />;
}
