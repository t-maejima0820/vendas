import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { parseMasterJsonBody } from '@/lib/masters/error-mapper';
import { parseProductInputBody } from '@/lib/masters/product-payload';
import { createProduct, listProducts } from '@/lib/masters/products-service';
import type { ProductInput } from '@/lib/masters/types';

export const GET = withApiHandler({}, async ({ req, tx }) => {
  const url = new URL(req.url);
  const items = await listProducts(tx, {
    keyword: url.searchParams.get('q'),
    categoryCode: url.searchParams.get('categoryCode'),
    headingOnly: url.searchParams.get('headingOnly') === 'true',
    subscriptionOnly: url.searchParams.get('subscriptionOnly') === 'true',
    includeDeleted: url.searchParams.get('includeDeleted') === 'true',
  });
  return NextResponse.json({ ok: true, items });
});

export const POST = withApiHandler({}, async ({ req, user, tx }) => {
  const body = await parseMasterJsonBody<Partial<ProductInput>>(req);
  const item = await createProduct(tx, user.tenantId, parseProductInputBody(body));
  return NextResponse.json({ ok: true, item }, { status: 201 });
});
