import { redirect } from 'next/navigation';
import DashboardClient from '@/app/(dashboard)/DashboardClient';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getDashboardOverview } from '@/lib/dashboard/dashboard-service';

export default async function DashboardHomePage({
  searchParams,
}: {
  searchParams: Promise<{ feature?: string }>;
}) {
  const params = await searchParams;
  const featureParam = params.feature;
  if (featureParam === 'estimate' || featureParam === 'estimateimage') {
    redirect('/estimates');
  }
  if (featureParam === 'sales') {
    redirect('/sales?tab=SALE');
  }
  if (featureParam === 'tatekae') {
    redirect('/sales?tab=ADVANCE');
  }
  if (featureParam === 'custom-sum-item') {
    redirect('/sales?tab=SUMMARY');
  }
  if (featureParam === 'fixedbill') {
    redirect('/subscriptions');
  }
  if (featureParam === 'billsummary') {
    redirect('/billing?tab=CANDIDATES');
  }
  if (featureParam === 'billissue') {
    redirect('/billing?tab=ISSUED');
  }
  if (featureParam === 'receivable') {
    redirect('/receivables?tab=BALANCES');
  }
  if (featureParam === 'deposit') {
    redirect('/receivables?tab=RECEIPTS');
  }
  if (featureParam === 'aplus') {
    redirect('/aplus');
  }
  if (featureParam === 'order') {
    redirect('/purchasing?tab=ORDERS');
  }
  if (featureParam === 'purchase') {
    redirect('/purchasing?tab=PURCHASES');
  }
  if (featureParam === 'payable') {
    redirect('/payables?tab=BALANCES');
  }
  if (featureParam === 'payment') {
    redirect('/payables?tab=PAYMENTS');
  }
  if (
    featureParam === 'construction' ||
    featureParam === 'budget' ||
    featureParam === 'constructionimage'
  ) {
    redirect('/projects');
  }
  if (featureParam === 'cost') {
    redirect('/costs');
  }
  if (featureParam === 'expense') {
    redirect('/costs?category=EXPENSE');
  }
  if (featureParam === 'labor') {
    redirect('/costs?category=LABOR');
  }
  if (featureParam === 'material') {
    redirect('/costs?category=MATERIAL');
  }
  if (featureParam === 'outsourcing') {
    redirect('/costs?category=OUTSOURCING');
  }
  if (featureParam === 'temporary') {
    redirect('/costs?category=TEMPORARY');
  }
  if (featureParam === 'indirect') {
    redirect('/costs?category=INDIRECT');
  }
  if (featureParam === 'stock') {
    redirect('/stock');
  }
  if (featureParam === 'item') {
    redirect('/analytics');
  }
  if (featureParam === 'mail') {
    redirect('/mail');
  }
  if (featureParam === 'teams') {
    redirect('/chat');
  }

  const data = await runWithPageSession(async ({ user, tx }) => {
    const overview = await getDashboardOverview(tx, user.tenantId, null);
    return { overview, isAdmin: user.isAdmin };
  });

  return <DashboardClient initialOverview={data.overview} isAdmin={data.isAdmin} />;
}
