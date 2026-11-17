import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: '販売管理ヴェンダス（Vendas Web）',
  description: '販売・購買・案件原価管理 マルチテナントSaaS基盤',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
