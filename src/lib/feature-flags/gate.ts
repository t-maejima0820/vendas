import type { DbExecutor } from '@/lib/db/tenant-client';

export type VendasFeatureCode =
  | 'estimate'
  | 'sales'
  | 'tatekae'
  | 'billsummary'
  | 'billissue'
  | 'fixedbill'
  | 'receivable'
  | 'aplus'
  | 'construction'
  | 'purchase'
  | 'stock'
  | 'payable'
  | 'deposit'
  | 'payment'
  | 'teams'
  | 'cost'
  | 'custom-sum-item'
  | 'order'
  | 'mail'
  | 'item'
  | 'estimateimage'
  | 'constructionimage'
  | 'expense'
  | 'labor'
  | 'material'
  | 'outsourcing'
  | 'temporary'
  | 'indirect'
  | 'budget';

export class FeatureDisabledError extends Error {
  constructor(featureCode: VendasFeatureCode) {
    super(`このテナントでは機能 '${featureCode}' は有効化されていません`);
    this.name = 'FeatureDisabledError';
  }
}

/**
 * トランザクション単位（txオブジェクト参照）に紐づく機能権限キャッシュ。
 * リクエストを跨ぐグローバルキャッシュは持たず、設定画面での即時反映・テスト隔離と両立する。
 */
const txFeatureCache = new WeakMap<DbExecutor, Map<string, Map<string, boolean>>>();

export function primeFeatureCacheForTx(
  tx: DbExecutor,
  tenantId: string,
  features: ReadonlyMap<string, boolean>,
): void {
  let byTenant = txFeatureCache.get(tx);
  if (byTenant === undefined) {
    byTenant = new Map<string, Map<string, boolean>>();
    txFeatureCache.set(tx, byTenant);
  }
  byTenant.set(tenantId, new Map(features));
}

export function clearFeatureCacheForTx(tx: DbExecutor): void {
  txFeatureCache.delete(tx);
}

export async function isFeatureEnabled(
  tx: DbExecutor,
  tenantId: string,
  featureCode: VendasFeatureCode,
): Promise<boolean> {
  const byTenant = txFeatureCache.get(tx);
  const cachedMap = byTenant?.get(tenantId);
  if (cachedMap !== undefined) {
    return cachedMap.get(featureCode) === true;
  }

  const rows = await tx.query<{ feature_code: string; is_enabled: boolean }>(
    'SELECT feature_code, is_enabled FROM tenant_feature_authorities WHERE tenant_id = $1',
    [tenantId],
  );
  const nextMap = new Map<string, boolean>();
  for (const r of rows) {
    nextMap.set(r.feature_code, r.is_enabled === true);
  }
  primeFeatureCacheForTx(tx, tenantId, nextMap);
  return nextMap.get(featureCode) === true;
}

export async function requireFeature(
  tx: DbExecutor,
  tenantId: string,
  featureCode: VendasFeatureCode,
): Promise<void> {
  const enabled = await isFeatureEnabled(tx, tenantId, featureCode);
  if (!enabled) {
    throw new FeatureDisabledError(featureCode);
  }
}
