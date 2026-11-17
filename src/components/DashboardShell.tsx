'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition, type MouseEvent, type ReactNode } from 'react';
import DashboardLoading from '@/app/(dashboard)/loading';

export interface NavFeatureItem {
  featureCode: string;
  featureName: string;
  displayOrder: number;
}

interface DashboardShellProps {
  tenantName: string;
  tenantSlug: string;
  companyName: string;
  syainCode: string;
  syainName: string;
  isAdmin: boolean;
  enabledFeatures: NavFeatureItem[];
  children: ReactNode;
}

export default function DashboardShell({
  tenantName,
  tenantSlug,
  companyName,
  syainCode,
  syainName,
  isAdmin,
  enabledFeatures,
  children,
}: DashboardShellProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    setPendingHref(null);
  }, [pathname, searchParams]);

  let activePathname = pathname;
  let activeSearchParams = new URLSearchParams(searchParams.toString());
  if (pendingHref !== null) {
    const qIdx = pendingHref.indexOf('?');
    if (qIdx >= 0) {
      activePathname = pendingHref.slice(0, qIdx);
      activeSearchParams = new URLSearchParams(pendingHref.slice(qIdx + 1));
    } else {
      activePathname = pendingHref;
      activeSearchParams = new URLSearchParams();
    }
  }

  function handleNavClick(e: MouseEvent<HTMLAnchorElement>, href: string) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    const qIdx = href.indexOf('?');
    const targetPath = qIdx >= 0 ? href.slice(0, qIdx) : href;
    const targetQuery = qIdx >= 0 ? new URLSearchParams(href.slice(qIdx + 1)).toString() : '';
    const currentQuery = searchParams.toString();
    if (targetPath === pathname && targetQuery === currentQuery) {
      return;
    }
    e.preventDefault();
    setPendingHref(href);
    startTransition(() => {
      router.push(href);
    });
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST' });
      router.push('/login');
      router.refresh();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* ヘッダバー */}
      <header className="h-14 bg-slate-900 text-white px-6 flex items-center justify-between shrink-0 border-b border-slate-800">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            prefetch={false}
            onClick={(e) => handleNavClick(e, '/')}
            className="font-bold text-base tracking-tight text-white hover:text-[#CCCCFF]"
          >
            販売管理ヴェンダス
          </Link>
          <span className="text-slate-500">|</span>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-slate-100">{companyName || tenantName}</span>
            <span className="px-2.5 py-0.5 rounded-full bg-slate-800 text-slate-300 text-xs font-mono border border-slate-700">
              {tenantSlug}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-slate-200">
              {syainName} <span className="text-slate-400 font-mono text-xs">({syainCode})</span>
            </span>
            {isAdmin ? (
              <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-300 border border-amber-400/30">
                管理者
              </span>
            ) : (
              <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-700 text-slate-300">
                一般
              </span>
            )}
          </div>

          <Link
            href="/change-password"
            prefetch={false}
            className="text-xs text-slate-300 hover:text-white underline-offset-4 hover:underline"
          >
            パスワード変更
          </Link>

          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-100 transition-colors cursor-pointer"
          >
            {loggingOut ? '終了中...' : 'ログアウト'}
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* 左サイドバー（ヘッダ同色のダークトーンで画面を引き締め） */}
        <aside className="w-64 bg-slate-900 text-slate-200 border-r border-slate-800 flex flex-col shrink-0 select-none">
          <nav className="flex-1 overflow-y-auto p-3 space-y-5">
            <div>
              <div className="px-3 mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                メイン
              </div>
              <Link
                href="/"
                prefetch={false}
                onClick={(e) => handleNavClick(e, '/')}
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  activePathname === '/'
                    ? 'bg-[#7878FF]/25 text-white font-bold border border-[#9999FF]/60 shadow-2xs'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white border border-transparent'
                }`}
              >
                ダッシュボードトップ
              </Link>
            </div>

            <div>
              <div className="px-3 mb-1.5 flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  業務メニュー
                </span>
                <span className="text-[11px] font-mono text-slate-400">{enabledFeatures.length}有効</span>
              </div>
              <div className="space-y-0.5">
                {enabledFeatures.map((feat) => {
                  const salesTab = activeSearchParams.get('tab');
                  const costCategoryParam = activeSearchParams.get('category');
                  let href = '/';
                  let isSelected = activePathname === '/';

                  if (feat.featureCode === 'estimate') {
                    href = '/estimates';
                    isSelected = activePathname.startsWith('/estimates');
                  } else if (feat.featureCode === 'sales') {
                    href = '/sales?tab=SALE';
                    isSelected =
                      activePathname.startsWith('/sales') &&
                      salesTab !== 'ADVANCE' &&
                      salesTab !== 'SUMMARY';
                  } else if (feat.featureCode === 'tatekae') {
                    href = '/sales?tab=ADVANCE';
                    isSelected = activePathname.startsWith('/sales') && salesTab === 'ADVANCE';
                  } else if (feat.featureCode === 'custom-sum-item') {
                    href = '/sales?tab=SUMMARY';
                    isSelected = activePathname.startsWith('/sales') && salesTab === 'SUMMARY';
                  } else if (feat.featureCode === 'fixedbill') {
                    href = '/subscriptions';
                    isSelected = activePathname.startsWith('/subscriptions');
                  } else if (feat.featureCode === 'billsummary') {
                    href = '/billing?tab=CANDIDATES';
                    isSelected = activePathname.startsWith('/billing') && salesTab !== 'ISSUED';
                  } else if (feat.featureCode === 'billissue') {
                    href = '/billing?tab=ISSUED';
                    isSelected = activePathname.startsWith('/billing') && salesTab === 'ISSUED';
                  } else if (feat.featureCode === 'receivable') {
                    href = '/receivables?tab=BALANCES';
                    isSelected = activePathname.startsWith('/receivables') && salesTab !== 'RECEIPTS';
                  } else if (feat.featureCode === 'deposit') {
                    href = '/receivables?tab=RECEIPTS';
                    isSelected = activePathname.startsWith('/receivables') && salesTab === 'RECEIPTS';
                  } else if (feat.featureCode === 'aplus') {
                    href = '/aplus';
                    isSelected = activePathname.startsWith('/aplus');
                  } else if (feat.featureCode === 'order') {
                    href = '/purchasing?tab=ORDERS';
                    isSelected = activePathname.startsWith('/purchasing') && salesTab !== 'PURCHASES';
                  } else if (feat.featureCode === 'purchase') {
                    href = '/purchasing?tab=PURCHASES';
                    isSelected = activePathname.startsWith('/purchasing') && salesTab === 'PURCHASES';
                  } else if (feat.featureCode === 'payable') {
                    href = '/payables?tab=BALANCES';
                    isSelected = activePathname.startsWith('/payables') && salesTab !== 'PAYMENTS';
                  } else if (feat.featureCode === 'payment') {
                    href = '/payables?tab=PAYMENTS';
                    isSelected = activePathname.startsWith('/payables') && salesTab === 'PAYMENTS';
                  } else if (feat.featureCode === 'construction') {
                    href = '/projects';
                    isSelected = activePathname.startsWith('/projects');
                  } else if (
                    feat.featureCode === 'budget' ||
                    feat.featureCode === 'constructionimage'
                  ) {
                    href = '/projects';
                    isSelected = false;
                  } else if (feat.featureCode === 'cost') {
                    href = '/costs';
                    isSelected = activePathname.startsWith('/costs') && costCategoryParam === null;
                  } else if (feat.featureCode === 'expense') {
                    href = '/costs?category=EXPENSE';
                    isSelected =
                      activePathname.startsWith('/costs') && costCategoryParam === 'EXPENSE';
                  } else if (feat.featureCode === 'labor') {
                    href = '/costs?category=LABOR';
                    isSelected = activePathname.startsWith('/costs') && costCategoryParam === 'LABOR';
                  } else if (feat.featureCode === 'material') {
                    href = '/costs?category=MATERIAL';
                    isSelected =
                      activePathname.startsWith('/costs') && costCategoryParam === 'MATERIAL';
                  } else if (feat.featureCode === 'outsourcing') {
                    href = '/costs?category=OUTSOURCING';
                    isSelected =
                      activePathname.startsWith('/costs') && costCategoryParam === 'OUTSOURCING';
                  } else if (feat.featureCode === 'temporary') {
                    href = '/costs?category=TEMPORARY';
                    isSelected =
                      activePathname.startsWith('/costs') && costCategoryParam === 'TEMPORARY';
                  } else if (feat.featureCode === 'indirect') {
                    href = '/costs?category=INDIRECT';
                    isSelected =
                      activePathname.startsWith('/costs') && costCategoryParam === 'INDIRECT';
                  } else if (feat.featureCode === 'estimateimage') {
                    href = '/estimates';
                    isSelected = false;
                  } else if (feat.featureCode === 'stock') {
                    href = '/stock';
                    isSelected = activePathname.startsWith('/stock');
                  } else if (feat.featureCode === 'item') {
                    href = '/analytics';
                    isSelected = activePathname.startsWith('/analytics');
                  } else if (feat.featureCode === 'mail') {
                    href = '/mail';
                    isSelected = activePathname.startsWith('/mail');
                  } else if (feat.featureCode === 'teams') {
                    href = '/chat';
                    isSelected = activePathname.startsWith('/chat');
                  }

                  return (
                    <Link
                      key={feat.featureCode}
                      href={href}
                      prefetch={false}
                      onClick={(e) => handleNavClick(e, href)}
                      className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm transition-colors ${
                        isSelected
                          ? 'bg-[#7878FF]/25 text-white font-bold border border-[#9999FF]/60 shadow-2xs'
                          : 'text-slate-300 hover:bg-slate-800 hover:text-white border border-transparent'
                      }`}
                    >
                      <span>{feat.featureName}</span>
                      <span
                        className={`text-[10px] font-mono ${
                          isSelected ? 'text-[#CCCCFF]' : 'text-slate-500'
                        }`}
                      >
                        {feat.featureCode}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="px-3 mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                マスタ管理
              </div>
              <div className="space-y-0.5">
                {[
                  { href: '/masters', label: 'マスタ管理ハブ', exact: true, bold: true },
                  { href: '/masters/partners', label: '取引先マスタ', exact: false, bold: false },
                  { href: '/masters/representatives', label: '代表者マスタ', exact: false, bold: false },
                  { href: '/masters/products', label: '商品・工事項目マスタ', exact: false, bold: false },
                  { href: '/masters/banks', label: '金融機関・支店マスタ', exact: false, bold: false },
                  { href: '/masters/codes', label: '区分・単位・税・支払', exact: false, bold: false },
                  { href: '/masters/auxiliary', label: '補助業務マスタ', exact: false, bold: false },
                  ...(isAdmin
                    ? [{ href: '/masters/employees', label: '社員マスタ（管理者）', exact: false, bold: false }]
                    : []),
                ].map((item) => {
                  const selected = item.exact
                    ? activePathname === item.href
                    : activePathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      prefetch={false}
                      onClick={(e) => handleNavClick(e, item.href)}
                      className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                        selected
                          ? 'bg-[#7878FF]/25 text-white font-bold border border-[#9999FF]/60 shadow-2xs'
                          : `text-slate-300 hover:bg-slate-800 hover:text-white border border-transparent${item.bold ? ' font-medium' : ''}`
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>

            {isAdmin && (
              <div>
                <div className="px-3 mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  システム管理
                </div>
                <Link
                  href="/settings"
                  prefetch={false}
                  onClick={(e) => handleNavClick(e, '/settings')}
                  className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    activePathname === '/settings'
                      ? 'bg-[#7878FF]/25 text-white font-bold border border-[#9999FF]/60 shadow-2xs'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white border border-transparent'
                  }`}
                >
                  自社・機能権限設定
                </Link>
              </div>
            )}
          </nav>
        </aside>

        {/* メイン領域 */}
        <main className="flex-1 overflow-y-auto p-6">
          {isPending || pendingHref !== null ? <DashboardLoading /> : children}
        </main>
      </div>
    </div>
  );
}
