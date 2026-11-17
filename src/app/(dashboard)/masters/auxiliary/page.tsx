import AuxiliaryClient from '@/app/(dashboard)/masters/auxiliary/AuxiliaryClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import {
  listInputIntelligences,
  listMailTemplates,
  listTaxOffices,
} from '@/lib/masters/auxiliary-service';
import { listTaxCodes, listUnits } from '@/lib/masters/codes-service';

export default async function AuxiliaryPage() {
  const data = await runWithPageSession(async ({ tx }) => {
    const [mailTemplates, intelligencePage, taxOffices, taxCodes, units] = await Promise.all([
      listMailTemplates(tx),
      listInputIntelligences(tx, { page: 1, pageSize: 25 }),
      listTaxOffices(tx),
      listTaxCodes(tx),
      listUnits(tx, false),
    ]);
    return { mailTemplates, intelligencePage, taxOffices, taxCodes, units };
  });

  return (
    <AuxiliaryClient
      initialMailTemplates={data.mailTemplates}
      initialIntelligencePage={data.intelligencePage}
      initialTaxOffices={data.taxOffices}
      taxCodes={data.taxCodes}
      units={data.units}
    />
  );
}
