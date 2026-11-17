'use client';

import { useState } from 'react';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import type { CodeMasterItem, RepresentativeDto, RepresentativeInput } from '@/lib/masters/types';

interface RepresentativesClientProps {
  initialItems: RepresentativeDto[];
  genders: CodeMasterItem[];
}

interface FormState {
  representativeCode: string;
  representativeName: string;
  furigana: string;
  postalCode: string;
  address1: string;
  address2: string;
  tel: string;
  mobile: string;
  birthDate: string;
  genderCode: string;
}

function emptyFormState(nextCode: number): FormState {
  return {
    representativeCode: String(nextCode),
    representativeName: '',
    furigana: '',
    postalCode: '',
    address1: '',
    address2: '',
    tel: '',
    mobile: '',
    birthDate: '',
    genderCode: '',
  };
}

function formFromDto(item: RepresentativeDto): FormState {
  return {
    representativeCode: String(item.representativeCode),
    representativeName: item.representativeName,
    furigana: item.furigana ?? '',
    postalCode: item.postalCode ?? '',
    address1: item.address1 ?? '',
    address2: item.address2 ?? '',
    tel: item.tel ?? '',
    mobile: item.mobile ?? '',
    birthDate: item.birthDate ?? '',
    genderCode: item.genderCode ?? '',
  };
}

function computeNextRepresentativeCode(items: RepresentativeDto[]): number {
  let maxCode = 0;
  for (const item of items) {
    if (item.representativeCode > maxCode) {
      maxCode = item.representativeCode;
    }
  }
  return maxCode + 1;
}

export default function RepresentativesClient({ initialItems, genders }: RepresentativesClientProps) {
  const [items, setItems] = useState<RepresentativeDto[]>(initialItems);
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyFormState(computeNextRepresentativeCode(initialItems)));

  const genderMap = new Map(genders.map((g) => [g.code, g.name]));

  async function reloadList(searchKeyword: string) {
    setLoading(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (searchKeyword.trim() !== '') {
      params.set('q', searchKeyword.trim());
    }
    const queryStr = params.toString();
    const url = queryStr !== '' ? `/api/v1/masters/representatives?${queryStr}` : '/api/v1/masters/representatives';
    const result = await requestMasterApi<{ items: RepresentativeDto[] }>(url);
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
    setForm(emptyFormState(computeNextRepresentativeCode(items)));
    setModalOpen(true);
  }

  function openEditModal(item: RepresentativeDto) {
    setEditingId(item.id);
    setModalError(null);
    setForm(formFromDto(item));
    setModalOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    setBannerSuccess(null);

    const parsedCode = Number(form.representativeCode.trim());
    if (!Number.isInteger(parsedCode) || parsedCode < 1) {
      setModalError('代表者コードは1以上の整数で入力してください。');
      return;
    }
    if (form.representativeName.trim() === '') {
      setModalError('代表者名は必須です。');
      return;
    }

    const payload: RepresentativeInput = {
      representativeCode: parsedCode,
      representativeName: form.representativeName.trim(),
      furigana: normalizeNullableText(form.furigana),
      postalCode: normalizeNullableText(form.postalCode),
      address1: normalizeNullableText(form.address1),
      address2: normalizeNullableText(form.address2),
      tel: normalizeNullableText(form.tel),
      mobile: normalizeNullableText(form.mobile),
      birthDate: normalizeNullableText(form.birthDate),
      genderCode: normalizeNullableText(form.genderCode),
    };

    setSaving(true);
    const url =
      editingId === null
        ? '/api/v1/masters/representatives'
        : `/api/v1/masters/representatives/${encodeURIComponent(editingId)}`;
    const method = editingId === null ? 'POST' : 'PUT';

    const result = await requestMasterApi<{ item: RepresentativeDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);

    if (!result.ok) {
      setModalError(result.error);
      return;
    }

    setModalOpen(false);
    setBannerSuccess(
      editingId === null
        ? `代表者「${result.data.item.representativeName}」を登録しました。`
        : `代表者「${result.data.item.representativeName}」を更新しました。`,
    );
    await reloadList(keyword);
  }

  async function handleDelete(item: RepresentativeDto) {
    setBannerError(null);
    setBannerSuccess(null);
    if (!window.confirm(`代表者「${item.representativeName}（コード: ${item.representativeCode}）」を削除しますか？`)) {
      return;
    }

    const result = await requestMasterApi<{ ok: true }>(
      `/api/v1/masters/representatives/${encodeURIComponent(item.id)}`,
      { method: 'DELETE' },
    );
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setBannerSuccess(`代表者「${item.representativeName}」を削除しました。`);
    await reloadList(keyword);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">代表者マスタ</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            取引先代表者の登録・編集・参照状況確認を行います（マイナンバー項目はWeb版で完全廃止済み）。
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          ＋ 新規代表者登録
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
          void reloadList(keyword);
        }}
        className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3"
      >
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="コード・代表者名・フリガナ・電話番号で検索"
          className="flex-1 min-w-[240px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-slate-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
        >
          {loading ? '検索中...' : '検索'}
        </button>
        {keyword !== '' && (
          <button
            type="button"
            onClick={() => {
              setKeyword('');
              void reloadList('');
            }}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
          >
            クリア
          </button>
        )}
      </form>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
            <tr>
              <th className="px-4 py-2.5">コード</th>
              <th className="px-4 py-2.5">代表者名 / フリガナ</th>
              <th className="px-4 py-2.5">電話 / 携帯</th>
              <th className="px-4 py-2.5">住所</th>
              <th className="px-4 py-2.5">性別 / 生年月日</th>
              <th className="px-4 py-2.5 text-right">紐付取引先</th>
              <th className="px-4 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">
                  該当する代表者データがありません。
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5 font-mono text-slate-700">{item.representativeCode}</td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-900">{item.representativeName}</div>
                    {item.furigana !== null && (
                      <div className="text-xs text-slate-500">{item.furigana}</div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-700">
                    <div>{item.tel ?? '-'}</div>
                    {item.mobile !== null && <div className="text-slate-500">携帯: {item.mobile}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600 max-w-xs">
                    {item.postalCode !== null && <span className="mr-1">〒{item.postalCode}</span>}
                    {item.address1 ?? '-'} {item.address2 ?? ''}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    <div>{item.genderCode !== null ? (genderMap.get(item.genderCode) ?? item.genderCode) : '-'}</div>
                    <div className="text-slate-400">{item.birthDate ?? '-'}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <span className="inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                      {item.linkedPartnerCount}件
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap space-x-2">
                    <button
                      type="button"
                      onClick={() => openEditModal(item)}
                      className="rounded border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      編集
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(item)}
                      className="rounded border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl border border-slate-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <h2 className="text-base font-bold text-slate-900">
                {editingId === null ? '新規代表者登録' : '代表者情報の編集'}
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
                    代表者コード <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={form.representativeCode}
                    onChange={(e) => setForm({ ...form, representativeCode: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    代表者名 <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={form.representativeName}
                    onChange={(e) => setForm({ ...form, representativeName: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">フリガナ</label>
                  <input
                    type="text"
                    value={form.furigana}
                    onChange={(e) => setForm({ ...form, furigana: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">郵便番号</label>
                  <input
                    type="text"
                    value={form.postalCode}
                    onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
                    placeholder="123-4567"
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">住所1</label>
                  <input
                    type="text"
                    value={form.address1}
                    onChange={(e) => setForm({ ...form, address1: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">住所2（建物名・部屋番号等）</label>
                <input
                  type="text"
                  value={form.address2}
                  onChange={(e) => setForm({ ...form, address2: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">電話番号</label>
                  <input
                    type="text"
                    value={form.tel}
                    onChange={(e) => setForm({ ...form, tel: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">携帯電話</label>
                  <input
                    type="text"
                    value={form.mobile}
                    onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">性別</label>
                  <select
                    value={form.genderCode}
                    onChange={(e) => setForm({ ...form, genderCode: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
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
                  <label className="block text-xs font-medium text-slate-700 mb-1">生年月日</label>
                  <input
                    type="date"
                    value={form.birthDate}
                    onChange={(e) => setForm({ ...form, birthDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
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
                  {saving ? '保存中...' : '保存する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
