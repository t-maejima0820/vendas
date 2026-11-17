import PartnersClient from '@/app/(dashboard)/masters/partners/PartnersClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getMasterLookups } from '@/lib/masters/lookups-service';
import { listBusinessPartners } from '@/lib/masters/partners-service';

export default async function PartnersPage() {
  const { items, lookups, isAdmin } = await runWithPageSession(async ({ user, tx }) => {
    const [items, lookups] = await Promise.all([
      listBusinessPartners(tx),
      getMasterLookups(tx),
    ]);
    return { items, lookups, isAdmin: user.isAdmin };
  });

  return <PartnersClient initialItems={items} lookups={lookups} isAdmin={isAdmin} />;
}
