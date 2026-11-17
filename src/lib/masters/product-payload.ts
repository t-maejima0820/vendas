import type { ProductInput } from '@/lib/masters/types';

export function parseProductInputBody(body: Partial<ProductInput>): ProductInput {
  let defaultTaxCode: ProductInput['defaultTaxCode'] = 'A';
  if (
    body.defaultTaxCode === 'A' ||
    body.defaultTaxCode === 'B' ||
    body.defaultTaxCode === 'C' ||
    body.defaultTaxCode === 'D' ||
    body.defaultTaxCode === 'E'
  ) {
    defaultTaxCode = body.defaultTaxCode;
  }

  return {
    productCode: typeof body.productCode === 'string' ? body.productCode : '',
    productName: typeof body.productName === 'string' ? body.productName : '',
    productNameSub: typeof body.productNameSub === 'string' ? body.productNameSub : null,
    monthFlagCode: typeof body.monthFlagCode === 'string' ? body.monthFlagCode : null,
    capacity: body.capacity === undefined ? 0 : Number(body.capacity),
    unitId: typeof body.unitId === 'string' ? body.unitId : null,
    standardUnitPrice: body.standardUnitPrice === undefined ? 0 : Number(body.standardUnitPrice),
    standardPurchasePrice:
      body.standardPurchasePrice === undefined ? 0 : Number(body.standardPurchasePrice),
    standardCostPrice: body.standardCostPrice === undefined ? 0 : Number(body.standardCostPrice),
    defaultTaxCode,
    itemCategoryCode: typeof body.itemCategoryCode === 'string' ? body.itemCategoryCode : null,
    kubun: typeof body.kubun === 'string' ? body.kubun : null,
    isStockManaged: Boolean(body.isStockManaged),
    stockQuantity: body.stockQuantity === undefined ? 0 : Number(body.stockQuantity),
    isSubscriptionTarget: Boolean(body.isSubscriptionTarget),
    isHeading: Boolean(body.isHeading),
    isDeleted: Boolean(body.isDeleted),
  };
}
