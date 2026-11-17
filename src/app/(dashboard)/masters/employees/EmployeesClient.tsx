'use client';

import { useState } from 'react';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import type {
  CodeMasterItem,
  CreateEmployeeInput,
  EmployeeDto,
  UpdateEmployeeInput,
} from '@/lib/masters/types';

interface EmployeesClientProps {
  initialItems: EmployeeDto[];
  genders: CodeMasterItem[];
  currentEmployeeId: string;
}

interface EmployeeFormState {
  syainCode: string;
  syainName: string;
  kanaName: string;
  initialPassword: string;
  isAdmin: boolean;
  menuType: string;
  email: string;
  joinedAt: string;
  birthDate: string;
  retiredAt: string;
  isRetired: boolean;
  genderCode: string;
  postalCode: string;
  address1: string;
  address2: string;
  steadyJobNote: string;
  workExperience: string;
}

function emptyEmployeeForm(): EmployeeFormState {
  return {
    syainCode: '',
    syainName: '',
    kanaName: '',
    initialPassword: '',
    isAdmin: false,
    menuType: '3',
    email: '',
    joinedAt: '',
    birthDate: '',
    retiredAt: '',
    isRetired: false,
    genderCode: '',
    postalCode: '',
    address1: '',
    address2: '',
    steadyJobNote: '',
    workExperience: '',
  };
}

function formFromEmployee(emp: EmployeeDto): EmployeeFormState {
  return {
    syainCode: emp.syainCode,
    syainName: emp.syainName,
    kanaName: emp.kanaName ?? '',
    initialPassword: '',
    isAdmin: emp.isAdmin,
    menuType: String(emp.menuType),
    email: emp.email ?? '',
    joinedAt: emp.joinedAt ?? '',
    birthDate: emp.birthDate ?? '',
    retiredAt: emp.retiredAt ?? '',
    isRetired: emp.isRetired,
    genderCode: emp.genderCode ?? '',
    postalCode: emp.postalCode ?? '',
    address1: emp.address1 ?? '',
    address2: emp.address2 ?? '',
    steadyJobNote: emp.steadyJobNote ?? '',
    workExperience: emp.workExperience ?? '',
  };
}

export default function EmployeesClient({
  initialItems,
  genders,
  currentEmployeeId,
}: EmployeesClientProps) {
  const [items, setItems] = useState<EmployeeDto[]>(initialItems);
  const [keyword, setKeyword] = useState('');
  const [includeRetired, setIncludeRetired] = useState(true);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [form, setForm] = useState<EmployeeFormState>(() => emptyEmployeeForm());

  const [pwResetTarget, setPwResetTarget] = useState<EmployeeDto | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [pwResetError, setPwResetError] = useState<string | null>(null);

  async function reloadList(overrides?: { q?: string; includeRetired?: boolean }) {
    const q = overrides?.q ?? keyword;
    const withRetired = overrides?.includeRetired ?? includeRetired;
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (q.trim() !== '') params.set('q', q.trim());
    if (withRetired) params.set('includeRetired', 'true');
    const queryStr = params.toString();
    const url = queryStr !== '' ? `/api/v1/masters/employees?${queryStr}` : '/api/v1/masters/employees';
    const result = await requestMasterApi<{ items: EmployeeDto[] }>(url);
    setLoading(false);
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setItems(result.data.items);
  }

  function openCreateModal() {
    setEditingId(null);
    setModalError(null);
    setForm(emptyEmployeeForm());
    setModalOpen(true);
  }

  function openEditModal(emp: EmployeeDto) {
    setEditingId(emp.id);
    setModalError(null);
    setForm(formFromEmployee(emp));
    setModalOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    setBannerSuccess(null);

    if (form.syainCode.trim() === '' || form.syainName.trim() === '') {
      setModalError('社員コードと社員名は必須です。');
      return;
    }

    const menuTypeNum = Number(form.menuType.trim() === '' ? '3' : form.menuType.trim());
    if (!Number.isInteger(menuTypeNum) || menuTypeNum < 0) {
      setModalError('メニュー区分は0以上の整数で指定してください。');
      return;
    }

    const rawGender = normalizeNullableText(form.genderCode);
    const genderCode = rawGender === 'S1' || rawGender === 'S2' ? rawGender : null;

    const commonPayload: UpdateEmployeeInput = {
      syainCode: form.syainCode.trim(),
      syainName: form.syainName.trim(),
      kanaName: normalizeNullableText(form.kanaName),
      isAdmin: form.isAdmin,
      menuType: menuTypeNum,
      email: normalizeNullableText(form.email),
      joinedAt: normalizeNullableText(form.joinedAt),
      birthDate: normalizeNullableText(form.birthDate),
      retiredAt: normalizeNullableText(form.retiredAt),
      isRetired: form.isRetired,
      genderCode,
      postalCode: normalizeNullableText(form.postalCode),
      address1: normalizeNullableText(form.address1),
      address2: normalizeNullableText(form.address2),
      steadyJobNote: normalizeNullableText(form.steadyJobNote),
      workExperience: normalizeNullableText(form.workExperience),
    };

    setSaving(true);
    if (editingId === null) {
      if (form.initialPassword.length < 10) {
        setSaving(false);
        setModalError('初期パスワードは10文字以上で指定してください。');
        return;
      }
      const createPayload: CreateEmployeeInput = {
        ...commonPayload,
        initialPassword: form.initialPassword,
      };
      const result = await requestMasterApi<{ item: EmployeeDto }>('/api/v1/masters/employees', {
        method: 'POST',
        body: JSON.stringify(createPayload),
      });
      setSaving(false);
      if (!result.ok) {
        setModalError(result.error);
        return;
      }
      setModalOpen(false);
      setBannerSuccess(`社員「${result.data.item.syainName}」を登録しました（初回パスワード変更必須）。`);
      await reloadList();
      return;
    }

    const result = await requestMasterApi<{ item: EmployeeDto }>(
      `/api/v1/masters/employees/${encodeURIComponent(editingId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(commonPayload),
      },
    );
    setSaving(false);
    if (!result.ok) {
      setModalError(result.error);
      return;
    }
    setModalOpen(false);
    setBannerSuccess(`社員「${result.data.item.syainName}」を更新しました。`);
    await reloadList();
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (pwResetTarget === null) return;
    setPwResetError(null);
    setBannerSuccess(null);

    if (newPassword.length < 10) {
      setPwResetError('仮パスワードは10文字以上・英字と数字を含めて入力してください。');
      return;
    }

    setSaving(true);
    const result = await requestMasterApi<{ item: EmployeeDto }>(
      `/api/v1/masters/employees/${encodeURIComponent(pwResetTarget.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'RESET_PASSWORD', newPassword }),
      },
    );
    setSaving(false);
    if (!result.ok) {
      setPwResetError(result.error);
      return;
    }

    setPwResetTarget(null);
    setNewPassword('');
    setBannerSuccess(
      `社員「${result.data.item.syainName}」のパスワードを初期化しました（次回ログイン時変更必須・セッション失効済み）。`,
    );
    await reloadList();
  }

  async function handleUnlock(emp: EmployeeDto) {
    setBannerError(null);
    setBannerSuccess(null);
    const result = await requestMasterApi<{ item: EmployeeDto }>(
      `/api/v1/masters/employees/${encodeURIComponent(emp.id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'UNLOCK' }),
      },
    );
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setBannerSuccess(`社員「${result.data.item.syainName}」のアカウントロックを解除しました。`);
    await reloadList();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">社員マスタ（管理者専用）</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            権限区分・退職フラグの変更時は対象社員のセッション（session_version）が即時失効します。
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          ＋ 新規社員登録
        </button>
      </div>

      {bannerError !== null && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {bannerError}
        </div>
      )}
      {bannerSuccess !== null && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {bannerSuccess}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void reloadList();
        }}
        className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3"
      >
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="社員コード・氏名・カナ・メールアドレス"
          className="flex-1 min-w-[220px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-600 px-1">
          <input
            type="checkbox"
            checked={includeRetired}
            onChange={(e) => setIncludeRetired(e.target.checked)}
          />
          退職者を含む
        </label>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-slate-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
        >
          {loading ? '検索中...' : '検索'}
        </button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2.5">社員コード</th>
              <th className="px-3 py-2.5">氏名 / カナ</th>
              <th className="px-3 py-2.5">権限 / メニュー</th>
              <th className="px-3 py-2.5">在籍状態</th>
              <th className="px-3 py-2.5">認証セキュリティ状態</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                  該当する社員データがありません。
                </td>
              </tr>
            ) : (
              items.map((emp) => {
                const isSelf = emp.id === currentEmployeeId;
                const isLocked = emp.lockedUntil !== null || emp.failedLoginCount > 0;
                return (
                  <tr
                    key={emp.id}
                    className={`hover:bg-slate-50 ${emp.isRetired ? 'opacity-65 bg-slate-50' : ''}`}
                  >
                    <td className="px-3 py-2.5 font-mono text-xs text-slate-700">
                      {emp.syainCode}
                      {isSelf && (
                        <span className="ml-1.5 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">
                          あなた
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-900">{emp.syainName}</div>
                      <div className="text-xs text-slate-500">
                        {emp.kanaName ?? ''} {emp.email !== null ? `・ ${emp.email}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {emp.isAdmin ? (
                        <span className="rounded bg-purple-100 px-2 py-0.5 text-[11px] font-semibold text-purple-800">
                          管理者
                        </span>
                      ) : (
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                          一般
                        </span>
                      )}
                      <span className="ml-2 text-slate-500 font-mono">menu:{emp.menuType}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {emp.isRetired ? (
                        <span className="rounded bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                          退職済 {emp.retiredAt !== null ? `(${emp.retiredAt})` : ''}
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                          在籍
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs space-x-1 whitespace-nowrap">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                        v{emp.sessionVersion}
                      </span>
                      {emp.mustChangePassword && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800">
                          初回PW未変更
                        </span>
                      )}
                      {emp.lockedUntil !== null && (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">
                          ロック中
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1.5">
                      <button
                        type="button"
                        onClick={() => openEditModal(emp)}
                        className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPwResetTarget(emp);
                          setNewPassword('');
                          setPwResetError(null);
                        }}
                        className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                      >
                        PW初期化
                      </button>
                      {isLocked && (
                        <button
                          type="button"
                          onClick={() => void handleUnlock(emp)}
                          className="rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                        >
                          ロック解除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-3xl rounded-xl bg-white shadow-xl border border-slate-200 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-base font-bold text-slate-900">
                {editingId === null ? '新規社員登録' : `社員情報の編集: ${form.syainName}`}
              </h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕ 閉じる
              </button>
            </div>
            <form onSubmit={(e) => void handleSave(e)} className="p-6 space-y-4">
              {modalError !== null && (
                <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {modalError}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    社員コード <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.syainCode}
                    onChange={(e) => setForm({ ...form, syainCode: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    社員氏名 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.syainName}
                    onChange={(e) => setForm({ ...form, syainName: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">フリガナ</label>
                  <input
                    type="text"
                    value={form.kanaName}
                    onChange={(e) => setForm({ ...form, kanaName: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              {editingId === null && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3">
                  <label className="block text-xs font-bold text-blue-900 mb-1">
                    初期仮パスワード <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="password"
                    required
                    value={form.initialPassword}
                    onChange={(e) => setForm({ ...form, initialPassword: e.target.value })}
                    placeholder="10文字以上・英字＋数字混在（社員コード同一不可）"
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono"
                  />
                  <p className="text-[11px] text-blue-800 mt-1">
                    新規登録された社員は初回ログイン時に必ずパスワード変更画面へ遷移します。
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">メニュー区分</label>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={form.menuType}
                    onChange={(e) => setForm({ ...form, menuType: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">性別</label>
                  <select
                    value={form.genderCode}
                    onChange={(e) => setForm({ ...form, genderCode: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                  >
                    <option value="">（未選択）</option>
                    {genders.map((g) => (
                      <option key={g.code} value={g.code}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">入社日</label>
                  <input
                    type="date"
                    value={form.joinedAt}
                    onChange={(e) => setForm({ ...form, joinedAt: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">生年月日</label>
                  <input
                    type="date"
                    value={form.birthDate}
                    onChange={(e) => setForm({ ...form, birthDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-6 rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs">
                <label className="flex items-center gap-2 font-medium text-slate-700">
                  <input
                    type="checkbox"
                    disabled={editingId === currentEmployeeId}
                    checked={form.isAdmin}
                    onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })}
                  />
                  管理者権限を付与（is_admin）
                </label>
                <label className="flex items-center gap-2 font-medium text-red-700">
                  <input
                    type="checkbox"
                    disabled={editingId === currentEmployeeId}
                    checked={form.isRetired}
                    onChange={(e) => setForm({ ...form, isRetired: e.target.checked })}
                  />
                  退職・無効化フラグ
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-slate-600">退職日:</span>
                  <input
                    type="date"
                    value={form.retiredAt}
                    onChange={(e) => setForm({ ...form, retiredAt: e.target.value })}
                    className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">メールアドレス</label>
                  <input
                    type="text"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">郵便番号</label>
                  <input
                    type="text"
                    value={form.postalCode}
                    onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">住所1</label>
                  <input
                    type="text"
                    value={form.address1}
                    onChange={(e) => setForm({ ...form, address1: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">住所2</label>
                  <input
                    type="text"
                    value={form.address2}
                    onChange={(e) => setForm({ ...form, address2: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">常駐・担当備考</label>
                  <input
                    type="text"
                    value={form.steadyJobNote}
                    onChange={(e) => setForm({ ...form, steadyJobNote: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">職務経歴・資格メモ</label>
                <textarea
                  rows={2}
                  value={form.workExperience}
                  onChange={(e) => setForm({ ...form, workExperience: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? '保存中...' : '社員を保存する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {pwResetTarget !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl border border-slate-200">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
              <h2 className="text-sm font-bold text-slate-900">
                パスワード初期化: {pwResetTarget.syainName} ({pwResetTarget.syainCode})
              </h2>
              <button
                type="button"
                onClick={() => setPwResetTarget(null)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕
              </button>
            </div>
            <form onSubmit={(e) => void handleResetPassword(e)} className="p-5 space-y-4">
              {pwResetError !== null && (
                <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {pwResetError}
                </div>
              )}
              <p className="text-xs text-slate-600">
                新しい仮パスワードを設定すると、現在のログインセッションは即時失効し、ロックも解除され、次回ログイン時にパスワード変更が強制されます。
              </p>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  新しい仮パスワード（10文字以上・英字＋数字）
                </label>
                <input
                  type="password"
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPwResetTarget(null)}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {saving ? '処理中...' : '初期化を実行'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
