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

export async function isFeatureEnabled(
  tx: DbExecutor,
  tenantId: string,
  featureCode: VendasFeatureCode,
): Promise<boolean> {
  const rows = await tx.query<{ is_enabled: boolean }>(
    'SELECT is_enabled FROM tenant_feature_authorities WHERE tenant_id = $1 AND feature_code = $2',
    [tenantId, featureCode],
  );
  const first = rows[0];
  if (first === undefined) {
    return false;
  }
  return first.is_enabled;
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
