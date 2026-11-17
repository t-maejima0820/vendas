'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [tenantSlug, setTenantSlug] = useState('');
  const [syainCode, setSyainCode] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);

    const attemptLogin = async (): Promise<
      { ok: true; mustChangePassword: boolean } | { ok: false; error: string }
    > => {
      try {
        const res = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantSlug, syainCode, password }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          user?: { mustChangePassword?: boolean };
        };
        if (!res.ok || json.ok !== true) {
          return {
            ok: false,
            error:
              typeof json.error === 'string' && json.error !== ''
                ? json.error
                : 'ログインに失敗しました。入力内容をご確認ください。',
          };
        }
        return {
          ok: true,
          mustChangePassword: json.user?.mustChangePassword === true,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? '通信エラーが発生しました。' : '通信エラーが発生しました。',
        };
      }
    };

    const result = await attemptLogin();
    setSubmitting(false);
    if (!result.ok) {
      setErrorMsg(result.error);
      return;
    }

    if (result.mustChangePassword) {
      router.push('/change-password');
    } else {
      router.push('/');
    }
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg border border-slate-200 p-8">
        <div className="mb-6">
          <div className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 mb-2">
            Vendas Web Platform
          </div>
          <h1 className="text-2xl font-bold text-slate-900">販売管理ヴェンダス ログイン</h1>
          <p className="text-sm text-slate-600 mt-1">
            企業ID・社員コード・パスワードを入力してください。
          </p>
        </div>

        {errorMsg !== null && (
          <div
            role="alert"
            className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800"
          >
            {errorMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="tenantSlug" className="block text-sm font-medium text-slate-700 mb-1">
              企業ID（テナント識別子）
            </label>
            <input
              id="tenantSlug"
              type="text"
              required
              autoComplete="organization"
              placeholder="例: dev-sandbox"
              value={tenantSlug}
              onChange={(e) => setTenantSlug(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <div>
            <label htmlFor="syainCode" className="block text-sm font-medium text-slate-700 mb-1">
              社員コード
            </label>
            <input
              id="syainCode"
              type="text"
              required
              autoComplete="username"
              placeholder="例: 999"
              value={syainCode}
              onChange={(e) => setSyainCode(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
              パスワード
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-slate-400 transition-colors cursor-pointer"
          >
            {submitting ? '認証中...' : 'ログイン'}
          </button>
        </form>

        <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500">
          セキュリティ保護のため、連続5回の認証失敗でアカウントが一時ロックされます。
        </div>
      </div>
    </div>
  );
}
