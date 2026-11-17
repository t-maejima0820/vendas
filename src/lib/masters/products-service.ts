import type { DbExecutor } from '@/lib/db/tenant-client';
import { mapPgConstraintError, MasterDataError } from '@/lib/masters/error-mapper';
import type { ProductDto, ProductInput } from '@/lib/masters/types';

export interface ProductListFilter {
  keyword?: string | null;
  categoryCode?: string | null;
  headingOnly?: boolean;
  subscriptionOnly?: boolean;
  includeDeleted?: boolean;
}

type ProductRow = {
  id: string;
  product_code: string;
  product_name: string;
  product_name_sub: string | null;
  month_flag_code: string | null;
  capacity: string | number;
  unit_id: string | null;
  unit_name: string | null;
  standard_unit_price: string | number;
  standard_purchase_price: string | number;
  standard_cost_price: string | number;
  default_tax_code: 'A' | 'B' | 'C' | 'D' | 'E';
  item_category_code: string | null;
  kubun: string | null;
  is_stock_managed: boolean;
  stock_quantity: string | number;
  is_subscription_target: boolean;
  is_heading: boolean;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TAX_CODES = new Set(['A', 'B', 'C', 'D', 'E']);

function optTrimmed(val: string | null | undefined): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateUuidOrNull(val: string | null, label: string): string | null {
  const trimmed = optTrimmed(val);
  if (trimmed === null) {
    return null;
  }
  if (!UUID_REGEX.test(trimmed)) {
    throw new MasterDataError(400, 'INVALID_UUID', `${label}のID形式が不正です。`);
  }
  return trimmed;
}

function validateProductId(id: string): void {
  if (!UUID_REGEX.test(id)) {
    throw new MasterDataError(400, 'INVALID_ID', '商品IDの形式が不正です。');
  }
}

function validateIntegerPrice(val: number, label: string): number {
  if (!Number.isInteger(val) || Math.abs(val) > 999999999999) {
    throw new MasterDataError(400, 'INVALID_PRICE', `${label}は整数で入力してください。`);
  }
  return val;
}

function validateFiniteDecimal(val: number, label: string): number {
  if (!Number.isFinite(val) || Math.abs(val) > 9999999999) {
    throw new MasterDataError(400, 'INVALID_QUANTITY', `${label}は有効な数値で入力してください。`);
  }
  return val;
}

function validateProductInput(input: ProductInput): ProductInput {
  const productCode = input.productCode.trim();
  if (productCode.length === 0 || productCode.length > 60) {
    throw new MasterDataError(400, 'INVALID_PRODUCT_CODE', '商品コードは1〜60文字で入力してください。');
  }
  const productName = input.productName.trim();
  if (productName.length === 0 || productName.length > 200) {
    throw new MasterDataError(400, 'INVALID_PRODUCT_NAME', '商品名は1〜200文字で入力してください。');
  }
  if (!VALID_TAX_CODES.has(input.defaultTaxCode)) {
    throw new MasterDataError(400, 'INVALID_TAX_CODE', '標準税区分は A〜E のいずれかを指定してください。');
  }

  return {
    productCode,
    productName,
    productNameSub: optTrimmed(input.productNameSub),
    monthFlagCode: optTrimmed(input.monthFlagCode),
    capacity: validateFiniteDecimal(input.capacity, '容量'),
    unitId: validateUuidOrNull(input.unitId, '単位'),
    standardUnitPrice: validateIntegerPrice(input.standardUnitPrice, '標準販売単価'),
    standardPurchasePrice: validateIntegerPrice(input.standardPurchasePrice, '標準仕入単価'),
    standardCostPrice: validateIntegerPrice(input.standardCostPrice, '標準原価単価'),
    defaultTaxCode: input.defaultTaxCode,
    itemCategoryCode: optTrimmed(input.itemCategoryCode),
    kubun: optTrimmed(input.kubun),
    isStockManaged: Boolean(input.isStockManaged),
    stockQuantity: validateFiniteDecimal(input.stockQuantity, '現在庫数'),
    isSubscriptionTarget: Boolean(input.isSubscriptionTarget),
    isHeading: Boolean(input.isHeading),
    isDeleted: Boolean(input.isDeleted),
  };
}

function mapProductRow(row: ProductRow): ProductDto {
  return {
    id: row.id,
    productCode: row.product_code,
    productName: row.product_name,
    productNameSub: row.product_name_sub,
    monthFlagCode: row.month_flag_code,
    capacity: Number(row.capacity),
    unitId: row.unit_id,
    unitName: row.unit_name,
    standardUnitPrice: Number(row.standard_unit_price),
    standardPurchasePrice: Number(row.standard_purchase_price),
    standardCostPrice: Number(row.standard_cost_price),
    defaultTaxCode: row.default_tax_code,
    itemCategoryCode: row.item_category_code,
    kubun: row.kubun,
    isStockManaged: row.is_stock_managed,
    stockQuantity: Number(row.stock_quantity),
    isSubscriptionTarget: row.is_subscription_target,
    isHeading: row.is_heading,
    isDeleted: row.is_deleted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listProducts(
  tx: DbExecutor,
  filter: ProductListFilter = {},
): Promise<ProductDto[]> {
  const kw = optTrimmed(filter.keyword);
  const cat = optTrimmed(filter.categoryCode);
  const headingOnly = filter.headingOnly === true;
  const subscriptionOnly = filter.subscriptionOnly === true;
  const includeDeleted = filter.includeDeleted === true;

  const rows = await tx.query<ProductRow>(
    `SELECT
       p.id,
       p.product_code,
       p.product_name,
       p.product_name_sub,
       p.month_flag_code,
       p.capacity::text AS capacity,
       p.unit_id,
       u.unit_name,
       p.standard_unit_price::text AS standard_unit_price,
       p.standard_purchase_price::text AS standard_purchase_price,
       p.standard_cost_price::text AS standard_cost_price,
       p.default_tax_code,
       p.item_category_code,
       p.kubun,
       p.is_stock_managed,
       p.stock_quantity::text AS stock_quantity,
       p.is_subscription_target,
       p.is_heading,
       p.is_deleted,
       p.created_at::text AS created_at,
       p.updated_at::text AS updated_at
     FROM products p
     LEFT JOIN units u
       ON u.tenant_id = p.tenant_id AND u.id = p.unit_id
     WHERE (
       $1::text IS NULL
       OR p.product_code ILIKE '%' || $1 || '%'
       OR p.product_name ILIKE '%' || $1 || '%'
       OR COALESCE(p.product_name_sub, '') ILIKE '%' || $1 || '%'
     )
     AND ($2::text IS NULL OR p.item_category_code = $2)
     AND ($3::boolean = false OR p.is_heading = true)
     AND ($4::boolean = false OR p.is_subscription_target = true)
     AND ($5::boolean = true OR p.is_deleted = false)
     ORDER BY p.product_code ASC`,
    [kw, cat, headingOnly, subscriptionOnly, includeDeleted],
  );
  return rows.map(mapProductRow);
}

async function getProductById(tx: DbExecutor, id: string): Promise<ProductDto> {
  const rows = await tx.query<ProductRow>(
    `SELECT
       p.id,
       p.product_code,
       p.product_name,
       p.product_name_sub,
       p.month_flag_code,
       p.capacity::text AS capacity,
       p.unit_id,
       u.unit_name,
       p.standard_unit_price::text AS standard_unit_price,
       p.standard_purchase_price::text AS standard_purchase_price,
       p.standard_cost_price::text AS standard_cost_price,
       p.default_tax_code,
       p.item_category_code,
       p.kubun,
       p.is_stock_managed,
       p.stock_quantity::text AS stock_quantity,
       p.is_subscription_target,
       p.is_heading,
       p.is_deleted,
       p.created_at::text AS created_at,
       p.updated_at::text AS updated_at
     FROM products p
     LEFT JOIN units u
       ON u.tenant_id = p.tenant_id AND u.id = p.unit_id
     WHERE p.id = $1::uuid`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new MasterDataError(404, 'PRODUCT_NOT_FOUND', '指定された商品が見つかりません。');
  }
  return mapProductRow(row);
}

export async function createProduct(
  tx: DbExecutor,
  tenantId: string,
  input: ProductInput,
): Promise<ProductDto> {
  const clean = validateProductInput(input);
  let insertedId: string;
  try {
    const insertedRows = await tx.query<{ id: string }>(
      `INSERT INTO products (
         tenant_id, product_code, product_name, product_name_sub, month_flag_code,
         capacity, unit_id, standard_unit_price, standard_purchase_price, standard_cost_price,
         default_tax_code, item_category_code, kubun, is_stock_managed, stock_quantity,
         is_subscription_target, is_heading, is_deleted
       ) VALUES (
         $1::uuid, $2, $3, $4, $5,
         $6, $7::uuid, $8, $9, $10,
         $11, $12, $13, $14, $15,
         $16, $17, $18
       )
       RETURNING id`,
      [
        tenantId,
        clean.productCode,
        clean.productName,
        clean.productNameSub,
        clean.monthFlagCode,
        clean.capacity,
        clean.unitId,
        clean.standardUnitPrice,
        clean.standardPurchasePrice,
        clean.standardCostPrice,
        clean.defaultTaxCode,
        clean.itemCategoryCode,
        clean.kubun,
        clean.isStockManaged,
        clean.stockQuantity,
        clean.isSubscriptionTarget,
        clean.isHeading,
        clean.isDeleted,
      ],
    );
    const insertedRow = insertedRows[0];
    if (insertedRow === undefined) {
      throw new MasterDataError(500, 'INSERT_FAILED', '商品の登録結果を取得できませんでした。');
    }
    insertedId = insertedRow.id;
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '商品',
      defaultUniqueMessage: `商品コード「${clean.productCode}」は既に登録されています。別のコードを指定してください。`,
      defaultFkMessage: '指定された単位マスタが存在しません。',
    });
  }
  return getProductById(tx, insertedId);
}

export async function updateProduct(
  tx: DbExecutor,
  id: string,
  input: ProductInput,
): Promise<ProductDto> {
  validateProductId(id);
  const clean = validateProductInput(input);

  try {
    const updatedRows = await tx.query<{ id: string }>(
      `UPDATE products
       SET
         product_code = $2,
         product_name = $3,
         product_name_sub = $4,
         month_flag_code = $5,
         capacity = $6,
         unit_id = $7::uuid,
         standard_unit_price = $8,
         standard_purchase_price = $9,
         standard_cost_price = $10,
         default_tax_code = $11,
         item_category_code = $12,
         kubun = $13,
         is_stock_managed = $14,
         stock_quantity = $15,
         is_subscription_target = $16,
         is_heading = $17,
         is_deleted = $18
       WHERE id = $1::uuid
       RETURNING id`,
      [
        id,
        clean.productCode,
        clean.productName,
        clean.productNameSub,
        clean.monthFlagCode,
        clean.capacity,
        clean.unitId,
        clean.standardUnitPrice,
        clean.standardPurchasePrice,
        clean.standardCostPrice,
        clean.defaultTaxCode,
        clean.itemCategoryCode,
        clean.kubun,
        clean.isStockManaged,
        clean.stockQuantity,
        clean.isSubscriptionTarget,
        clean.isHeading,
        clean.isDeleted,
      ],
    );
    if (updatedRows.length === 0) {
      throw new MasterDataError(404, 'PRODUCT_NOT_FOUND', '指定された商品が見つかりません。');
    }
  } catch (err) {
    throw mapPgConstraintError(err, {
      entityLabel: '商品',
      defaultUniqueMessage: `商品コード「${clean.productCode}」は既に他の商品に登録されています。`,
      defaultFkMessage: '指定された単位マスタが存在しません。',
    });
  }
  return getProductById(tx, id);
}
