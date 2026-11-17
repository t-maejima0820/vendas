import BanksClient from '@/app/(dashboard)/masters/banks/BanksClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { listBankBranches, listBanks } from '@/lib/masters/banks-service';

export default async function BanksPage() {
  const { banks, branchPage } = await runWithPageSession(async ({ tx }) => {
    const [banks, branchPage] = await Promise.all([
      listBanks(tx),
      listBankBranches(tx, { page: 1, pageSize: 50 }),
    ]);
    return { banks, branchPage };
  });

  return <BanksClient initialBanks={banks} initialBranchPage={branchPage} />;
}
