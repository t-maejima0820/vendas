'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { TenantSettingsDto } from '@/lib/settings/settings-service';

type SettingsTab = 'company' | 'bank' | 'policy' | 'features';

function maskAccountNo(val: string | null): string {
  if (val === null || val === '') return '';
  if (val.length <= 3) return '*'.repeat(val.length);
  return '*'.repeat(val.length - 3) + val.slice(-3);
}

export default function SettingsClient({ initialData }: { initialData: TenantSettingsDto }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<SettingsTab>('company');
  const [form, setForm] = useState<TenantSettingsDto>(initialData);
  const [showBankNo1, setShowBankNo1] = useState(false);
  const [showBankNo2, setShowBankNo2] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const invoiceTrimmed = (form.invoiceRegistrationNo === null ? '' : form.invoiceRegistrationNo).trim();
  const invoiceValid = invoiceTrimmed === '' || /^T[0-9]{13}$/.test(invoiceTrimmed);
  const corpTrimmed = (form.corporateNo === null ? '' : form.corporateNo).trim();
  const corpValid = corpTrimmed === '' || /^[0-9]{13}$/.test(corpTrimmed);

  function setNullableField(key: keyof TenantSettingsDto, value: string) {
    setForm((prev) => ({ ...prev, [key]: value === '' ? null : value }));
  }

  function toggleFeature(featureCode: string, nextVal: boolean) {
    setForm((prev) => ({
      ...prev,
      features: prev.features.map((f) => {
        if (f.featureCode !== featureCode) return f;
        if (f.isFixed) return f;
        return { ...f, isEnabled: nextVal };
      }),
    }));
  }

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!invoiceValid) {
      setErrorMsg('インボイス登録番号は T + 13桁の半角数字で入力してください。');
      setActiveTab('company');
      return;
    }
    if (!corpValid) {
      setErrorMsg('法人番号は 13桁の半角数字で入力してください。');
      setActiveTab('company');
      return;
    }

    setSaving(true);
    const submitSettings = async (): Promise<
      { ok: true; data: TenantSettingsDto } | { ok: false; error: string }
    > => {
      try {
        const payload = {
          companyName: form.companyName,
          invoiceRegistrationNo: form.invoiceRegistrationNo,
          corporateNo: form.corporateNo,
          postalCode: form.postalCode,
          address1: form.address1,
          address2: form.address2,
          tel: form.tel,
          fax: form.fax,
          email: form.email,
          representativeTitle: form.representativeTitle,
          representativeName: form.representativeName,
          fiscalClosingMonth: form.fiscalClosingMonth,
          billingMemo: form.billingMemo,
          bankCode1: form.bankCode1,
          branchCode1: form.branchCode1,
          bankAccountType1: form.bankAccountType1,
          bankAccountNo1: form.bankAccountNo1,
          bankAccountHolder1: form.bankAccountHolder1,
          bankCode2: form.bankCode2,
          branchCode2: form.branchCode2,
          bankAccountType2: form.bankAccountType2,
          bankAccountNo2: form.bankAccountNo2,
          bankAccountHolder2: form.bankAccountHolder2,
          approvalFlowEnabled: form.approvalFlowEnabled,
          allowBillingDateWarningSkip: form.allowBillingDateWarningSkip,
          defaultApprovalBillingDate: form.defaultApprovalBillingDate,
          defaultArListDateMode: form.defaultArListDateMode,
          quotationTemplateRows: form.quotationTemplateRows,
          showInvoiceCarryover: form.showInvoiceCarryover,
          costTaxMode: form.costTaxMode,
          taxCalcPolicy: form.taxCalcPolicy,
          defaultRoundingMode: form.defaultRoundingMode,
          features: form.features.map((f) => ({
            featureCode: f.featureCode,
            isEnabled: f.isEnabled,
          })),
        };

        const res = await fetch('/api/v1/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          data?: TenantSettingsDto;
        };
        if (!res.ok || json.ok !== true || json.data === undefined) {
          return {
            ok: false,
            error:
              typeof json.error === 'string' && json.error !== ''
                ? json.error
                : '設定の保存に失敗しました。',
          };
        }
        return { ok: true, data: json.data };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? '通信エラーが発生しました。' : '通信エラーが発生しました。',
        };
      }
    };

    const result = await submitSettings();
    setSaving(false);
    if (!result.ok) {
      setErrorMsg(result.error);
      return;
    }

    setForm(result.data);
    setSuccessMsg('システム設定および機能権限を保存しました。');
    router.refresh();
  }

  return (
    <form onSubmit={handleSave} className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">自社・システム・機能権限設定</h1>
          <p className="text-sm text-slate-600 mt-1">
            自社情報・振込先口座（AES-256-GCM暗号化）・インボイス税計算ポリシー・29機能の有効化を管理します。
          </p>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-slate-400 shadow-xs transition-colors cursor-pointer"
        >
          {saving ? '保存中...' : '設定を保存する'}
        </button>
      </div>

      {errorMsg !== null && (
        <div role="alert" className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
          {errorMsg}
        </div>
      )}
      {successMsg !== null && (
        <div role="status" className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
          {successMsg}
        </div>
      )}

      {/* タブバー */}
      <div className="border-b border-slate-200 flex gap-2">
        {(
          [
            { id: 'company', label: '1. 自社情報' },
            { id: 'bank', label: '2. 振込先口座' },
            { id: 'policy', label: '3. 運用・消費税ポリシー' },
            { id: 'features', label: '4. 機能権限（29機能）' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
              activeTab === tab.id
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* タブ1: 自社情報 */}
      {activeTab === 'company' && (
        <div className="rounded-xl bg-white border border-slate-200 p-6 shadow-xs space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">自社コード（固定）</label>
              <input
                type="text"
                readOnly
                value={form.companyCode}
                className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-600 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                会社名 <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                required
                value={form.companyName}
                onChange={(e) => setForm((p) => ({ ...p, companyName: e.target.value }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                適格請求書発行事業者登録番号（T + 13桁）
              </label>
              <input
                type="text"
                placeholder="T1234567890123"
                value={form.invoiceRegistrationNo === null ? '' : form.invoiceRegistrationNo}
                onChange={(e) => setNullableField('invoiceRegistrationNo', e.target.value)}
                className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none ${
                  invoiceValid ? 'border-slate-300 focus:border-blue-500' : 'border-red-400 bg-red-50'
                }`}
              />
              {!invoiceValid && (
                <p className="text-xs text-red-600 mt-1">先頭「T」に続けて半角数字13桁を入力してください。</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">法人番号（13桁）</label>
              <input
                type="text"
                placeholder="1234567890123"
                value={form.corporateNo === null ? '' : form.corporateNo}
                onChange={(e) => setNullableField('corporateNo', e.target.value)}
                className={`w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none ${
                  corpValid ? 'border-slate-300 focus:border-blue-500' : 'border-red-400 bg-red-50'
                }`}
              />
              {!corpValid && (
                <p className="text-xs text-red-600 mt-1">半角数字13桁を入力してください。</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">郵便番号</label>
              <input
                type="text"
                value={form.postalCode === null ? '' : form.postalCode}
                onChange={(e) => setNullableField('postalCode', e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">決算月（0:未設定 / 1〜12月）</label>
              <input
                type="number"
                min={0}
                max={12}
                value={form.fiscalClosingMonth}
                onChange={(e) => setForm((p) => ({ ...p, fiscalClosingMonth: Number(e.target.value) }))}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">住所1</label>
              <input
                type="text"
                value={form.address1 === null ? '' : form.address1}
                onChange={(e) => setNullableField('address1', e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">住所2（建物名等）</label>
              <input
                type="text"
                value={form.address2 === null ? '' : form.address2}
                onChange={(e) => setNullableField('address2', e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">TEL</label>
              <input
                type="text"
                value={form.tel === null ? '' : form.tel}
                onChange={(e) => setNullableField('tel', e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">FAX</label>
              <input
                type="text"
                value={form.fax === null ? '' : form.fax}
                onChange={(e) => setNullableField('fax', e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">メールアドレス</label>
              <input
                type="email"
                value={form.email === null ? '' : form.email}
                onChange={(e) => setNullableField('email', e.target.value)}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">代表者役職</label>
                <input
                  type="text"
                  value={form.representativeTitle === null ? '' : form.representativeTitle}
                  onChange={(e) => setNullableField('representativeTitle', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">代表者氏名</label>
                <input
                  type="text"
                  value={form.representativeName === null ? '' : form.representativeName}
                  onChange={(e) => setNullableField('representativeName', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">請求書フッター注記（billing_memo）</label>
            <textarea
              rows={3}
              value={form.billingMemo === null ? '' : form.billingMemo}
              onChange={(e) => setNullableField('billingMemo', e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
        </div>
      )}

      {/* タブ2: 振込先口座 */}
      {activeTab === 'bank' && (
        <div className="space-y-6">
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-xs text-blue-900">
            セキュリティ保護: 入力された口座番号はサーバー側で AES-256-GCM（`enc:v1:...`）暗号化されてDB保存されます。
          </div>

          {/* 口座1 */}
          <div className="rounded-xl bg-white border border-slate-200 p-6 shadow-xs space-y-4">
            <h2 className="text-base font-semibold text-slate-900">自社振込先口座 1</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">銀行コード（4桁）</label>
                <input
                  type="text"
                  value={form.bankCode1 === null ? '' : form.bankCode1}
                  onChange={(e) => setNullableField('bankCode1', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">支店コード（3桁）</label>
                <input
                  type="text"
                  value={form.branchCode1 === null ? '' : form.branchCode1}
                  onChange={(e) => setNullableField('branchCode1', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">預金種別</label>
                <select
                  value={form.bankAccountType1 === null ? '' : form.bankAccountType1}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      bankAccountType1:
                        e.target.value === 'B1' || e.target.value === 'B2' ? e.target.value : null,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                >
                  <option value="">未選択</option>
                  <option value="B1">普通（B1）</option>
                  <option value="B2">当座（B2）</option>
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-700">口座番号</label>
                  <button
                    type="button"
                    onClick={() => setShowBankNo1((v) => !v)}
                    className="text-xs text-blue-600 hover:underline cursor-pointer"
                  >
                    {showBankNo1 ? 'マスク表示' : '番号を表示・編集'}
                  </button>
                </div>
                {showBankNo1 ? (
                  <input
                    type="text"
                    placeholder="例: 1234567"
                    value={form.bankAccountNo1 === null ? '' : form.bankAccountNo1}
                    onChange={(e) => setNullableField('bankAccountNo1', e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                ) : (
                  <input
                    type="text"
                    readOnly
                    value={maskAccountNo(form.bankAccountNo1)}
                    placeholder="未設定"
                    className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-mono text-slate-600"
                  />
                )}
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">口座名義</label>
                <input
                  type="text"
                  value={form.bankAccountHolder1 === null ? '' : form.bankAccountHolder1}
                  onChange={(e) => setNullableField('bankAccountHolder1', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>

          {/* 口座2 */}
          <div className="rounded-xl bg-white border border-slate-200 p-6 shadow-xs space-y-4">
            <h2 className="text-base font-semibold text-slate-900">自社振込先口座 2</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">銀行コード（4桁）</label>
                <input
                  type="text"
                  value={form.bankCode2 === null ? '' : form.bankCode2}
                  onChange={(e) => setNullableField('bankCode2', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">支店コード（3桁）</label>
                <input
                  type="text"
                  value={form.branchCode2 === null ? '' : form.branchCode2}
                  onChange={(e) => setNullableField('branchCode2', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">預金種別</label>
                <select
                  value={form.bankAccountType2 === null ? '' : form.bankAccountType2}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      bankAccountType2:
                        e.target.value === 'B1' || e.target.value === 'B2' ? e.target.value : null,
                    }))
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
                >
                  <option value="">未選択</option>
                  <option value="B1">普通（B1）</option>
                  <option value="B2">当座（B2）</option>
                </select>
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-slate-700">口座番号</label>
                  <button
                    type="button"
                    onClick={() => setShowBankNo2((v) => !v)}
                    className="text-xs text-blue-600 hover:underline cursor-pointer"
                  >
                    {showBankNo2 ? 'マスク表示' : '番号を表示・編集'}
                  </button>
                </div>
                {showBankNo2 ? (
                  <input
                    type="text"
                    placeholder="例: 7654321"
                    value={form.bankAccountNo2 === null ? '' : form.bankAccountNo2}
                    onChange={(e) => setNullableField('bankAccountNo2', e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                ) : (
                  <input
                    type="text"
                    readOnly
                    value={maskAccountNo(form.bankAccountNo2)}
                    placeholder="未設定"
                    className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-mono text-slate-600"
                  />
                )}
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">口座名義</label>
                <input
                  type="text"
                  value={form.bankAccountHolder2 === null ? '' : form.bankAccountHolder2}
                  onChange={(e) => setNullableField('bankAccountHolder2', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* タブ3: 運用・消費税ポリシー */}
      {activeTab === 'policy' && (
        <div className="rounded-xl bg-white border border-slate-200 p-6 shadow-xs space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                インボイス消費税計算方式
              </label>
              <select
                value={form.taxCalcPolicy}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    taxCalcPolicy:
                      e.target.value === 'INVOICE_BY_RATE' ? 'INVOICE_BY_RATE' : 'SLIP_BY_RATE',
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="SLIP_BY_RATE">
                  SLIP_BY_RATE（伝票単位で税率ごとに1回端数処理／請求時合算・標準）
                </option>
                <option value="INVOICE_BY_RATE">
                  INVOICE_BY_RATE（月次請求締め時に税率ごとに1回端数処理／差額調整）
                </option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">既定端数処理</label>
              <select
                value={form.defaultRoundingMode}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    defaultRoundingMode:
                      e.target.value === 'ROUND' || e.target.value === 'CEIL'
                        ? e.target.value
                        : 'FLOOR',
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="FLOOR">FLOOR（切り捨て）</option>
                <option value="ROUND">ROUND（四捨五入）</option>
                <option value="CEIL">CEIL（切り上げ）</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">原価管理税表示区分</label>
              <select
                value={form.costTaxMode}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    costTaxMode:
                      e.target.value === 'TAX_INCLUDED' ? 'TAX_INCLUDED' : 'TAX_EXCLUDED',
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="TAX_EXCLUDED">TAX_EXCLUDED（税抜統一）</option>
                <option value="TAX_INCLUDED">TAX_INCLUDED（税込統一）</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">見積書明細テンプレート行数</label>
              <select
                value={String(form.quotationTemplateRows)}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    quotationTemplateRows: e.target.value === '20' ? 20 : 10,
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="10">10行テンプレート</option>
                <option value="20">20行テンプレート</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">承認デフォルト請求日</label>
              <select
                value={String(form.defaultApprovalBillingDate)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setForm((p) => ({
                    ...p,
                    defaultApprovalBillingDate: v === 1 || v === 2 ? v : 0,
                  }));
                }}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="0">0: 設定なし</option>
                <option value="1">1: 売上日</option>
                <option value="2">2: 承認日</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">売掛一覧デフォルト日付</label>
              <select
                value={String(form.defaultArListDateMode)}
                onChange={(e) =>
                  setForm((p) => ({
                    ...p,
                    defaultArListDateMode: e.target.value === '1' ? 1 : 0,
                  }))
                }
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-white"
              >
                <option value="0">0: 前月〜当月</option>
                <option value="1">1: 当月基準</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                期首残高基準日（カットオーバー日・読取専用）
              </label>
              <input
                type="text"
                readOnly
                value={form.openingBalanceDate}
                className="w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-mono text-slate-600"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-slate-100 space-y-3">
            <label className="flex items-center gap-2.5 text-sm text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={form.approvalFlowEnabled}
                onChange={(e) => setForm((p) => ({ ...p, approvalFlowEnabled: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-blue-600"
              />
              <span>売上承認フローを有効化する（承認済み売上のみ請求締め対象）</span>
            </label>

            <label className="flex items-center gap-2.5 text-sm text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={form.allowBillingDateWarningSkip}
                onChange={(e) =>
                  setForm((p) => ({ ...p, allowBillingDateWarningSkip: e.target.checked }))
                }
                className="h-4 w-4 rounded border-slate-300 text-blue-600"
              />
              <span>承認時の請求日警告スキップを許可する</span>
            </label>

            <label className="flex items-center gap-2.5 text-sm text-slate-800 cursor-pointer">
              <input
                type="checkbox"
                checked={form.showInvoiceCarryover}
                onChange={(e) => setForm((p) => ({ ...p, showInvoiceCarryover: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-300 text-blue-600"
              />
              <span>請求書鏡に前回繰越・入金額を表示する（show_invoice_carryover）</span>
            </label>
          </div>
        </div>
      )}

      {/* タブ4: 機能権限（29機能） */}
      {activeTab === 'features' && (
        <div className="rounded-xl bg-white border border-slate-200 p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">
              テナントで利用する業務機能（全 {form.features.length} 機能）を切り替えます。左メニューへ即座に反映されます。
            </p>
            <span className="text-xs text-slate-500">
              ※「固定必須」マークの機能は無効化できません
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {form.features.map((feat) => (
              <label
                key={feat.featureCode}
                className={`flex items-center justify-between rounded-lg border p-3 transition-colors ${
                  feat.isFixed
                    ? 'bg-slate-50 border-slate-200 cursor-not-allowed'
                    : feat.isEnabled
                      ? 'bg-blue-50/40 border-blue-200 cursor-pointer hover:bg-blue-50'
                      : 'bg-white border-slate-200 cursor-pointer hover:bg-slate-50'
                }`}
              >
                <div className="min-w-0 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-900 truncate">
                      {feat.featureName}
                    </span>
                    {feat.isFixed && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 text-[10px] font-semibold">
                        固定必須
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] font-mono text-slate-500">{feat.featureCode}</div>
                </div>
                <input
                  type="checkbox"
                  checked={feat.isEnabled}
                  disabled={feat.isFixed}
                  onChange={(e) => toggleFeature(feat.featureCode, e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 shrink-0"
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}
