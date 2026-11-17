'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const lengthOk = newPassword.length >= 10;
  const mixOk = /[A-Za-z]/.test(newPassword) && /[0-9]/.test(newPassword);
  const noSpaceOk = newPassword !== '' && !/\s/.test(newPassword);
  const matchOk = newPassword !== '' && newPassword === confirmPassword;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (newPassword !== confirmPassword) {
      setErrorMsg('新しいパスワードと確認用パスワードが一致しません。');
      return;
    }

    setSubmitting(true);
    const submitChange = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const res = await fetch('/api/v1/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const json = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || json.ok !== true) {
          return {
            ok: false,
            error:
              typeof json.error === 'string' && json.error !== ''
                ? json.error
                : 'パスワード変更に失敗しました。',
          };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? '通信エラーが発生しました。' : '通信エラーが発生しました。',
        };
      }
    };

    const result = await submitChange();
    setSubmitting(false);
    if (!result.ok) {
      setErrorMsg(result.error);
      return;
    }

    setSuccessMsg('パスワードを更新しました。ダッシュボードへ移動します...');
    router.push('/');
    router.refresh();
  }

  async function handleLogout() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg border border-slate-200 p-8">
        <div className="mb-6">
          <h1 className="text-xl font-bold text-slate-900">パスワードの変更</h1>
          <p className="text-sm text-slate-600 mt-1">
            セキュリティ確保のため、条件を満たす新しいパスワードへ変更してください。更新後は既存の他セッションは即時失効します。
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
        {successMsg !== null && (
          <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
            {successMsg}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="currentPassword" className="block text-sm font-medium text-slate-700 mb-1">
              現在のパスワード
            </label>
            <input
              id="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <div>
            <label htmlFor="newPassword" className="block text-sm font-medium text-slate-700 mb-1">
              新しいパスワード
            </label>
            <input
              id="newPassword"
              type="password"
              required
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-sm font-medium text-slate-700 mb-1">
              新しいパスワード（確認用）
            </label>
            <input
              id="confirmPassword"
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>

          <ul className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs space-y-1">
            <li className={lengthOk ? 'text-emerald-700 font-medium' : 'text-slate-600'}>
              {lengthOk ? '✓' : '・'} 10文字以上
            </li>
            <li className={mixOk ? 'text-emerald-700 font-medium' : 'text-slate-600'}>
              {mixOk ? '✓' : '・'} 半角英字と半角数字の両方を含む
            </li>
            <li className={noSpaceOk ? 'text-emerald-700 font-medium' : 'text-slate-600'}>
              {noSpaceOk ? '✓' : '・'} 空白文字を含まない
            </li>
            <li className={matchOk ? 'text-emerald-700 font-medium' : 'text-slate-600'}>
              {matchOk ? '✓' : '・'} 確認用パスワードと一致
            </li>
          </ul>

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-slate-400 transition-colors cursor-pointer"
          >
            {submitting ? '更新中...' : 'パスワードを更新する'}
          </button>
        </form>

        <div className="mt-4 flex justify-between items-center text-xs text-slate-500">
          <button
            type="button"
            onClick={handleLogout}
            className="text-slate-600 hover:text-slate-900 underline cursor-pointer"
          >
            ログアウトして戻る
          </button>
        </div>
      </div>
    </div>
  );
}
