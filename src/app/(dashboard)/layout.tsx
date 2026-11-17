import { redirect } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { loadPageSessionContext } from '@/lib/auth/page-session';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const ctx = await loadPageSessionContext();
  if (!ctx.ok) {
    redirect('/login');
  }
  if (ctx.liveUser.mustChangePassword) {
    redirect('/change-password');
  }

  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">読み込み中...</div>}>
      <DashboardShell
        tenantName={ctx.liveUser.tenantName}
        tenantSlug={ctx.liveUser.tenantSlug}
        companyName={ctx.companyName}
        syainCode={ctx.liveUser.syainCode}
        syainName={ctx.liveUser.syainName}
        isAdmin={ctx.liveUser.isAdmin}
        enabledFeatures={ctx.enabledFeatures}
      >
        {children}
      </DashboardShell>
    </Suspense>
  );
}
