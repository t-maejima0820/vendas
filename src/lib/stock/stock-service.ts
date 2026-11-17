import Decimal from 'decimal.js';
import type { DbExecutor } from '@/lib/db/tenant-client';
import { applyRounding, type RoundingMode } from '@/lib/domain/calculations';
import { renderStockListPdf } from '@/lib/domain/pdf-renderer';
import { requireFeature } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StockProductItemDto {
  id: string;
  productCode: string;
  productName: string;
  productNameSub: string | null;
  categoryCode: string | null;
  categoryName: string;
  unitName: string;
  isStockManaged: boolean;
  stockQuantity: number;
  standardCostPrice: number;
  standardUnitPrice: number;
  purchasedQty: number;
  soldQty: number;
  costConsumedQty: number;
  theoreticalStockQty: number;
  stockValuation: number;
  updatedAt: string;
}

export interface StockPageDto {
  items: StockProductItemDto[];
  totalCount: number;
  managedCount: number;
  totalStockQuantity: number;
  totalValuation: number;
}

export interface StockListFilter {
  keyword?: string | null;
  managedOnly?: boolean;
  categoryCode?: string | null;
}

function escapeCsvCell(val: string | number | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function listStockProducts(
  tx: DbExecutor,
  tenantId: string,
  filter: StockListFilter = {},
): Promise<StockPageDto> {
  await requireFeature(tx, tenantId, 'stock');

  const tsRows = await tx.query<{ default_rounding_mode: RoundingMode }>(
    `SELECT default_rounding_mode::text AS default_rounding_mode
       FROM tenant_settings
      WHERE tenant_id = $1::uuid
      LIMIT 1`,
    [tenantId],
  );
  const roundingMode: RoundingMode =
    tsRows[0] !== undefined ? tsRows[0].default_rounding_mode : 'FLOOR';

  const keyword =
    filter.keyword !== undefined && filter.keyword !== null && filter.keyword.trim() !== ''
      ? filter.keyword.trim()
      : null;
  const managedOnly = filter.managedOnly === true;
  const categoryCode =
    filter.categoryCode !== undefined &&
    filter.categoryCode !== null &&
    filter.categoryCode.trim() !== ''
      ? filter.categoryCode.trim()
      : null;

  const rows = await tx.query<{
    id: string;
    product_code: string;
    product_name: string;
    product_name_sub: string | null;
    item_category_code: string | null;
    category_name: string | null;
    unit_name: string | null;
    is_stock_managed: boolean;
    stock_quantity: string;
    standard_cost_price: string;
    standard_unit_price: string;
    purchased_qty: string;
    sold_qty: string;
    cost_consumed_qty: string;
    updated_at: string;
  }>(
    `SELECT p.id, p.product_code, p.product_name, p.product_name_sub,
            p.item_category_code,
            cm.name AS category_name,
            u.unit_name,
            p.is_stock_managed,
            p.stock_quantity::text AS stock_quantity,
            p.standard_cost_price::text AS standard_cost_price,
            p.standard_unit_price::text AS standard_unit_price,
            COALESCE(pur_agg.qty, 0)::text AS purchased_qty,
            COALESCE(sal_agg.qty, 0)::text AS sold_qty,
            COALESCE(cst_agg.qty, 0)::text AS cost_consumed_qty,
            p.updated_at::text AS updated_at
       FROM products p
       LEFT JOIN units u
         ON u.tenant_id = p.tenant_id AND u.id = p.unit_id
       LEFT JOIN code_masters cm
         ON cm.tenant_id = p.tenant_id
        AND cm.domain_key = 'ITEM_CLASS'
        AND cm.code = p.item_category_code
       LEFT JOIN (
         SELECT pl.product_id, SUM(pl.quantity) AS qty
           FROM purchase_lines pl
           JOIN purchases pur ON pur.tenant_id = pl.tenant_id AND pur.id = pl.purchase_id
          WHERE pur.tenant_id = $1::uuid AND pur.status = 'P3' AND pl.product_id IS NOT NULL
          GROUP BY pl.product_id
       ) pur_agg ON pur_agg.product_id = p.id
       LEFT JOIN (
         SELECT sl.product_id, SUM(sl.quantity) AS qty
           FROM sales_lines sl
           JOIN sales_headers sh ON sh.tenant_id = sl.tenant_id AND sh.id = sl.sales_header_id
          WHERE sh.tenant_id = $1::uuid AND sh.entry_type = 'SALE' AND sl.product_id IS NOT NULL
          GROUP BY sl.product_id
       ) sal_agg ON sal_agg.product_id = p.id
       LEFT JOIN (
         SELECT pcl.product_id, SUM(pcl.quantity) AS qty
           FROM project_cost_lines pcl
           JOIN project_cost_headers pch ON pch.tenant_id = pcl.tenant_id AND pch.id = pcl.cost_header_id
          WHERE pch.tenant_id = $1::uuid AND pcl.product_id IS NOT NULL
          GROUP BY pcl.product_id
       ) cst_agg ON cst_agg.product_id = p.id
      WHERE p.tenant_id = $1::uuid
        AND p.is_deleted = false
        AND p.is_heading = false
        AND ($2::boolean = false OR p.is_stock_managed = true)
        AND ($3::text IS NULL OR p.item_category_code = $3)
        AND (
          $4::text IS NULL
          OR p.product_code ILIKE '%' || $4 || '%'
          OR p.product_name ILIKE '%' || $4 || '%'
        )
      ORDER BY p.is_stock_managed DESC, p.product_code ASC`,
    [tenantId, managedOnly, categoryCode, keyword],
  );

  let managedCount = 0;
  let totalStockQtyDec = new Decimal(0);
  let totalValuationBig = 0n;

  const items: StockProductItemDto[] = rows.map((r) => {
    const stockDec = new Decimal(r.stock_quantity);
    const purchasedDec = new Decimal(r.purchased_qty);
    const soldDec = new Decimal(r.sold_qty);
    const consumedDec = new Decimal(r.cost_consumed_qty);
    const theoreticalDec = purchasedDec.minus(soldDec).minus(consumedDec);
    const valuationBig = applyRounding(
      stockDec.times(r.standard_cost_price),
      roundingMode,
    );

    if (r.is_stock_managed) {
      managedCount += 1;
    }
    totalStockQtyDec = totalStockQtyDec.plus(stockDec);
    totalValuationBig += valuationBig;

    return {
      id: r.id,
      productCode: r.product_code,
      productName: r.product_name,
      productNameSub: r.product_name_sub,
      categoryCode: r.item_category_code,
      categoryName: r.category_name !== null ? r.category_name : '未分類',
      unitName: r.unit_name !== null ? r.unit_name : '-',
      isStockManaged: r.is_stock_managed,
      stockQuantity: Number(stockDec.toFixed(4)),
      standardCostPrice: Number(r.standard_cost_price),
      standardUnitPrice: Number(r.standard_unit_price),
      purchasedQty: Number(purchasedDec.toFixed(4)),
      soldQty: Number(soldDec.toFixed(4)),
      costConsumedQty: Number(consumedDec.toFixed(4)),
      theoreticalStockQty: Number(theoreticalDec.toFixed(4)),
      stockValuation: Number(valuationBig),
      updatedAt: r.updated_at,
    };
  });

  return {
    items,
    totalCount: items.length,
    managedCount,
    totalStockQuantity: Number(totalStockQtyDec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString()),
    totalValuation: Number(totalValuationBig),
  };
}

export async function updateProductStock(
  tx: DbExecutor,
  tenantId: string,
  input: { productId: string; isStockManaged: boolean; stockQuantity: number },
): Promise<StockProductItemDto> {
  await requireFeature(tx, tenantId, 'stock');
  if (!UUID_REGEX.test(input.productId)) {
    throw new MasterDataError(400, 'INVALID_ID', '商品IDの形式が不正です。');
  }
  if (!Number.isFinite(input.stockQuantity)) {
    throw new MasterDataError(400, 'INVALID_QUANTITY', '在庫数は数値で入力してください。');
  }

  const updated = await tx.query<{ id: string }>(
    `UPDATE products
        SET is_stock_managed = $3,
            stock_quantity = $4::numeric(15,4)
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND is_deleted = false
      RETURNING id`,
    [tenantId, input.productId, input.isStockManaged, String(input.stockQuantity)],
  );
  if (updated.length === 0) {
    throw new MasterDataError(404, 'PRODUCT_NOT_FOUND', '対象の商品が見つかりません。');
  }

  const all = await listStockProducts(tx, tenantId, {});
  const target = all.items.find((i) => i.id === input.productId);
  if (target === undefined) {
    throw new MasterDataError(404, 'PRODUCT_NOT_FOUND', '更新後の商品情報を取得できませんでした。');
  }
  return target;
}

export async function exportStockCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: StockListFilter = {},
): Promise<string> {
  const page = await listStockProducts(tx, tenantId, filter);
  const header = [
    '商品コード',
    '商品名',
    '分類',
    '単位',
    '在庫管理対象',
    '確定仕入累計(P3)',
    '売上出荷累計',
    '原価消費累計',
    '理論在庫差引',
    '現在在庫数',
    '基準原価(円)',
    '在庫評価額(円)',
  ]
    .map(escapeCsvCell)
    .join(',');

  const lines = page.items.map((item) =>
    [
      item.productCode,
      item.productName,
      item.categoryName,
      item.unitName,
      item.isStockManaged ? '管理中' : '対象外',
      item.purchasedQty,
      item.soldQty,
      item.costConsumedQty,
      item.theoreticalStockQty,
      item.stockQuantity,
      item.standardCostPrice,
      item.stockValuation,
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

export async function exportStockPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: StockListFilter = {},
): Promise<Uint8Array> {
  const page = await listStockProducts(tx, tenantId, filter);
  const tsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = tsRows[0] !== undefined ? tsRows[0].company_name : '';

  const parts: string[] = [];
  if (filter.managedOnly) parts.push('在庫管理対象のみ');
  if (filter.keyword !== undefined && filter.keyword !== null && filter.keyword.trim() !== '') {
    parts.push(`キーワード:${filter.keyword.trim()}`);
  }

  return renderStockListPdf({
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: parts.length > 0 ? parts.join(' / ') : '全商品',
    items: page.items.map((i) => ({
      productCode: i.productCode,
      productName: i.productName,
      categoryName: i.categoryName,
      unitName: i.unitName,
      isStockManaged: i.isStockManaged,
      purchasedQty: i.purchasedQty,
      soldQty: i.soldQty,
      costConsumedQty: i.costConsumedQty,
      stockQuantity: i.stockQuantity,
      standardCostPrice: i.standardCostPrice,
      stockValuation: i.stockValuation,
    })),
    totals: {
      count: page.totalCount,
      managedCount: page.managedCount,
      totalStockQuantity: page.totalStockQuantity,
      totalValuation: page.totalValuation,
    },
  });
}
