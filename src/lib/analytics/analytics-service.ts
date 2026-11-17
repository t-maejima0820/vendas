import type { DbExecutor } from '@/lib/db/tenant-client';
import { computeMarginPercent } from '@/lib/domain/calculations';
import type { CustomAnalyticsPdfInput } from '@/lib/domain/pdf-renderer';
import { isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';

export type AnalyticsDimension = 'PARTNER' | 'CATEGORY' | 'EMPLOYEE' | 'PERIOD';

export interface CustomAnalyticsRowDto {
  groupKey: string;
  groupLabel: string;
  subLabel: string;
  recordCount: number;
  salesExcl: number;
  salesIncl: number;
  advanceIncl: number;
  costOrPurchaseExcl: number;
  grossProfit: number;
  grossMarginPercent: string;
}

export interface CustomAnalyticsPageDto {
  dimension: AnalyticsDimension;
  dimensionLabel: string;
  items: CustomAnalyticsRowDto[];
  totals: {
    count: number;
    salesExcl: number;
    salesIncl: number;
    advanceIncl: number;
    costOrPurchaseExcl: number;
    grossProfit: number;
    grossMarginPercent: string;
  };
}

export interface CustomAnalyticsFilter {
  dimension?: AnalyticsDimension;
  dateFrom?: string | null;
  dateTo?: string | null;
  keyword?: string | null;
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const DIMENSION_LABELS: Readonly<Record<AnalyticsDimension, string>> = {
  PARTNER: '取引先別売上・立替・仕入粗利集計',
  CATEGORY: '項目分類別・商品売上集計',
  EMPLOYEE: '営業担当者別 案件受注・粗利集計',
  PERIOD: '月別推移（売上・請求・仕入・原価）集計',
};

function validateOptionalDate(raw: string | null | undefined, label: string): string | null {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return null;
  }
  const trimmed = raw.trim();
  if (!DATE_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}は YYYY-MM-DD 形式で指定してください。`);
  }
  return trimmed;
}

async function assertAnalyticsAccess(tx: DbExecutor, tenantId: string): Promise<void> {
  const [itemOk, sumOk] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'item'),
    isFeatureEnabled(tx, tenantId, 'custom-sum-item'),
  ]);
  if (!itemOk && !sumOk) {
    await requireFeature(tx, tenantId, 'item');
  }
}

function escapeCsvCell(val: string | number | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export async function getCustomAnalytics(
  tx: DbExecutor,
  tenantId: string,
  filter: CustomAnalyticsFilter = {},
): Promise<CustomAnalyticsPageDto> {
  await assertAnalyticsAccess(tx, tenantId);

  const dimension: AnalyticsDimension = filter.dimension ?? 'PARTNER';
  const dateFrom = validateOptionalDate(filter.dateFrom, '開始日');
  const dateTo = validateOptionalDate(filter.dateTo, '終了日');
  const kw =
    filter.keyword !== undefined && filter.keyword !== null && filter.keyword.trim() !== ''
      ? filter.keyword.trim().toLowerCase()
      : null;

  let rawItems: CustomAnalyticsRowDto[] = [];

  if (dimension === 'PARTNER') {
    const rows = await tx.query<{
      partner_code: string;
      partner_name: string;
      record_count: string;
      sales_excl: string;
      sales_incl: string;
      advance_incl: string;
      purchase_excl: string;
    }>(
      `SELECT bp.partner_code,
              bp.partner_name,
              (COALESCE(s.cnt, 0) + COALESCE(p.cnt, 0))::text AS record_count,
              COALESCE(s.sales_excl, 0)::text AS sales_excl,
              COALESCE(s.sales_incl, 0)::text AS sales_incl,
              COALESCE(s.advance_incl, 0)::text AS advance_incl,
              COALESCE(p.purchase_excl, 0)::text AS purchase_excl
         FROM business_partners bp
         LEFT JOIN (
           SELECT partner_id,
                  COUNT(*)::int AS cnt,
                  SUM(CASE WHEN entry_type = 'SALE' THEN subtotal_amount ELSE 0 END) AS sales_excl,
                  SUM(CASE WHEN entry_type = 'SALE' THEN total_amount ELSE 0 END) AS sales_incl,
                  SUM(CASE WHEN entry_type = 'ADVANCE' THEN total_amount ELSE 0 END) AS advance_incl
             FROM sales_headers
            WHERE tenant_id = $1::uuid
              AND ($2::text IS NULL OR slip_date >= $2::date)
              AND ($3::text IS NULL OR slip_date <= $3::date)
            GROUP BY partner_id
         ) s ON s.partner_id = bp.id
         LEFT JOIN (
           SELECT supplier_id,
                  COUNT(*)::int AS cnt,
                  SUM(subtotal_amount) AS purchase_excl
             FROM purchases
            WHERE tenant_id = $1::uuid
              AND status = 'P3'
              AND ($2::text IS NULL OR purchase_date >= $2::date)
              AND ($3::text IS NULL OR purchase_date <= $3::date)
            GROUP BY supplier_id
         ) p ON p.supplier_id = bp.id
        WHERE bp.tenant_id = $1::uuid
          AND bp.is_deleted = false
          AND (COALESCE(s.cnt, 0) > 0 OR COALESCE(p.cnt, 0) > 0)
        ORDER BY sales_excl DESC, bp.partner_code ASC`,
      [tenantId, dateFrom, dateTo],
    );

    rawItems = rows.map((r) => {
      const salesExclBig = BigInt(r.sales_excl);
      const costBig = BigInt(r.purchase_excl);
      const profitBig = salesExclBig - costBig;
      return {
        groupKey: r.partner_code,
        groupLabel: r.partner_name,
        subLabel: '取引先',
        recordCount: Number(r.record_count),
        salesExcl: Number(salesExclBig),
        salesIncl: Number(r.sales_incl),
        advanceIncl: Number(r.advance_incl),
        costOrPurchaseExcl: Number(costBig),
        grossProfit: Number(profitBig),
        grossMarginPercent: computeMarginPercent(profitBig, salesExclBig),
      };
    });
  } else if (dimension === 'CATEGORY') {
    const rows = await tx.query<{
      category_code: string;
      category_name: string;
      record_count: string;
      sales_excl: string;
      sales_incl: string;
      advance_incl: string;
      cost_excl: string;
    }>(
      `SELECT cat_key AS category_code,
              cat_label AS category_name,
              COUNT(*)::text AS record_count,
              SUM(sales_excl)::text AS sales_excl,
              SUM(sales_incl)::text AS sales_incl,
              SUM(advance_incl)::text AS advance_incl,
              SUM(cost_excl)::text AS cost_excl
         FROM (
           SELECT COALESCE(pr.item_category_code, 'UNCLASSIFIED') AS cat_key,
                  COALESCE(cm.name, '分類なし・フリー明細') AS cat_label,
                  CASE
                    WHEN sh.entry_type = 'SALE' AND sl.tax_code IN ('D', 'E') THEN sl.line_amount - sl.line_tax
                    WHEN sh.entry_type = 'SALE' THEN sl.line_amount
                    ELSE 0
                  END AS sales_excl,
                  CASE WHEN sh.entry_type = 'SALE' THEN sl.row_total ELSE 0 END AS sales_incl,
                  CASE WHEN sh.entry_type = 'ADVANCE' THEN sl.row_total ELSE 0 END AS advance_incl,
                  0::numeric(15,0) AS cost_excl
             FROM sales_lines sl
             JOIN sales_headers sh ON sh.tenant_id = sl.tenant_id AND sh.id = sl.sales_header_id
             LEFT JOIN products pr ON pr.tenant_id = sl.tenant_id AND pr.id = sl.product_id
             LEFT JOIN code_masters cm
               ON cm.tenant_id = sh.tenant_id
              AND cm.domain_key = 'ITEM_CLASS'
              AND cm.code = pr.item_category_code
            WHERE sh.tenant_id = $1::uuid
              AND sl.is_heading = false
              AND ($2::text IS NULL OR sh.slip_date >= $2::date)
              AND ($3::text IS NULL OR sh.slip_date <= $3::date)
           UNION ALL
           SELECT COALESCE(pr.item_category_code, 'UNCLASSIFIED') AS cat_key,
                  COALESCE(cm.name, '分類なし・フリー明細') AS cat_label,
                  0::numeric(15,0) AS sales_excl,
                  0::numeric(15,0) AS sales_incl,
                  0::numeric(15,0) AS advance_incl,
                  CASE
                    WHEN pl.tax_code IN ('D', 'E') THEN pl.line_amount - pl.line_tax
                    ELSE pl.line_amount
                  END AS cost_excl
             FROM purchase_lines pl
             JOIN purchases pur ON pur.tenant_id = pl.tenant_id AND pur.id = pl.purchase_id
             LEFT JOIN products pr ON pr.tenant_id = pl.tenant_id AND pr.id = pl.product_id
             LEFT JOIN code_masters cm
               ON cm.tenant_id = pur.tenant_id
              AND cm.domain_key = 'ITEM_CLASS'
              AND cm.code = pr.item_category_code
            WHERE pur.tenant_id = $1::uuid
              AND pur.status = 'P3'
              AND ($2::text IS NULL OR pur.purchase_date >= $2::date)
              AND ($3::text IS NULL OR pur.purchase_date <= $3::date)
         ) sub
        GROUP BY cat_key, cat_label
        ORDER BY SUM(sales_excl) DESC, cat_key ASC`,
      [tenantId, dateFrom, dateTo],
    );

    rawItems = rows.map((r) => {
      const salesExclBig = BigInt(r.sales_excl);
      const costBig = BigInt(r.cost_excl);
      const profitBig = salesExclBig - costBig;
      return {
        groupKey: r.category_code,
        groupLabel: r.category_name,
        subLabel: '項目分類(ITEM_CLASS)',
        recordCount: Number(r.record_count),
        salesExcl: Number(salesExclBig),
        salesIncl: Number(r.sales_incl),
        advanceIncl: Number(r.advance_incl),
        costOrPurchaseExcl: Number(costBig),
        grossProfit: Number(profitBig),
        grossMarginPercent: computeMarginPercent(profitBig, salesExclBig),
      };
    });
  } else if (dimension === 'EMPLOYEE') {
    const rows = await tx.query<{
      syain_code: string;
      syain_name: string;
      project_count: string;
      contract_excl: string;
      contract_incl: string;
      cost_excl: string;
    }>(
      `SELECT COALESCE(e.syain_code, 'UNASSIGNED') AS syain_code,
              COALESCE(e.syain_name, '担当者未割当') AS syain_name,
              COUNT(p.id)::text AS project_count,
              COALESCE(SUM(p.contract_subtotal), 0)::text AS contract_excl,
              COALESCE(SUM(p.contract_total), 0)::text AS contract_incl,
              COALESCE(SUM(cost_agg.cost_excl), 0)::text AS cost_excl
         FROM projects p
         LEFT JOIN employees e ON e.tenant_id = p.tenant_id AND e.id = p.sales_employee_id
         LEFT JOIN (
           SELECT project_id, SUM(subtotal_amount) AS cost_excl
             FROM project_cost_headers
            WHERE tenant_id = $1::uuid
            GROUP BY project_id
         ) cost_agg ON cost_agg.project_id = p.id
        WHERE p.tenant_id = $1::uuid
          AND ($2::text IS NULL OR p.project_date >= $2::date)
          AND ($3::text IS NULL OR p.project_date <= $3::date)
        GROUP BY COALESCE(e.syain_code, 'UNASSIGNED'), COALESCE(e.syain_name, '担当者未割当')
        ORDER BY COALESCE(SUM(p.contract_subtotal), 0) DESC, syain_code ASC`,
      [tenantId, dateFrom, dateTo],
    );

    rawItems = rows.map((r) => {
      const salesExclBig = BigInt(r.contract_excl);
      const costBig = BigInt(r.cost_excl);
      const profitBig = salesExclBig - costBig;
      return {
        groupKey: r.syain_code,
        groupLabel: r.syain_name,
        subLabel: '営業担当(案件受注契約)',
        recordCount: Number(r.project_count),
        salesExcl: Number(salesExclBig),
        salesIncl: Number(r.contract_incl),
        advanceIncl: 0,
        costOrPurchaseExcl: Number(costBig),
        grossProfit: Number(profitBig),
        grossMarginPercent: computeMarginPercent(profitBig, salesExclBig),
      };
    });
  } else {
    // PERIOD (YYYY-MM)
    const rows = await tx.query<{
      ym: string;
      record_count: string;
      sales_excl: string;
      sales_incl: string;
      advance_incl: string;
      cost_excl: string;
    }>(
      `SELECT ym,
              COUNT(*)::text AS record_count,
              SUM(sales_excl)::text AS sales_excl,
              SUM(sales_incl)::text AS sales_incl,
              SUM(advance_incl)::text AS advance_incl,
              SUM(cost_excl)::text AS cost_excl
         FROM (
           SELECT to_char(slip_date, 'YYYY-MM') AS ym,
                  CASE WHEN entry_type = 'SALE' THEN subtotal_amount ELSE 0 END AS sales_excl,
                  CASE WHEN entry_type = 'SALE' THEN total_amount ELSE 0 END AS sales_incl,
                  CASE WHEN entry_type = 'ADVANCE' THEN total_amount ELSE 0 END AS advance_incl,
                  0::numeric(15,0) AS cost_excl
             FROM sales_headers
            WHERE tenant_id = $1::uuid
              AND ($2::text IS NULL OR slip_date >= $2::date)
              AND ($3::text IS NULL OR slip_date <= $3::date)
           UNION ALL
           SELECT to_char(purchase_date, 'YYYY-MM') AS ym,
                  0::numeric(15,0) AS sales_excl,
                  0::numeric(15,0) AS sales_incl,
                  0::numeric(15,0) AS advance_incl,
                  subtotal_amount AS cost_excl
             FROM purchases
            WHERE tenant_id = $1::uuid
              AND status = 'P3'
              AND ($2::text IS NULL OR purchase_date >= $2::date)
              AND ($3::text IS NULL OR purchase_date <= $3::date)
           UNION ALL
           SELECT to_char(entry_date, 'YYYY-MM') AS ym,
                  0::numeric(15,0) AS sales_excl,
                  0::numeric(15,0) AS sales_incl,
                  0::numeric(15,0) AS advance_incl,
                  subtotal_amount AS cost_excl
             FROM project_cost_headers
            WHERE tenant_id = $1::uuid
              AND ($2::text IS NULL OR entry_date >= $2::date)
              AND ($3::text IS NULL OR entry_date <= $3::date)
         ) t
        GROUP BY ym
        ORDER BY ym DESC`,
      [tenantId, dateFrom, dateTo],
    );

    rawItems = rows.map((r) => {
      const salesExclBig = BigInt(r.sales_excl);
      const costBig = BigInt(r.cost_excl);
      const profitBig = salesExclBig - costBig;
      return {
        groupKey: r.ym,
        groupLabel: `${r.ym} 月次`,
        subLabel: '月別推移',
        recordCount: Number(r.record_count),
        salesExcl: Number(salesExclBig),
        salesIncl: Number(r.sales_incl),
        advanceIncl: Number(r.advance_incl),
        costOrPurchaseExcl: Number(costBig),
        grossProfit: Number(profitBig),
        grossMarginPercent: computeMarginPercent(profitBig, salesExclBig),
      };
    });
  }

  const items =
    kw !== null
      ? rawItems.filter((item) =>
          `${item.groupKey} ${item.groupLabel} ${item.subLabel}`.toLowerCase().includes(kw),
        )
      : rawItems;

  let totSalesExcl = 0n;
  let totSalesIncl = 0n;
  let totAdvanceIncl = 0n;
  let totCostExcl = 0n;
  for (const item of items) {
    totSalesExcl += BigInt(item.salesExcl);
    totSalesIncl += BigInt(item.salesIncl);
    totAdvanceIncl += BigInt(item.advanceIncl);
    totCostExcl += BigInt(item.costOrPurchaseExcl);
  }
  const totProfit = totSalesExcl - totCostExcl;

  return {
    dimension,
    dimensionLabel: DIMENSION_LABELS[dimension],
    items,
    totals: {
      count: items.length,
      salesExcl: Number(totSalesExcl),
      salesIncl: Number(totSalesIncl),
      advanceIncl: Number(totAdvanceIncl),
      costOrPurchaseExcl: Number(totCostExcl),
      grossProfit: Number(totProfit),
      grossMarginPercent: computeMarginPercent(totProfit, totSalesExcl),
    },
  };
}

export async function exportCustomAnalyticsCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: CustomAnalyticsFilter = {},
): Promise<string> {
  const page = await getCustomAnalytics(tx, tenantId, filter);
  const header = [
    '区分コード',
    '集計軸名称',
    '補足',
    '件数',
    '売上税抜(円)',
    '売上税込(円)',
    '立替税込(円)',
    '原価・仕入税抜(円)',
    '粗利額(円)',
    '粗利率(%)',
  ]
    .map(escapeCsvCell)
    .join(',');

  const lines = page.items.map((item) =>
    [
      item.groupKey,
      item.groupLabel,
      item.subLabel,
      item.recordCount,
      item.salesExcl,
      item.salesIncl,
      item.advanceIncl,
      item.costOrPurchaseExcl,
      item.grossProfit,
      item.grossMarginPercent,
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

export async function buildCustomAnalyticsPdfInput(
  tx: DbExecutor,
  tenantId: string,
  filter: CustomAnalyticsFilter = {},
): Promise<CustomAnalyticsPdfInput> {
  const page = await getCustomAnalytics(tx, tenantId, filter);
  const tsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = tsRows[0] !== undefined ? tsRows[0].company_name : '';

  const parts: string[] = [];
  if (filter.dateFrom !== undefined && filter.dateFrom !== null && filter.dateFrom !== '') {
    parts.push(`From:${filter.dateFrom}`);
  }
  if (filter.dateTo !== undefined && filter.dateTo !== null && filter.dateTo !== '') {
    parts.push(`To:${filter.dateTo}`);
  }
  if (filter.keyword !== undefined && filter.keyword !== null && filter.keyword.trim() !== '') {
    parts.push(`キーワード:${filter.keyword.trim()}`);
  }

  return {
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    dimensionLabel: page.dimensionLabel,
    filterSummary: parts.length > 0 ? parts.join(' / ') : '全期間・全対象',
    items: page.items,
    totals: page.totals,
  };
}
