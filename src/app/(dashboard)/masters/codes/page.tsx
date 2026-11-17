import CodesClient from '@/app/(dashboard)/masters/codes/CodesClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import {
  listCodeMasters,
  listPaymentMethods,
  listTaxCodes,
  listUnits,
} from '@/lib/masters/codes-service';

export default async function CodesPage() {
  const data = await runWithPageSession(async ({ user, tx }) => {
    const [codeMasters, units, paymentMethods, taxCodes] = await Promise.all([
      listCodeMasters(tx, null, true),
      listUnits(tx, true),
      listPaymentMethods(tx),
      listTaxCodes(tx),
    ]);
    return { codeMasters, units, paymentMethods, taxCodes, isAdmin: user.isAdmin };
  });

  return (
    <CodesClient
      initialCodeMasters={data.codeMasters}
      initialUnits={data.units}
      initialPaymentMethods={data.paymentMethods}
      initialTaxCodes={data.taxCodes}
      isAdmin={data.isAdmin}
    />
  );
}
