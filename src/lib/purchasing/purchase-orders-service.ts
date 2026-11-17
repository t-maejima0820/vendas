import Decimal from 'decimal.js';
import type { DbExecutor } from '@/lib/db/tenant-client';
import {
  calculateSalesSlip,
  type CostTaxMode,
  type RoundingMode,
  type TaxCalcPolicy,
  type TaxCode,
} from '@/lib/domain/calculations';
import type { PurchaseOrderListPdfInput } from '@/lib/domain/pdf-renderer';
import type { QuotationTemplateVariant } from '@/lib/estimates/types';
import { isFeatureEnabled, requireFeature } from '@/lib/feature-flags/gate';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import {
  ORDER_STATUS_LABELS,
  type OrderStatus,
  type PurchaseOrderDetailDto,
  type PurchaseOrderInput,
  type PurchaseOrderLineDto,
  type PurchaseOrderListItemDto,
  type PurchaseOrderListSummaryDto,
  type PurchaseOrderPageDto,
  type PurchasingLookupsDto,
} from '@/lib/purchasing/types';
import { listEntitySnapshots } from '@/lib/snapshots/snapshot-service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set<OrderStatus>(['O1', 'O2', 'O3']);
const VALID_ROUNDING_MODES = new Set<RoundingMode>(['FLOOR', 'ROUND', 'CEIL']);
const VALID_TAX_CODES = new Set<TaxCode>(['A', 'B', 'C', 'D', 'E']);

export interface PurchaseOrderListFilter {
  keyword?: string | null;
  supplierId?: string | null;
  projectId?: string | null;
  status?: OrderStatus | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  page?: number;
  pageSize?: number;
}

function validateUuid(id: string, label: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', `${label}IDの形式が不正です。`);
  }
}

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateDateOnly(val: string, label: string): string {
  const trimmed = val.trim().slice(0, 10);
  if (!DATE_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}は YYYY-MM-DD 形式で入力してください。`);
  }
  const parts = trimmed.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() + 1 !== m ||
    check.getUTCDate() !== d
  ) {
    throw new MasterDataError(400, 'INVALID_DATE', `${label}の日付が存在しません。`);
  }
  return trimmed;
}

function validateIntegerYen(val: number, label: string): number {
  if (!Number.isInteger(val) || Math.abs(val) > 999_999_999_999) {
    throw new MasterDataError(400, 'INVALID_AMOUNT', `${label}は整数円で入力してください。`);
  }
  return val;
}

function validateOptionalIntegerYen(val: number | null, label: string): number | null {
  if (val === null) {
    return null;
  }
  return validateIntegerYen(val, label);
}

function validateQuantity(val: number, lineNo: number): string {
  if (!Number.isFinite(val) || Math.abs(val) > 99_999_999) {
    throw new MasterDataError(400, 'INVALID_QUANTITY', `${lineNo}行目の数量が不正です。`);
  }
  return new Decimal(val).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
}

function escapeCsvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function parsePurchasingJson<T>(raw: T | string): T {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as T;
  }
  return raw;
}

export async function getPurchasingLookups(
  tx: DbExecutor,
  tenantId: string,
): Promise<PurchasingLookupsDto> {
  const [orderEnabled, purchaseEnabled, payableEnabled, paymentEnabled] = await Promise.all([
    isFeatureEnabled(tx, tenantId, 'order'),
    isFeatureEnabled(tx, tenantId, 'purchase'),
    isFeatureEnabled(tx, tenantId, 'payable'),
    isFeatureEnabled(tx, tenantId, 'payment'),
  ]);

  if (!orderEnabled && !purchaseEnabled) {
    await requireFeature(tx, tenantId, 'order');
  }

  type TsJson = {
    opening_balance_date: string;
    tax_calc_policy: TaxCalcPolicy;
    default_rounding_mode: RoundingMode;
    cost_tax_mode: CostTaxMode;
    quotation_template_rows: number;
  };
  type PartnerJson = {
    id: string;
    partner_code: string;
    partner_name: string;
    is_individual_honorific: boolean;
    representative_name: string | null;
    is_client: boolean;
    is_supplier: boolean;
    closing_day_code: string | null;
    collection_day_code: string | null;
  };
  type ProjectJson = {
    id: string;
    project_no: string;
    project_name: string;
    partner_id: string;
    status: string;
    site_place: string | null;
  };
  type ProductJson = {
    id: string;
    product_code: string;
    product_name: string;
    product_name_sub: string | null;
    unit_name: string | null;
    standard_unit_price: string;
    standard_purchase_price: string;
    standard_cost_price: string;
    default_tax_code: TaxCode;
    is_heading: boolean;
  };
  type IntelJson = {
    id: string;
    item_name: string;
    unit_name: string | null;
    unit_price: string;
    cost_price: string;
    tax_code: TaxCode;
  };
  type UnitJson = { id: string; unit_code: string; unit_name: string };
  type TaxJson = {
    tax_code: TaxCode;
    tax_name: string;
    tax_rate: string;
    mark_symbol: string;
    is_internal: boolean;
  };

  const rows = await tx.query<{
    ts_json: TsJson | string | null;
    partners_json: PartnerJson[] | string;
    projects_json: ProjectJson[] | string;
    products_json: ProductJson[] | string;
    intelligences_json: IntelJson[] | string;
    units_json: UnitJson[] | string;
    tax_codes_json: TaxJson[] | string;
  }>(
    `SELECT
       (
         SELECT json_build_object(
           'opening_balance_date', ts.opening_balance_date::text,
           'tax_calc_policy', ts.tax_calc_policy::text,
           'default_rounding_mode', ts.default_rounding_mode::text,
           'cost_tax_mode', ts.cost_tax_mode::text,
           'quotation_template_rows', ts.quotation_template_rows
         )
           FROM tenant_settings ts
          WHERE ts.tenant_id = $1::uuid
          LIMIT 1
       ) AS ts_json,
       COALESCE(
         (
           SELECT json_agg(row_to_json(bp) ORDER BY bp.is_supplier DESC, bp.partner_code ASC)
             FROM (
               SELECT bp.id, bp.partner_code, bp.partner_name, bp.is_individual_honorific,
                      r.representative_name, bp.is_client, bp.is_supplier,
                      bp.closing_day_code, bp.collection_day_code
                 FROM business_partners bp
                 LEFT JOIN representatives r ON r.tenant_id = bp.tenant_id AND r.id = bp.representative_id
                WHERE bp.is_deleted = false
             ) bp
         ),
         '[]'::json
       ) AS partners_json,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object(
               'id', pj.id,
               'project_no', pj.project_no,
               'project_name', pj.project_name,
               'partner_id', pj.partner_id,
               'status', pj.status,
               'site_place', pj.site_place
             )
             ORDER BY pj.project_no_num DESC
           )
             FROM (
               SELECT id, project_no::text AS project_no, project_no AS project_no_num,
                      project_name, partner_id, status::text AS status, site_place
                 FROM projects
             ) pj
         ),
         '[]'::json
       ) AS projects_json,
       COALESCE(
         (
           SELECT json_agg(row_to_json(pr) ORDER BY pr.product_code ASC)
             FROM (
               SELECT p.id, p.product_code, p.product_name, p.product_name_sub, u.unit_name,
                      p.standard_unit_price::text AS standard_unit_price,
                      p.standard_purchase_price::text AS standard_purchase_price,
                      p.standard_cost_price::text AS standard_cost_price,
                      p.default_tax_code, p.is_heading
                 FROM products p
                 LEFT JOIN units u ON u.tenant_id = p.tenant_id AND u.id = p.unit_id
                WHERE p.is_deleted = false
             ) pr
         ),
         '[]'::json
       ) AS products_json,
       COALESCE(
         (
           SELECT json_agg(row_to_json(ii) ORDER BY ii.item_name ASC)
             FROM (
               SELECT id, item_name, unit_name, unit_price::text AS unit_price,
                      cost_price::text AS cost_price, tax_code
                 FROM input_intelligences
             ) ii
         ),
         '[]'::json
       ) AS intelligences_json,
       COALESCE(
         (
           SELECT json_agg(
             json_build_object('id', u.id, 'unit_code', u.unit_code, 'unit_name', u.unit_name)
             ORDER BY u.display_order ASC, u.unit_code ASC
           )
             FROM units u
            WHERE u.is_deleted = false
         ),
         '[]'::json
       ) AS units_json,
       COALESCE(
         (
           SELECT json_agg(row_to_json(tc) ORDER BY tc.tax_code ASC)
             FROM (
               SELECT tax_code, tax_name, tax_rate::text AS tax_rate, mark_symbol, is_internal
                 FROM tax_codes
             ) tc
         ),
         '[]'::json
       ) AS tax_codes_json`,
    [tenantId],
  );

  const dbRow = rows[0];
  if (dbRow === undefined || dbRow.ts_json === null) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const settings = parsePurchasingJson<TsJson>(dbRow.ts_json);
  const partnerRows = parsePurchasingJson<PartnerJson[]>(dbRow.partners_json);
  const projectRows = parsePurchasingJson<ProjectJson[]>(dbRow.projects_json);
  const productRows = parsePurchasingJson<ProductJson[]>(dbRow.products_json);
  const intelRows = parsePurchasingJson<IntelJson[]>(dbRow.intelligences_json);
  const unitRows = parsePurchasingJson<UnitJson[]>(dbRow.units_json);
  const taxRows = parsePurchasingJson<TaxJson[]>(dbRow.tax_codes_json);

  const defaultTemplateVariant: QuotationTemplateVariant =
    settings.quotation_template_rows === 20 ? '20_ROWS' : '10_ROWS';

  return {
    openingBalanceDate: settings.opening_balance_date.slice(0, 10),
    orderEnabled,
    purchaseEnabled,
    payableEnabled,
    paymentEnabled,
    taxCalcPolicy: settings.tax_calc_policy,
    defaultRoundingMode: settings.default_rounding_mode,
    costTaxMode: settings.cost_tax_mode,
    defaultTemplateVariant,
    partners: partnerRows.map((r) => ({
      id: r.id,
      partnerCode: r.partner_code,
      partnerName: r.partner_name,
      isIndividualHonorific: r.is_individual_honorific,
      representativeName: r.representative_name,
      isClient: r.is_client,
      isSupplier: r.is_supplier,
      closingDayCode: r.closing_day_code,
      collectionDayCode: r.collection_day_code,
    })),
    projects: projectRows.map((r) => ({
      id: r.id,
      projectNo: Number(r.project_no),
      projectName: r.project_name,
      partnerId: r.partner_id,
      status: r.status,
      sitePlace: r.site_place,
    })),
    products: productRows.map((r) => ({
      id: r.id,
      productCode: r.product_code,
      productName: r.product_name,
      productNameSub: r.product_name_sub,
      unitName: r.unit_name,
      standardUnitPrice: Number(r.standard_unit_price),
      standardPurchasePrice: Number(r.standard_purchase_price),
      standardCostPrice: Number(r.standard_cost_price),
      defaultTaxCode: r.default_tax_code,
      isHeading: r.is_heading,
    })),
    intelligences: intelRows.map((r) => ({
      id: r.id,
      itemName: r.item_name,
      unitName: r.unit_name,
      unitPrice: Number(r.unit_price),
      costPrice: Number(r.cost_price),
      taxCode: r.tax_code,
    })),
    units: unitRows.map((r) => ({
      id: r.id,
      unitCode: r.unit_code,
      unitName: r.unit_name,
    })),
    taxCodes: taxRows.map((r) => ({
      taxCode: r.tax_code,
      taxName: r.tax_name,
      taxRate: Number(r.tax_rate),
      markSymbol: r.mark_symbol,
      isInternal: r.is_internal,
    })),
  };
}

interface CleanOrderLine {
  productId: string | null;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  isHeading: boolean;
  quantityStr: string;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPrice: number;
  remarks: string | null;
}

interface CleanOrderPayload {
  orderName: string;
  orderDate: string;
  supplierId: string;
  projectId: string | null;
  honorific: string;
  deliveryDate: string | null;
  status: OrderStatus;
  roundingMode: RoundingMode;
  remarks: string | null;
  lines: CleanOrderLine[];
}

function validateOrderInput(input: PurchaseOrderInput): CleanOrderPayload {
  const orderName = input.orderName.trim();
  if (orderName.length === 0 || orderName.length > 200) {
    throw new MasterDataError(400, 'INVALID_ORDER_NAME', '発注件名は1〜200文字で入力してください。');
  }
  const orderDate = validateDateOnly(input.orderDate, '発注日');
  validateUuid(input.supplierId, '仕入先');

  let projectId: string | null = null;
  if (input.projectId !== null && input.projectId.trim() !== '') {
    validateUuid(input.projectId.trim(), '案件');
    projectId = input.projectId.trim();
  }

  const honorific = input.honorific.trim();
  if (honorific.length === 0 || honorific.length > 20) {
    throw new MasterDataError(400, 'INVALID_HONORIFIC', '敬称は1〜20文字で入力してください。');
  }
  if (!VALID_STATUSES.has(input.status)) {
    throw new MasterDataError(400, 'INVALID_STATUS', '発注ステータスは O1〜O3 を指定してください。');
  }
  if (!VALID_ROUNDING_MODES.has(input.roundingMode)) {
    throw new MasterDataError(400, 'INVALID_ROUNDING_MODE', '端数処理は FLOOR / ROUND / CEIL を指定してください。');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new MasterDataError(400, 'LINES_REQUIRED', '発注明細は最低1行以上入力してください。');
  }

  const lines: CleanOrderLine[] = input.lines.map((line, idx) => {
    const lineNo = idx + 1;
    const isHeading = Boolean(line.isHeading);
    const itemName = line.itemName.trim();
    if (itemName.length === 0 || itemName.length > 300) {
      throw new MasterDataError(400, 'INVALID_ITEM_NAME', `${lineNo}行目の品名は1〜300文字で入力してください。`);
    }
    let productId: string | null = null;
    if (line.productId !== null && line.productId.trim() !== '') {
      validateUuid(line.productId.trim(), `${lineNo}行目の商品`);
      productId = line.productId.trim();
    }
    const taxCode: TaxCode = isHeading ? 'C' : line.taxCode;
    if (!VALID_TAX_CODES.has(taxCode)) {
      throw new MasterDataError(400, 'INVALID_TAX_CODE', `${lineNo}行目の税区分が不正です。`);
    }
    const quantityStr = isHeading ? '0' : validateQuantity(line.quantity, lineNo);
    const masterUnitPrice = validateOptionalIntegerYen(line.masterUnitPrice, `${lineNo}行目の基準単価`);
    const appliedUnitPrice = isHeading
      ? 0
      : validateIntegerYen(line.appliedUnitPrice, `${lineNo}行目の発注単価`);

    return {
      productId,
      itemCode: optTrimmed(line.itemCode),
      itemName,
      unitName: isHeading ? null : optTrimmed(line.unitName),
      isHeading,
      quantityStr,
      taxCode,
      masterUnitPrice,
      appliedUnitPrice,
      remarks: optTrimmed(line.remarks),
    };
  });

  return {
    orderName,
    orderDate,
    supplierId: input.supplierId.trim(),
    projectId,
    honorific,
    deliveryDate: optTrimmed(input.deliveryDate),
    status: input.status,
    roundingMode: input.roundingMode,
    remarks: optTrimmed(input.remarks),
    lines,
  };
}

async function validateOrderReferences(
  tx: DbExecutor,
  payload: CleanOrderPayload,
): Promise<TaxCalcPolicy> {
  const settingsRows = await tx.query<{ tax_calc_policy: TaxCalcPolicy }>(
    'SELECT tax_calc_policy::text AS tax_calc_policy FROM tenant_settings LIMIT 1',
    [],
  );
  const policy = settingsRows[0]?.tax_calc_policy;
  if (policy === undefined) {
    throw new MasterDataError(404, 'TENANT_SETTINGS_NOT_FOUND', '自社設定が見つかりません。');
  }

  const bpRows = await tx.query<{ id: string }>(
    'SELECT id FROM business_partners WHERE id = $1::uuid AND is_deleted = false LIMIT 1',
    [payload.supplierId],
  );
  if (bpRows.length === 0) {
    throw new MasterDataError(400, 'SUPPLIER_NOT_FOUND', '指定された仕入先が見つかりません。');
  }

  if (payload.projectId !== null) {
    const pjRows = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE id = $1::uuid LIMIT 1',
      [payload.projectId],
    );
    if (pjRows.length === 0) {
      throw new MasterDataError(400, 'PROJECT_NOT_FOUND', '指定された案件が見つかりません。');
    }
  }

  const prodIds = payload.lines
    .map((l) => l.productId)
    .filter((id): id is string => id !== null);
  if (prodIds.length > 0) {
    const prodRows = await tx.query<{ id: string; is_heading: boolean }>(
      'SELECT id, is_heading FROM products WHERE id = ANY($1::uuid[]) AND is_deleted = false',
      [prodIds],
    );
    const prodMap = new Map(prodRows.map((r) => [r.id, r.is_heading]));
    for (const ln of payload.lines) {
      if (ln.productId !== null && !prodMap.has(ln.productId)) {
        throw new MasterDataError(400, 'PRODUCT_NOT_FOUND', '明細で指定された商品が見つかりません。');
      }
      if (ln.productId !== null && prodMap.get(ln.productId) === true) {
        ln.isHeading = true;
        ln.quantityStr = '0';
        ln.appliedUnitPrice = 0;
        ln.unitName = null;
        ln.taxCode = 'C';
      }
    }
  }

  return policy;
}

export async function listPurchaseOrders(
  tx: DbExecutor,
  tenantId: string,
  filter: PurchaseOrderListFilter = {},
): Promise<PurchaseOrderPageDto> {
  await requireFeature(tx, tenantId, 'order');

  const kw = optTrimmed(filter.keyword);
  const rawSupplier = optTrimmed(filter.supplierId);
  if (rawSupplier !== null) {
    validateUuid(rawSupplier, '仕入先');
  }
  const rawProject = optTrimmed(filter.projectId);
  if (rawProject !== null) {
    validateUuid(rawProject, '案件');
  }
  const status =
    filter.status !== undefined && filter.status !== null && VALID_STATUSES.has(filter.status)
      ? filter.status
      : null;
  const rawFrom = optTrimmed(filter.dateFrom);
  const dateFrom = rawFrom !== null && DATE_REGEX.test(rawFrom) ? rawFrom : null;
  const rawTo = optTrimmed(filter.dateTo);
  const dateTo = rawTo !== null && DATE_REGEX.test(rawTo) ? rawTo : null;

  const rawPage = filter.page === undefined ? 1 : filter.page;
  const rawSize = filter.pageSize === undefined ? 25 : filter.pageSize;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const pageSize = Number.isInteger(rawSize) && rawSize >= 1 && rawSize <= 5000 ? rawSize : 25;
  const offset = (page - 1) * pageSize;

  const sumRows = await tx.query<{
    total_count: number;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
  }>(
    `SELECT COUNT(*)::int AS total_count,
            COALESCE(SUM(po.subtotal_amount), 0)::text AS subtotal_amount,
            COALESCE(SUM(po.tax_total), 0)::text AS tax_total,
            COALESCE(SUM(po.total_amount), 0)::text AS total_amount
       FROM purchase_orders po
       JOIN business_partners bp ON bp.tenant_id = po.tenant_id AND bp.id = po.supplier_id
       LEFT JOIN projects pj ON pj.tenant_id = po.tenant_id AND pj.id = po.project_id
      WHERE ($1::text IS NULL OR po.order_no::text = $1
             OR po.order_name ILIKE '%' || $1 || '%'
             OR bp.partner_name ILIKE '%' || $1 || '%'
             OR bp.partner_code ILIKE '%' || $1 || '%'
             OR COALESCE(pj.project_name, '') ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR po.supplier_id = $2::uuid)
        AND ($3::uuid IS NULL OR po.project_id = $3::uuid)
        AND ($4::text IS NULL OR po.status::text = $4)
        AND ($5::date IS NULL OR po.order_date >= $5::date)
        AND ($6::date IS NULL OR po.order_date <= $6::date)`,
    [kw, rawSupplier, rawProject, status, dateFrom, dateTo],
  );
  const sum = sumRows[0];
  const summary: PurchaseOrderListSummaryDto = {
    totalCount: sum !== undefined ? Number(sum.total_count) : 0,
    subtotalAmount: sum !== undefined ? Number(sum.subtotal_amount) : 0,
    taxTotal: sum !== undefined ? Number(sum.tax_total) : 0,
    totalAmount: sum !== undefined ? Number(sum.total_amount) : 0,
  };

  const rows = await tx.query<{
    id: string;
    order_no: string;
    order_name: string;
    order_date: string;
    supplier_id: string;
    supplier_code: string;
    supplier_name: string;
    project_id: string | null;
    project_no: string | null;
    project_name: string | null;
    site_place: string | null;
    honorific: string;
    delivery_date: string | null;
    status: OrderStatus;
    rounding_mode: RoundingMode;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
    line_count: number;
    snapshot_count: number;
    latest_snapshot_version: number | null;
    linked_purchase_count: number;
    updated_at: string;
  }>(
    `SELECT po.id, po.order_no::text AS order_no, po.order_name,
            po.order_date::text AS order_date,
            po.supplier_id, bp.partner_code AS supplier_code, bp.partner_name AS supplier_name,
            po.project_id, pj.project_no::text AS project_no, pj.project_name, pj.site_place,
            po.honorific, po.delivery_date, po.status::text AS status,
            po.rounding_mode::text AS rounding_mode,
            po.subtotal_amount::text AS subtotal_amount,
            po.tax_total::text AS tax_total,
            po.total_amount::text AS total_amount,
            (SELECT COUNT(*)::int FROM purchase_order_lines pol WHERE pol.order_id = po.id) AS line_count,
            (SELECT COUNT(*)::int FROM document_snapshots ds
              WHERE ds.document_type = 'PURCHASE_ORDER'::document_type
                AND ds.source_entity_id = po.id) AS snapshot_count,
            (SELECT MAX(ds.version_no)::int FROM document_snapshots ds
              WHERE ds.document_type = 'PURCHASE_ORDER'::document_type
                AND ds.source_entity_id = po.id) AS latest_snapshot_version,
            (SELECT COUNT(*)::int FROM purchases pur WHERE pur.purchase_order_id = po.id) AS linked_purchase_count,
            po.updated_at::text AS updated_at
       FROM purchase_orders po
       JOIN business_partners bp ON bp.tenant_id = po.tenant_id AND bp.id = po.supplier_id
       LEFT JOIN projects pj ON pj.tenant_id = po.tenant_id AND pj.id = po.project_id
      WHERE ($1::text IS NULL OR po.order_no::text = $1
             OR po.order_name ILIKE '%' || $1 || '%'
             OR bp.partner_name ILIKE '%' || $1 || '%'
             OR bp.partner_code ILIKE '%' || $1 || '%'
             OR COALESCE(pj.project_name, '') ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR po.supplier_id = $2::uuid)
        AND ($3::uuid IS NULL OR po.project_id = $3::uuid)
        AND ($4::text IS NULL OR po.status::text = $4)
        AND ($5::date IS NULL OR po.order_date >= $5::date)
        AND ($6::date IS NULL OR po.order_date <= $6::date)
      ORDER BY po.order_date DESC, po.order_no DESC
      LIMIT $7 OFFSET $8`,
    [kw, rawSupplier, rawProject, status, dateFrom, dateTo, pageSize, offset],
  );

  const items: PurchaseOrderListItemDto[] = rows.map((r) => ({
    id: r.id,
    orderNo: Number(r.order_no),
    orderName: r.order_name,
    orderDate: r.order_date.slice(0, 10),
    supplierId: r.supplier_id,
    supplierCode: r.supplier_code,
    supplierName: r.supplier_name,
    projectId: r.project_id,
    projectNo: r.project_no !== null ? Number(r.project_no) : null,
    projectName: r.project_name,
    deliveryPlace: r.site_place,
    honorific: r.honorific,
    deliveryDate: r.delivery_date,
    status: r.status,
    roundingMode: r.rounding_mode,
    subtotalAmount: Number(r.subtotal_amount),
    taxTotal: Number(r.tax_total),
    totalAmount: Number(r.total_amount),
    lineCount: Number(r.line_count),
    snapshotCount: Number(r.snapshot_count),
    latestSnapshotVersion:
      r.latest_snapshot_version !== null ? Number(r.latest_snapshot_version) : null,
    linkedPurchaseCount: Number(r.linked_purchase_count),
    updatedAt: r.updated_at,
  }));

  return { items, summary, page, pageSize };
}

export async function getPurchaseOrderDetail(
  tx: DbExecutor,
  tenantId: string,
  orderId: string,
): Promise<PurchaseOrderDetailDto> {
  validateUuid(orderId, '発注');
  await requireFeature(tx, tenantId, 'order');

  const tsRows = await tx.query<{ tax_calc_policy: TaxCalcPolicy }>(
    'SELECT tax_calc_policy::text AS tax_calc_policy FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const policy: TaxCalcPolicy =
    tsRows[0] !== undefined ? tsRows[0].tax_calc_policy : 'SLIP_BY_RATE';

  const rows = await tx.query<{
    id: string;
    order_no: string;
    order_name: string;
    order_date: string;
    supplier_id: string;
    supplier_code: string;
    supplier_name: string;
    project_id: string | null;
    project_no: string | null;
    project_name: string | null;
    site_place: string | null;
    honorific: string;
    delivery_date: string | null;
    status: OrderStatus;
    rounding_mode: RoundingMode;
    subtotal_amount: string;
    tax_total: string;
    total_amount: string;
    remarks: string | null;
    linked_purchase_count: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT po.id, po.order_no::text AS order_no, po.order_name,
            po.order_date::text AS order_date,
            po.supplier_id, bp.partner_code AS supplier_code, bp.partner_name AS supplier_name,
            po.project_id, pj.project_no::text AS project_no, pj.project_name, pj.site_place,
            po.honorific, po.delivery_date, po.status::text AS status,
            po.rounding_mode::text AS rounding_mode,
            po.subtotal_amount::text AS subtotal_amount,
            po.tax_total::text AS tax_total,
            po.total_amount::text AS total_amount,
            po.remarks,
            (SELECT COUNT(*)::int FROM purchases pur WHERE pur.purchase_order_id = po.id) AS linked_purchase_count,
            po.created_at::text AS created_at,
            po.updated_at::text AS updated_at
       FROM purchase_orders po
       JOIN business_partners bp ON bp.tenant_id = po.tenant_id AND bp.id = po.supplier_id
       LEFT JOIN projects pj ON pj.tenant_id = po.tenant_id AND pj.id = po.project_id
      WHERE po.id = $1::uuid
      LIMIT 1`,
    [orderId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'PURCHASE_ORDER_NOT_FOUND', '対象の発注データが見つかりません。');
  }

  const lineRows = await tx.query<{
    id: string;
    line_no: number;
    product_id: string | null;
    prod_is_heading: boolean | null;
    item_code: string | null;
    item_name: string;
    unit_name: string | null;
    quantity: string;
    tax_code: TaxCode;
    master_unit_price: string | null;
    applied_unit_price: string;
    line_amount: string;
    line_tax: string;
    line_total: string;
    remarks: string | null;
  }>(
    `SELECT pol.id, pol.line_no, pol.product_id, p.is_heading AS prod_is_heading,
            pol.item_code, pol.item_name, pol.unit_name,
            pol.quantity::text AS quantity, pol.tax_code,
            pol.master_unit_price::text AS master_unit_price,
            pol.applied_unit_price::text AS applied_unit_price,
            pol.line_amount::text AS line_amount,
            pol.line_tax::text AS line_tax,
            pol.line_total::text AS line_total,
            pol.remarks
       FROM purchase_order_lines pol
       LEFT JOIN products p ON p.tenant_id = pol.tenant_id AND p.id = pol.product_id
      WHERE pol.order_id = $1::uuid
      ORDER BY pol.line_no ASC`,
    [orderId],
  );

  const lines: PurchaseOrderLineDto[] = lineRows.map((l) => {
    const qtyNum = Number(l.quantity);
    const priceNum = Number(l.applied_unit_price);
    const isHeading =
      l.prod_is_heading === true ||
      (qtyNum === 0 && priceNum === 0 && l.unit_name === null && l.tax_code === 'C');
    return {
      id: l.id,
      lineNo: Number(l.line_no),
      productId: l.product_id,
      itemCode: l.item_code,
      itemName: l.item_name,
      unitName: l.unit_name,
      isHeading,
      quantity: qtyNum,
      taxCode: l.tax_code,
      masterUnitPrice: l.master_unit_price !== null ? Number(l.master_unit_price) : null,
      appliedUnitPrice: priceNum,
      lineAmount: Number(l.line_amount),
      lineTax: Number(l.line_tax),
      lineTotal: Number(l.line_total),
      remarks: l.remarks,
    };
  });

  const snapshots = await listEntitySnapshots(tx, {
    documentType: 'PURCHASE_ORDER',
    sourceEntityId: orderId,
  });

  return {
    id: row.id,
    orderNo: Number(row.order_no),
    orderName: row.order_name,
    orderDate: row.order_date.slice(0, 10),
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    supplierName: row.supplier_name,
    projectId: row.project_id,
    projectNo: row.project_no !== null ? Number(row.project_no) : null,
    projectName: row.project_name,
    deliveryPlace: row.site_place,
    honorific: row.honorific,
    deliveryDate: row.delivery_date,
    status: row.status,
    roundingMode: row.rounding_mode,
    taxCalcPolicy: policy,
    subtotalAmount: Number(row.subtotal_amount),
    taxTotal: Number(row.tax_total),
    totalAmount: Number(row.total_amount),
    remarks: row.remarks,
    linkedPurchaseCount: Number(row.linked_purchase_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
    snapshots,
  };
}

async function replaceOrderLines(
  tx: DbExecutor,
  params: {
    tenantId: string;
    orderId: string;
    lines: readonly CleanOrderLine[];
    roundingMode: RoundingMode;
    policy: TaxCalcPolicy;
  },
): Promise<{ subtotalAmount: bigint; taxTotal: bigint; totalAmount: bigint }> {
  const calc = calculateSalesSlip(
    params.lines.map((l, idx) => ({
      lineNo: idx + 1,
      isHeading: l.isHeading,
      quantity: l.quantityStr,
      appliedUnitPrice: BigInt(l.appliedUnitPrice),
      taxCode: l.taxCode,
    })),
    params.roundingMode,
    params.policy,
  );

  await tx.query('DELETE FROM purchase_order_lines WHERE order_id = $1::uuid', [params.orderId]);

  for (let idx = 0; idx < params.lines.length; idx += 1) {
    const line = params.lines[idx];
    const calcRow = calc.lineResults[idx];
    if (line === undefined || calcRow === undefined) {
      throw new MasterDataError(500, 'CALC_MISMATCH', '発注明細の計算結果が不整合です。');
    }
    await tx.query(
      `INSERT INTO purchase_order_lines (
         tenant_id, order_id, line_no, product_id, item_code, item_name, unit_name,
         quantity, tax_code, master_unit_price, applied_unit_price,
         line_amount, line_tax, line_total, remarks
       ) VALUES (
         $1::uuid, $2::uuid, $3::int, $4::uuid, $5, $6, $7,
         $8::numeric, $9, $10::numeric, $11::numeric,
         $12::numeric, $13::numeric, $14::numeric, $15
       )`,
      [
        params.tenantId,
        params.orderId,
        idx + 1,
        line.productId,
        line.itemCode,
        line.itemName,
        line.unitName,
        line.quantityStr,
        line.taxCode,
        line.masterUnitPrice,
        line.isHeading ? 0 : line.appliedUnitPrice,
        calcRow.lineAmount.toString(),
        calcRow.lineTax.toString(),
        calcRow.rowTotal.toString(),
        line.remarks,
      ],
    );
  }

  return {
    subtotalAmount: calc.subtotalAmount,
    taxTotal: calc.taxTotal,
    totalAmount: calc.totalAmount,
  };
}

export async function createPurchaseOrder(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  input: PurchaseOrderInput,
): Promise<PurchaseOrderDetailDto> {
  await requireFeature(tx, tenantId, 'order');
  const clean = validateOrderInput(input);
  const policy = await validateOrderReferences(tx, clean);

  // テナント単位の安全な発注番号採番のため tenant_settings を排他ロック
  await tx.query('SELECT id FROM tenant_settings WHERE tenant_id = $1::uuid FOR UPDATE', [tenantId]);
  const maxRows = await tx.query<{ max_no: string }>(
    'SELECT COALESCE(MAX(order_no), 0)::text AS max_no FROM purchase_orders',
    [],
  );
  const nextNo = BigInt(maxRows[0] !== undefined ? maxRows[0].max_no : '0') + 1n;

  let orderId: string | undefined;
  try {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO purchase_orders (
         tenant_id, order_no, order_name, order_date, supplier_id, project_id,
         honorific, delivery_date, status, rounding_mode,
         subtotal_amount, tax_total, total_amount, remarks,
         created_by, updated_by
       ) VALUES (
         $1::uuid, $2::bigint, $3, $4::date, $5::uuid, $6::uuid,
         $7, $8, $9::order_status, $10::rounding_mode,
         0, 0, 0, $11,
         $12::uuid, $12::uuid
       ) RETURNING id`,
      [
        tenantId,
        nextNo.toString(),
        clean.orderName,
        clean.orderDate,
        clean.supplierId,
        clean.projectId,
        clean.honorific,
        clean.deliveryDate,
        clean.status,
        clean.roundingMode,
        clean.remarks,
        employeeId,
      ],
    );
    orderId = inserted[0]?.id;
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '発注データ' });
  }

  if (orderId === undefined) {
    throw new MasterDataError(500, 'ORDER_INSERT_FAILED', '発注データの登録結果を取得できませんでした。');
  }

  const totals = await replaceOrderLines(tx, {
    tenantId,
    orderId,
    lines: clean.lines,
    roundingMode: clean.roundingMode,
    policy,
  });

  await tx.query(
    `UPDATE purchase_orders
        SET subtotal_amount = $2::numeric,
            tax_total = $3::numeric,
            total_amount = $4::numeric,
            updated_by = $5::uuid
      WHERE id = $1::uuid`,
    [
      orderId,
      totals.subtotalAmount.toString(),
      totals.taxTotal.toString(),
      totals.totalAmount.toString(),
      employeeId,
    ],
  );

  return getPurchaseOrderDetail(tx, tenantId, orderId);
}

export async function updatePurchaseOrder(
  tx: DbExecutor,
  tenantId: string,
  employeeId: string,
  orderId: string,
  input: PurchaseOrderInput,
): Promise<PurchaseOrderDetailDto> {
  validateUuid(orderId, '発注');
  await requireFeature(tx, tenantId, 'order');

  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM purchase_orders WHERE id = $1::uuid FOR UPDATE',
    [orderId],
  );
  if (existing.length === 0) {
    throw new MasterDataError(404, 'PURCHASE_ORDER_NOT_FOUND', '対象の発注データが見つかりません。');
  }

  const clean = validateOrderInput(input);
  const policy = await validateOrderReferences(tx, clean);

  const totals = await replaceOrderLines(tx, {
    tenantId,
    orderId,
    lines: clean.lines,
    roundingMode: clean.roundingMode,
    policy,
  });

  try {
    await tx.query(
      `UPDATE purchase_orders
          SET order_name = $2,
              order_date = $3::date,
              supplier_id = $4::uuid,
              project_id = $5::uuid,
              honorific = $6,
              delivery_date = $7,
              status = $8::order_status,
              rounding_mode = $9::rounding_mode,
              subtotal_amount = $10::numeric,
              tax_total = $11::numeric,
              total_amount = $12::numeric,
              remarks = $13,
              updated_by = $14::uuid
        WHERE id = $1::uuid`,
      [
        orderId,
        clean.orderName,
        clean.orderDate,
        clean.supplierId,
        clean.projectId,
        clean.honorific,
        clean.deliveryDate,
        clean.status,
        clean.roundingMode,
        totals.subtotalAmount.toString(),
        totals.taxTotal.toString(),
        totals.totalAmount.toString(),
        clean.remarks,
        employeeId,
      ],
    );
  } catch (err) {
    throw mapPgConstraintError(err, { entityLabel: '発注データ' });
  }

  return getPurchaseOrderDetail(tx, tenantId, orderId);
}

export async function deletePurchaseOrder(
  tx: DbExecutor,
  tenantId: string,
  orderId: string,
): Promise<{ id: string }> {
  validateUuid(orderId, '発注');
  await requireFeature(tx, tenantId, 'order');

  const existing = await tx.query<{ id: string }>(
    'SELECT id FROM purchase_orders WHERE id = $1::uuid FOR UPDATE',
    [orderId],
  );
  if (existing.length === 0) {
    throw new MasterDataError(404, 'PURCHASE_ORDER_NOT_FOUND', '対象の発注データが見つかりません。');
  }

  const snapRows = await tx.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
       FROM document_snapshots
      WHERE source_entity_type = 'PURCHASE_ORDER'
        AND source_entity_id = $1::uuid`,
    [orderId],
  );
  if (snapRows[0] !== undefined && Number(snapRows[0].cnt) > 0) {
    throw new MasterDataError(
      409,
      'ORDER_HAS_SNAPSHOTS',
      '発注書スナップショットを発行済みの発注データは削除できません。',
    );
  }

  const purRows = await tx.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM purchases WHERE purchase_order_id = $1::uuid',
    [orderId],
  );
  if (purRows[0] !== undefined && Number(purRows[0].cnt) > 0) {
    throw new MasterDataError(
      409,
      'ORDER_LINKED_TO_PURCHASE',
      '仕入伝票へ転記済みの発注データは削除できません。',
    );
  }

  await tx.query('DELETE FROM purchase_orders WHERE id = $1::uuid', [orderId]);
  return { id: orderId };
}

export async function exportPurchaseOrdersCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: PurchaseOrderListFilter,
): Promise<string> {
  const result = await listPurchaseOrders(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const header = [
    '発注No',
    '発注日',
    '状態',
    '仕入先コード',
    '仕入先名',
    '件名',
    '案件No',
    '案件名',
    '納入場所(案件現場)',
    '納期',
    '税抜金額',
    '消費税',
    '税込金額',
  ].map(escapeCsvCell);

  const lines = [header.join(',')];
  for (const item of result.items) {
    lines.push(
      [
        String(item.orderNo),
        item.orderDate,
        ORDER_STATUS_LABELS[item.status],
        item.supplierCode,
        item.supplierName,
        item.orderName,
        item.projectNo !== null ? String(item.projectNo) : '',
        item.projectName !== null ? item.projectName : '',
        item.deliveryPlace !== null ? item.deliveryPlace : '',
        item.deliveryDate !== null ? item.deliveryDate : '',
        String(item.subtotalAmount),
        String(item.taxTotal),
        String(item.totalAmount),
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function buildPurchaseOrdersPdfInput(
  tx: DbExecutor,
  tenantId: string,
  filter: PurchaseOrderListFilter,
): Promise<PurchaseOrderListPdfInput> {
  const result = await listPurchaseOrders(tx, tenantId, { ...filter, page: 1, pageSize: 5000 });
  const settingsRows = await tx.query<{ company_name: string }>(
    'SELECT company_name FROM tenant_settings WHERE tenant_id = $1::uuid LIMIT 1',
    [tenantId],
  );
  const companyName = settingsRows[0] !== undefined ? settingsRows[0].company_name : '自社';

  return {
    companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: `状態:${filter.status !== null && filter.status !== undefined ? ORDER_STATUS_LABELS[filter.status] : 'すべて'}`,
    items: result.items.map((item) => ({
      orderNo: item.orderNo,
      orderDate: item.orderDate,
      statusLabel: ORDER_STATUS_LABELS[item.status],
      supplierName: item.supplierName,
      orderName: item.orderName,
      projectName: item.projectName,
      deliveryDate: item.deliveryDate,
      subtotalAmount: item.subtotalAmount,
      taxTotal: item.taxTotal,
      totalAmount: item.totalAmount,
    })),
    totals: {
      count: result.summary.totalCount,
      subtotalAmount: result.summary.subtotalAmount,
      taxTotal: result.summary.taxTotal,
      totalAmount: result.summary.totalAmount,
    },
  };
}
