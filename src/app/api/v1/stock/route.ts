import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { MasterDataError, parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { listStockProducts, updateProductStock } from '@/lib/stock/stock-service';

export const GET = withApiHandler({ requiredFeature: 'stock' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const data = await listStockProducts(tx, user.tenantId, {
    keyword: url.searchParams.get('keyword'),
    managedOnly: url.searchParams.get('managedOnly') === '1',
    categoryCode: url.searchParams.get('categoryCode'),
  });
  return NextResponse.json({ ok: true, ...data });
});

export const PATCH = withApiHandler({ requiredFeature: 'stock' }, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Record<string, unknown>>(req);
  if (typeof body.productId !== 'string' || typeof body.isStockManaged !== 'boolean') {
    throw new MasterDataError(400, 'INVALID_PAYLOAD', 'productId と isStockManaged は必須です。');
  }
  const qty = Number(body.stockQuantity);
  if (!Number.isFinite(qty)) {
    throw new MasterDataError(400, 'INVALID_QUANTITY', 'stockQuantity は数値で指定してください。');
  }
  const item = await updateProductStock(tx, user.tenantId, {
    productId: body.productId,
    isStockManaged: body.isStockManaged,
    stockQuantity: qty,
  });
  return NextResponse.json({ ok: true, item });
});
