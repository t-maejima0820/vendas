'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface MastersSubNavProps {
  isAdmin: boolean;
}

export default function MastersSubNav({ isAdmin }: MastersSubNavProps) {
  const pathname = usePathname();

  const tabs: Array<{ href: string; label: string; exact?: boolean }> = [
    { href: '/masters', label: '概要ハブ', exact: true },
    { href: '/masters/partners', label: '取引先（顧客・仕入先）' },
    { href: '/masters/representatives', label: '代表者' },
    { href: '/masters/products', label: '商品・工事項目' },
    { href: '/masters/banks', label: '金融機関・支店' },
    { href: '/masters/codes', label: '区分・単位・税・支払' },
    { href: '/masters/auxiliary', label: '補助業務（メール/候補/税務署）' },
  ];

  if (isAdmin) {
    tabs.push({ href: '/masters/employees', label: '社員（管理者専用）' });
  }

  return (
    <div className="mb-5 border-b border-slate-200">
      <nav className="flex flex-wrap gap-1 -mb-px">
        {tabs.map((tab) => {
          const active =
            tab.exact === true ? pathname === tab.href : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`rounded-t-lg px-4 py-2 text-xs font-semibold border-b-2 transition-colors ${
                active
                  ? 'border-blue-600 text-blue-700 bg-white'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100/70'
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
