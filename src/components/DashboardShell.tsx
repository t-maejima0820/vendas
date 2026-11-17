'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type ReactNode } from 'react';

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
          <Link href="/" className="font-bold text-base tracking-tight text-white hover:text-blue-200">
            販売管理ヴェンダス
          </Link>
          <span className="text-slate-500">|</span>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-slate-100">{companyName || tenantName}</span>
            <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-xs font-mono">
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
        {/* 左サイドバー（契約有効機能に応じて動的出し分け） */}
        <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shrink-0">
          <nav className="flex-1 overflow-y-auto p-3 space-y-5">
            <div>
              <div className="px-3 mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                メイン
              </div>
              <Link
                href="/"
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  pathname === '/'
                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                ダッシュボードトップ
              </Link>
            </div>

            <div>
              <div className="px-3 mb-1.5 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  業務メニュー
                </span>
                <span className="text-[11px] text-slate-400">{enabledFeatures.length}有効</span>
              </div>
              <div className="space-y-0.5">
                {enabledFeatures.map((feat) => {
                  const salesTab = searchParams.get('tab');
                  const costCategoryParam = searchParams.get('category');
                  let href = '/';
                  let isSelected = pathname === '/';

                  if (feat.featureCode === 'estimate') {
                    href = '/estimates';
                    isSelected = pathname.startsWith('/estimates');
                  } else if (feat.featureCode === 'sales') {
                    href = '/sales?tab=SALE';
                    isSelected =
                      pathname.startsWith('/sales') &&
                      salesTab !== 'ADVANCE' &&
                      salesTab !== 'SUMMARY';
                  } else if (feat.featureCode === 'tatekae') {
                    href = '/sales?tab=ADVANCE';
                    isSelected = pathname.startsWith('/sales') && salesTab === 'ADVANCE';
                  } else if (feat.featureCode === 'custom-sum-item') {
                    href = '/sales?tab=SUMMARY';
                    isSelected = pathname.startsWith('/sales') && salesTab === 'SUMMARY';
                  } else if (feat.featureCode === 'fixedbill') {
                    href = '/subscriptions';
                    isSelected = pathname.startsWith('/subscriptions');
                  } else if (feat.featureCode === 'billsummary') {
                    href = '/billing?tab=CANDIDATES';
                    isSelected = pathname.startsWith('/billing') && salesTab !== 'ISSUED';
                  } else if (feat.featureCode === 'billissue') {
                    href = '/billing?tab=ISSUED';
                    isSelected = pathname.startsWith('/billing') && salesTab === 'ISSUED';
                  } else if (feat.featureCode === 'receivable') {
                    href = '/receivables?tab=BALANCES';
                    isSelected = pathname.startsWith('/receivables') && salesTab !== 'RECEIPTS';
                  } else if (feat.featureCode === 'deposit') {
                    href = '/receivables?tab=RECEIPTS';
                    isSelected = pathname.startsWith('/receivables') && salesTab === 'RECEIPTS';
                  } else if (feat.featureCode === 'aplus') {
                    href = '/aplus';
                    isSelected = pathname.startsWith('/aplus');
                  } else if (feat.featureCode === 'order') {
                    href = '/purchasing?tab=ORDERS';
                    isSelected = pathname.startsWith('/purchasing') && salesTab !== 'PURCHASES';
                  } else if (feat.featureCode === 'purchase') {
                    href = '/purchasing?tab=PURCHASES';
                    isSelected = pathname.startsWith('/purchasing') && salesTab === 'PURCHASES';
                  } else if (feat.featureCode === 'payable') {
                    href = '/payables?tab=BALANCES';
                    isSelected = pathname.startsWith('/payables') && salesTab !== 'PAYMENTS';
                  } else if (feat.featureCode === 'payment') {
                    href = '/payables?tab=PAYMENTS';
                    isSelected = pathname.startsWith('/payables') && salesTab === 'PAYMENTS';
                  } else if (feat.featureCode === 'construction') {
                    href = '/projects';
                    isSelected = pathname.startsWith('/projects');
                  } else if (
                    feat.featureCode === 'budget' ||
                    feat.featureCode === 'constructionimage'
                  ) {
                    href = '/projects';
                    isSelected = false;
                  } else if (feat.featureCode === 'cost') {
                    href = '/costs';
                    isSelected = pathname.startsWith('/costs') && costCategoryParam === null;
                  } else if (feat.featureCode === 'expense') {
                    href = '/costs?category=EXPENSE';
                    isSelected =
                      pathname.startsWith('/costs') && costCategoryParam === 'EXPENSE';
                  } else if (feat.featureCode === 'labor') {
                    href = '/costs?category=LABOR';
                    isSelected = pathname.startsWith('/costs') && costCategoryParam === 'LABOR';
                  } else if (feat.featureCode === 'material') {
                    href = '/costs?category=MATERIAL';
                    isSelected =
                      pathname.startsWith('/costs') && costCategoryParam === 'MATERIAL';
                  } else if (feat.featureCode === 'outsourcing') {
                    href = '/costs?category=OUTSOURCING';
                    isSelected =
                      pathname.startsWith('/costs') && costCategoryParam === 'OUTSOURCING';
                  } else if (feat.featureCode === 'temporary') {
                    href = '/costs?category=TEMPORARY';
                    isSelected =
                      pathname.startsWith('/costs') && costCategoryParam === 'TEMPORARY';
                  } else if (feat.featureCode === 'indirect') {
                    href = '/costs?category=INDIRECT';
                    isSelected =
                      pathname.startsWith('/costs') && costCategoryParam === 'INDIRECT';
                  } else if (feat.featureCode === 'estimateimage') {
                    href = '/estimates';
                    isSelected = false;
                  } else if (feat.featureCode === 'stock') {
                    href = '/stock';
                    isSelected = pathname.startsWith('/stock');
                  } else if (feat.featureCode === 'item') {
                    href = '/analytics';
                    isSelected = pathname.startsWith('/analytics');
                  } else if (feat.featureCode === 'mail') {
                    href = '/mail';
                    isSelected = pathname.startsWith('/mail');
                  } else if (feat.featureCode === 'teams') {
                    href = '/chat';
                    isSelected = pathname.startsWith('/chat');
                  }

                  return (
                    <Link
                      key={feat.featureCode}
                      href={href}
                      className={`flex items-center justify-between rounded-lg px-3 py-1.5 text-sm transition-colors ${
                        isSelected
                          ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <span>{feat.featureName}</span>
                      <span className="text-[10px] font-mono text-slate-400">{feat.featureCode}</span>
                    </Link>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="px-3 mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                マスタ管理
              </div>
              <div className="space-y-0.5">
                <Link
                  href="/masters"
                  className={`block rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    pathname === '/masters'
                      ? 'bg-blue-50 text-blue-700 border border-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  マスタ管理ハブ
                </Link>
                <Link
                  href="/masters/partners"
                  className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    pathname.startsWith('/masters/partners')
                      ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  取引先マスタ
                </Link>
                <Link
                  href="/masters/representatives"
                  className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    pathname.startsWith('/masters/representatives')
                      ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  代表者マスタ
                </Link>
                <Link
                  href="/masters/products"
                  className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    pathname.startsWith('/masters/products')
                      ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  商品・工事項目マスタ
                </Link>
                <Link
                  href="/masters/banks"
                  className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    pathname.startsWith('/masters/banks')
                      ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  金融機関・支店マスタ
                </Link>
                <Link
                  href="/masters/codes"
                  className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    pathname.startsWith('/masters/codes')
                      ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  区分・単位・税・支払
                </Link>
                <Link
                  href="/masters/auxiliary"
                  className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    pathname.startsWith('/masters/auxiliary')
                      ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  補助業務マスタ
                </Link>
                {isAdmin && (
                  <Link
                    href="/masters/employees"
                    className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      pathname.startsWith('/masters/employees')
                        ? 'bg-blue-50 text-blue-700 font-medium border border-blue-200'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    社員マスタ（管理者）
                  </Link>
                )}
              </div>
            </div>

            {isAdmin && (
              <div>
                <div className="px-3 mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  システム管理
                </div>
                <Link
                  href="/settings"
                  className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    pathname === '/settings'
                      ? 'bg-blue-50 text-blue-700 border border-blue-200'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  自社・機能権限設定
                </Link>
              </div>
            )}
          </nav>
        </aside>

        {/* メイン領域 */}
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
