import type { ReactNode } from 'react';
import MastersSubNav from '@/app/(dashboard)/masters/MastersSubNav';
import { requireLivePageUser } from '@/lib/auth/page-session';

export default async function MastersLayout({ children }: { children: ReactNode }) {
  const user = await requireLivePageUser();

  return (
    <div>
      <MastersSubNav isAdmin={user.isAdmin} />
      {children}
    </div>
  );
}
