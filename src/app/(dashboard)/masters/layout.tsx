import type { ReactNode } from 'react';
import MastersSubNav from '@/app/(dashboard)/masters/MastersSubNav';
import { runWithPageSession } from '@/lib/auth/page-session';

export default async function MastersLayout({ children }: { children: ReactNode }) {
  const isAdmin = await runWithPageSession(async ({ user }) => user.isAdmin);

  return (
    <div>
      <MastersSubNav isAdmin={isAdmin} />
      {children}
    </div>
  );
}
