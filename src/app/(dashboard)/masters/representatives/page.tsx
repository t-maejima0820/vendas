import RepresentativesClient from '@/app/(dashboard)/masters/representatives/RepresentativesClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getMasterLookups } from '@/lib/masters/lookups-service';
import { listRepresentatives } from '@/lib/masters/representatives-service';

export default async function RepresentativesPage() {
  const { items, lookups } = await runWithPageSession(async ({ tx }) => {
    const [items, lookups] = await Promise.all([
      listRepresentatives(tx),
      getMasterLookups(tx),
    ]);
    return { items, lookups };
  });

  return <RepresentativesClient initialItems={items} genders={lookups.genders} />;
}
