import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  extractEntityIdFromRequest,
  parseMasterJsonBody,
} from '@/lib/masters/error-mapper';
import { parseProductInputBody } from '@/lib/masters/product-payload';
import { updateProduct } from '@/lib/masters/products-service';
import type { ProductInput } from '@/lib/masters/types';

export const PUT = withApiHandler({}, async ({ req, tx }) => {
  const id = extractEntityIdFromRequest(req, '商品');
  const body = await parseMasterJsonBody<Partial<ProductInput>>(req);
  const item = await updateProduct(tx, id, parseProductInputBody(body));
  return NextResponse.json({ ok: true, item });
});
