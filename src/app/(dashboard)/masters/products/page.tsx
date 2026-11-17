import ProductsClient from '@/app/(dashboard)/masters/products/ProductsClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getMasterLookups } from '@/lib/masters/lookups-service';
import { listProducts } from '@/lib/masters/products-service';

export default async function ProductsPage() {
  const { items, lookups } = await runWithPageSession(async ({ tx }) => {
    const [items, lookups] = await Promise.all([
      listProducts(tx),
      getMasterLookups(tx),
    ]);
    return { items, lookups };
  });

  return <ProductsClient initialItems={items} lookups={lookups} />;
}
