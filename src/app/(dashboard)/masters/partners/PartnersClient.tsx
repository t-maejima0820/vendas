'use client';

import { useMemo, useState } from 'react';
import {
  maskSecretValue,
  normalizeNullableText,
  requestMasterApi,
} from '@/lib/masters/client-api';
import type {
  BusinessPartnerDetailDto,
  BusinessPartnerInput,
  BusinessPartnerListItemDto,
  MasterLookupsDto,
  PartnerAdvisoryProfileInput,
} from '@/lib/masters/types';

interface PartnersClientProps {
  initialItems: BusinessPartnerListItemDto[];
  lookups: MasterLookupsDto;
  isAdmin: boolean;
}

type EditorTab = 'basic' | 'billing' | 'bank' | 'advisory';

interface AdvisoryFormState {
  corporateNo: string;
  establishedAtText: string;
  businessDescription: string;
  capitalText: string;
  fiscalClosingMonth: string;
  advisoryFee: string;
  settlementFee: string;
  payrollClosingCode: string;
  payrollPayCode: string;
  laborInsuranceCode: string;
  socialInsuranceCode: string;
  laborInsuranceNo: string;
  employmentInsOfficeNo: string;
  pensionOfficeNo: string;
  pensionSerialNo: string;
  taxOfficeId: string;
  taxOfficeSerialNo: string;
  incomeTaxCode: string;
  consumptionTaxCode: string;
  residentTaxCode: string;
  taxTransferInfo: string;
  laborBankAccount: string;
  socialBankAccount: string;
}

interface PartnerFormState {
  partnerCode: string;
  categoryCode: string;
  stateCode: string;
  partnerName: string;
  furigana: string;
  representativeId: string;
  isIndividualHonorific: boolean;
  postalCode: string;
  address1: string;
  address2: string;
  tel: string;
  isClient: boolean;
  isSupplier: boolean;
  isAplusEnabled: boolean;
  sendMailEnabled: boolean;
  email: string;
  estimateMailTo: string;
  estimateMailCc: string;
  billMailTo: string;
  billMailCc: string;
  invoiceNo: string;
  billingDestinationName: string;
  closingDayCode: string;
  collectionDayCode: string;
  receiptMethodCode: string;
  paymentMethodCode: string;
  assignedEmployeeId: string;
  openingArBalance: string;
  openingApBalance: string;
  bankCode: string;
  branchCode: string;
  bankAccountType: string;
  bankAccountNo: string;
  bankAccountHolder: string;
  isDeleted: boolean;
  advisory: AdvisoryFormState;
}

function emptyAdvisoryForm(): AdvisoryFormState {
  return {
    corporateNo: '',
    establishedAtText: '',
    businessDescription: '',
    capitalText: '',
    fiscalClosingMonth: '',
    advisoryFee: '0',
    settlementFee: '0',
    payrollClosingCode: '',
    payrollPayCode: '',
    laborInsuranceCode: '',
    socialInsuranceCode: '',
    laborInsuranceNo: '',
    employmentInsOfficeNo: '',
    pensionOfficeNo: '',
    pensionSerialNo: '',
    taxOfficeId: '',
    taxOfficeSerialNo: '',
    incomeTaxCode: '',
    consumptionTaxCode: '',
    residentTaxCode: '',
    taxTransferInfo: '',
    laborBankAccount: '',
    socialBankAccount: '',
  };
}

function emptyPartnerForm(): PartnerFormState {
  return {
    partnerCode: '',
    categoryCode: '',
    stateCode: '',
    partnerName: '',
    furigana: '',
    representativeId: '',
    isIndividualHonorific: false,
    postalCode: '',
    address1: '',
    address2: '',
    tel: '',
    isClient: true,
    isSupplier: false,
    isAplusEnabled: false,
    sendMailEnabled: false,
    email: '',
    estimateMailTo: '',
    estimateMailCc: '',
    billMailTo: '',
    billMailCc: '',
    invoiceNo: '',
    billingDestinationName: '',
    closingDayCode: '',
    collectionDayCode: '',
    receiptMethodCode: '',
    paymentMethodCode: '',
    assignedEmployeeId: '',
    openingArBalance: '0',
    openingApBalance: '0',
    bankCode: '',
    branchCode: '',
    bankAccountType: '',
    bankAccountNo: '',
    bankAccountHolder: '',
    isDeleted: false,
    advisory: emptyAdvisoryForm(),
  };
}

function formFromDetail(d: BusinessPartnerDetailDto): PartnerFormState {
  const adv = d.advisoryProfile;
  return {
    partnerCode: d.partnerCode,
    categoryCode: d.categoryCode ?? '',
    stateCode: d.stateCode ?? '',
    partnerName: d.partnerName,
    furigana: d.furigana ?? '',
    representativeId: d.representativeId ?? '',
    isIndividualHonorific: d.isIndividualHonorific,
    postalCode: d.postalCode ?? '',
    address1: d.address1 ?? '',
    address2: d.address2 ?? '',
    tel: d.tel ?? '',
    isClient: d.isClient,
    isSupplier: d.isSupplier,
    isAplusEnabled: d.isAplusEnabled,
    sendMailEnabled: d.sendMailEnabled,
    email: d.email ?? '',
    estimateMailTo: d.estimateMailTo ?? '',
    estimateMailCc: d.estimateMailCc ?? '',
    billMailTo: d.billMailTo ?? '',
    billMailCc: d.billMailCc ?? '',
    invoiceNo: d.invoiceNo ?? '',
    billingDestinationName: d.billingDestinationName ?? '',
    closingDayCode: d.closingDayCode ?? '',
    collectionDayCode: d.collectionDayCode ?? '',
    receiptMethodCode: d.receiptMethodCode ?? '',
    paymentMethodCode: d.paymentMethodCode ?? '',
    assignedEmployeeId: d.assignedEmployeeId ?? '',
    openingArBalance: String(d.openingArBalance),
    openingApBalance: String(d.openingApBalance),
    bankCode: d.bankCode ?? '',
    branchCode: d.branchCode ?? '',
    bankAccountType: d.bankAccountType ?? '',
    bankAccountNo: d.bankAccountNo ?? '',
    bankAccountHolder: d.bankAccountHolder ?? '',
    isDeleted: d.isDeleted,
    advisory:
      adv === null
        ? emptyAdvisoryForm()
        : {
            corporateNo: adv.corporateNo ?? '',
            establishedAtText: adv.establishedAtText ?? '',
            businessDescription: adv.businessDescription ?? '',
            capitalText: adv.capitalText ?? '',
            fiscalClosingMonth: adv.fiscalClosingMonth !== null ? String(adv.fiscalClosingMonth) : '',
            advisoryFee: String(adv.advisoryFee),
            settlementFee: String(adv.settlementFee),
            payrollClosingCode: adv.payrollClosingCode ?? '',
            payrollPayCode: adv.payrollPayCode ?? '',
            laborInsuranceCode: adv.laborInsuranceCode ?? '',
            socialInsuranceCode: adv.socialInsuranceCode ?? '',
            laborInsuranceNo: adv.laborInsuranceNo ?? '',
            employmentInsOfficeNo: adv.employmentInsOfficeNo ?? '',
            pensionOfficeNo: adv.pensionOfficeNo ?? '',
            pensionSerialNo: adv.pensionSerialNo ?? '',
            taxOfficeId: adv.taxOfficeId ?? '',
            taxOfficeSerialNo: adv.taxOfficeSerialNo ?? '',
            incomeTaxCode: adv.incomeTaxCode ?? '',
            consumptionTaxCode: adv.consumptionTaxCode ?? '',
            residentTaxCode: adv.residentTaxCode ?? '',
            taxTransferInfo: adv.taxTransferInfo ?? '',
            laborBankAccount: adv.laborBankAccount ?? '',
            socialBankAccount: adv.socialBankAccount ?? '',
          },
  };
}

function formatYen(value: number): string {
  return `¥${value.toLocaleString('ja-JP')}`;
}

export default function PartnersClient({ initialItems, lookups, isAdmin }: PartnersClientProps) {
  const [items, setItems] = useState<BusinessPartnerListItemDto[]>(initialItems);
  const [keyword, setKeyword] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | 'CLIENT' | 'SUPPLIER' | 'APLUS'>('ALL');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<EditorTab>('basic');
  const [modalError, setModalError] = useState<string | null>(null);
  const [form, setForm] = useState<PartnerFormState>(() => emptyPartnerForm());

  const [revealBankAccountNo, setRevealBankAccountNo] = useState(false);
  const [revealTaxTransfer, setRevealTaxTransfer] = useState(false);
  const [revealLaborBank, setRevealLaborBank] = useState(false);
  const [revealSocialBank, setRevealSocialBank] = useState(false);

  const categoryNameMap = useMemo(
    () => new Map(lookups.categories.map((c) => [c.code, c.name])),
    [lookups.categories],
  );
  const stateNameMap = useMemo(
    () => new Map(lookups.partnerStates.map((s) => [s.code, s.name])),
    [lookups.partnerStates],
  );

  const filteredBranches = useMemo(() => {
    if (form.bankCode === '') {
      return [];
    }
    return lookups.bankBranches.filter((b) => b.bankCode === form.bankCode);
  }, [lookups.bankBranches, form.bankCode]);

  async function reloadList(overrides?: {
    q?: string;
    role?: 'ALL' | 'CLIENT' | 'SUPPLIER' | 'APLUS';
    categoryCode?: string;
    stateCode?: string;
    includeDeleted?: boolean;
  }) {
    const q = overrides?.q ?? keyword;
    const role = overrides?.role ?? roleFilter;
    const categoryCode = overrides?.categoryCode ?? categoryFilter;
    const stateCode = overrides?.stateCode ?? stateFilter;
    const withDel = overrides?.includeDeleted ?? includeDeleted;

    setLoadingList(true);
    setBannerError(null);
    const params = new URLSearchParams();
    if (q.trim() !== '') params.set('q', q.trim());
    if (role !== 'ALL') params.set('role', role);
    if (categoryCode !== '') params.set('categoryCode', categoryCode);
    if (stateCode !== '') params.set('stateCode', stateCode);
    if (withDel) params.set('includeDeleted', 'true');

    const queryStr = params.toString();
    const url = queryStr !== '' ? `/api/v1/masters/partners?${queryStr}` : '/api/v1/masters/partners';
    const result = await requestMasterApi<{ items: BusinessPartnerListItemDto[] }>(url);
    setLoadingList(false);
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setItems(result.data.items);
  }

  function openCreateModal() {
    setEditingId(null);
    setActiveTab('basic');
    setModalError(null);
    setForm(emptyPartnerForm());
    setRevealBankAccountNo(true);
    setRevealTaxTransfer(true);
    setRevealLaborBank(true);
    setRevealSocialBank(true);
    setModalOpen(true);
  }

  async function openEditModal(id: string) {
    setBannerError(null);
    setLoadingDetail(true);
    const result = await requestMasterApi<{ item: BusinessPartnerDetailDto }>(
      `/api/v1/masters/partners/${encodeURIComponent(id)}`,
    );
    setLoadingDetail(false);
    if (!result.ok) {
      setBannerError(result.error);
      return;
    }
    setEditingId(id);
    setActiveTab('basic');
    setModalError(null);
    setForm(formFromDetail(result.data.item));
    setRevealBankAccountNo(false);
    setRevealTaxTransfer(false);
    setRevealLaborBank(false);
    setRevealSocialBank(false);
    setModalOpen(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);
    setBannerSuccess(null);

    if (form.partnerCode.trim() === '' || form.partnerName.trim() === '') {
      setModalError('取引先コードと取引先名は必須です。');
      return;
    }

    const arNum = Number(form.openingArBalance.trim() === '' ? '0' : form.openingArBalance.trim());
    const apNum = Number(form.openingApBalance.trim() === '' ? '0' : form.openingApBalance.trim());
    const advFee = Number(form.advisory.advisoryFee.trim() === '' ? '0' : form.advisory.advisoryFee.trim());
    const setFee = Number(form.advisory.settlementFee.trim() === '' ? '0' : form.advisory.settlementFee.trim());
    const closingMonth =
      form.advisory.fiscalClosingMonth.trim() === ''
        ? null
        : Number(form.advisory.fiscalClosingMonth.trim());

    if (!Number.isInteger(arNum) || !Number.isInteger(apNum) || !Number.isInteger(advFee) || !Number.isInteger(setFee)) {
      setModalError('金額項目（期首残高・顧問料・決算料）は整数で入力してください。');
      return;
    }

    const advisoryPayload: PartnerAdvisoryProfileInput = {
      corporateNo: normalizeNullableText(form.advisory.corporateNo),
      establishedAtText: normalizeNullableText(form.advisory.establishedAtText),
      businessDescription: normalizeNullableText(form.advisory.businessDescription),
      capitalText: normalizeNullableText(form.advisory.capitalText),
      fiscalClosingMonth: closingMonth,
      advisoryFee: advFee,
      settlementFee: setFee,
      payrollClosingCode: normalizeNullableText(form.advisory.payrollClosingCode),
      payrollPayCode: normalizeNullableText(form.advisory.payrollPayCode),
      laborInsuranceCode: normalizeNullableText(form.advisory.laborInsuranceCode),
      socialInsuranceCode: normalizeNullableText(form.advisory.socialInsuranceCode),
      laborInsuranceNo: normalizeNullableText(form.advisory.laborInsuranceNo),
      employmentInsOfficeNo: normalizeNullableText(form.advisory.employmentInsOfficeNo),
      pensionOfficeNo: normalizeNullableText(form.advisory.pensionOfficeNo),
      pensionSerialNo: normalizeNullableText(form.advisory.pensionSerialNo),
      taxOfficeId: normalizeNullableText(form.advisory.taxOfficeId),
      taxOfficeSerialNo: normalizeNullableText(form.advisory.taxOfficeSerialNo),
      incomeTaxCode: normalizeNullableText(form.advisory.incomeTaxCode),
      consumptionTaxCode: normalizeNullableText(form.advisory.consumptionTaxCode),
      residentTaxCode: normalizeNullableText(form.advisory.residentTaxCode),
      taxTransferInfo: normalizeNullableText(form.advisory.taxTransferInfo),
      laborBankAccount: normalizeNullableText(form.advisory.laborBankAccount),
      socialBankAccount: normalizeNullableText(form.advisory.socialBankAccount),
    };

    const rawAcctType = normalizeNullableText(form.bankAccountType);
    const bankAccountType = rawAcctType === 'B1' || rawAcctType === 'B2' ? rawAcctType : null;

    const payload: BusinessPartnerInput = {
      partnerCode: form.partnerCode.trim(),
      categoryCode: normalizeNullableText(form.categoryCode),
      stateCode: normalizeNullableText(form.stateCode),
      partnerName: form.partnerName.trim(),
      furigana: normalizeNullableText(form.furigana),
      representativeId: normalizeNullableText(form.representativeId),
      isIndividualHonorific: form.isIndividualHonorific,
      postalCode: normalizeNullableText(form.postalCode),
      address1: normalizeNullableText(form.address1),
      address2: normalizeNullableText(form.address2),
      tel: normalizeNullableText(form.tel),
      isClient: form.isClient,
      isSupplier: form.isSupplier,
      isAplusEnabled: form.isAplusEnabled,
      sendMailEnabled: form.sendMailEnabled,
      email: normalizeNullableText(form.email),
      estimateMailTo: normalizeNullableText(form.estimateMailTo),
      estimateMailCc: normalizeNullableText(form.estimateMailCc),
      billMailTo: normalizeNullableText(form.billMailTo),
      billMailCc: normalizeNullableText(form.billMailCc),
      invoiceNo: normalizeNullableText(form.invoiceNo),
      billingDestinationName: normalizeNullableText(form.billingDestinationName),
      closingDayCode: normalizeNullableText(form.closingDayCode),
      collectionDayCode: normalizeNullableText(form.collectionDayCode),
      receiptMethodCode: normalizeNullableText(form.receiptMethodCode),
      paymentMethodCode: normalizeNullableText(form.paymentMethodCode),
      assignedEmployeeId: normalizeNullableText(form.assignedEmployeeId),
      ...(isAdmin ? { openingArBalance: arNum, openingApBalance: apNum } : {}),
      bankCode: normalizeNullableText(form.bankCode),
      branchCode: normalizeNullableText(form.branchCode),
      bankAccountType,
      bankAccountNo: normalizeNullableText(form.bankAccountNo),
      bankAccountHolder: normalizeNullableText(form.bankAccountHolder),
      isDeleted: form.isDeleted,
      advisoryProfile: advisoryPayload,
    };

    setSaving(true);
    const url =
      editingId === null
        ? '/api/v1/masters/partners'
        : `/api/v1/masters/partners/${encodeURIComponent(editingId)}`;
    const method = editingId === null ? 'POST' : 'PUT';

    const result = await requestMasterApi<{ item: BusinessPartnerDetailDto }>(url, {
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
        ? `取引先「${result.data.item.partnerName}」を登録しました。`
        : `取引先「${result.data.item.partnerName}」を更新しました。`,
    );
    await reloadList();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">取引先マスタ（顧客・仕入先・顧問プロファイル）</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            口座番号・顧問口座等の機微情報は AES-256-GCM で暗号化保存され、通常表示時はマスクされます。
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateModal}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          ＋ 新規取引先登録
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
          placeholder="コード・取引先名・フリガナ・電話番号"
          className="flex-1 min-w-[200px] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as 'ALL' | 'CLIENT' | 'SUPPLIER' | 'APLUS')}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
        >
          <option value="ALL">区分: すべて</option>
          <option value="CLIENT">顧客のみ</option>
          <option value="SUPPLIER">仕入先のみ</option>
          <option value="APLUS">アプラス対象のみ</option>
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
        >
          <option value="">分類: すべて</option>
          {lookups.categories.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code}: {c.name}
            </option>
          ))}
        </select>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
        >
          <option value="">状態: すべて</option>
          {lookups.partnerStates.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code}: {s.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-600 px-1">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          削除済含む
        </label>
        <button
          type="submit"
          disabled={loadingList}
          className="rounded-lg bg-slate-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
        >
          {loadingList ? '検索中...' : '検索'}
        </button>
      </form>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600">
            <tr>
              <th className="px-3 py-2.5">コード</th>
              <th className="px-3 py-2.5">取引先名 / フリガナ</th>
              <th className="px-3 py-2.5">役割</th>
              <th className="px-3 py-2.5">分類・状態</th>
              <th className="px-3 py-2.5">代表者 / 担当</th>
              <th className="px-3 py-2.5 text-right">期首売掛 / 買掛</th>
              <th className="px-3 py-2.5 text-right">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">
                  該当する取引先がありません。
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className={`hover:bg-slate-50 ${item.isDeleted ? 'opacity-60 bg-slate-50' : ''}`}>
                  <td className="px-3 py-2.5 font-mono text-xs text-slate-700">
                    {item.partnerCode}
                    {item.isDeleted && (
                      <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">
                        削除
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-slate-900">{item.partnerName}</div>
                    <div className="text-xs text-slate-500">
                      {item.furigana ?? ''} {item.tel !== null ? `・ ${item.tel}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 space-x-1 whitespace-nowrap">
                    {item.isClient && (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">
                        顧客
                      </span>
                    )}
                    {item.isSupplier && (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                        仕入
                      </span>
                    )}
                    {item.isAplusEnabled && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                        アプラス
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">
                    <div>{item.categoryCode !== null ? (categoryNameMap.get(item.categoryCode) ?? item.categoryCode) : '-'}</div>
                    <div className="text-slate-400">
                      {item.stateCode !== null ? (stateNameMap.get(item.stateCode) ?? item.stateCode) : '-'}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">
                    <div>代表: {item.representativeName ?? '-'}</div>
                    <div className="text-slate-400">担当: {item.assignedEmployeeName ?? '-'}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs text-slate-700">
                    <div>売掛: {formatYen(item.openingArBalance)}</div>
                    <div className="text-slate-500">買掛: {formatYen(item.openingApBalance)}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <button
                      type="button"
                      disabled={loadingDetail}
                      onClick={() => void openEditModal(item.id)}
                      className="rounded border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                    >
                      詳細・編集
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
          <div className="w-full max-w-4xl rounded-xl bg-white shadow-xl border border-slate-200 max-h-[92vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 shrink-0">
              <div>
                <h2 className="text-base font-bold text-slate-900">
                  {editingId === null ? '新規取引先登録' : `取引先編集: ${form.partnerName}`}
                </h2>
                <p className="text-xs text-slate-500">
                  4つのタブ（基本・連絡先 / 請求・回収・期首残高 / 口座情報 / 顧問・労務・税務）をACID保存します。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-800"
              >
                ✕ 閉じる
              </button>
            </div>

            <div className="flex border-b border-slate-200 bg-slate-50 px-6 shrink-0">
              {(
                [
                  ['basic', '1. 基本・連絡先'],
                  ['billing', '2. 請求・回収・期首残高'],
                  ['bank', '3. 口座情報'],
                  ['advisory', '4. 顧問・労務・税務'],
                ] as const
              ).map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => setActiveTab(tabKey)}
                  className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                    activeTab === tabKey
                      ? 'border-blue-600 text-blue-700 bg-white'
                      : 'border-transparent text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <form onSubmit={(e) => void handleSave(e)} className="flex-1 overflow-y-auto p-6 space-y-5">
              {modalError !== null && (
                <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {modalError}
                </div>
              )}

              {activeTab === 'basic' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        取引先コード <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        value={form.partnerCode}
                        onChange={(e) => setForm({ ...form, partnerCode: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        取引先名 <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        value={form.partnerName}
                        onChange={(e) => setForm({ ...form, partnerName: e.target.value })}
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

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">取引分類</label>
                      <select
                        value={form.categoryCode}
                        onChange={(e) => setForm({ ...form, categoryCode: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.categories.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.code}: {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">取引先状態</label>
                      <select
                        value={form.stateCode}
                        onChange={(e) => setForm({ ...form, stateCode: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.partnerStates.map((s) => (
                          <option key={s.code} value={s.code}>
                            {s.code}: {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">代表者</label>
                      <select
                        value={form.representativeId}
                        onChange={(e) => setForm({ ...form, representativeId: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.representatives.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.representativeCode}: {r.representativeName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">担当社員</label>
                      <select
                        value={form.assignedEmployeeId}
                        onChange={(e) => setForm({ ...form, assignedEmployeeId: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.syainCode}: {emp.syainName}
                            {emp.isRetired ? '（退職）' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-6 rounded-lg bg-slate-50 border border-slate-200 px-4 py-3 text-xs">
                    <label className="flex items-center gap-2 font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={form.isClient}
                        onChange={(e) => setForm({ ...form, isClient: e.target.checked })}
                      />
                      顧客対象
                    </label>
                    <label className="flex items-center gap-2 font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={form.isSupplier}
                        onChange={(e) => setForm({ ...form, isSupplier: e.target.checked })}
                      />
                      仕入先対象
                    </label>
                    <label className="flex items-center gap-2 font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={form.isAplusEnabled}
                        onChange={(e) => setForm({ ...form, isAplusEnabled: e.target.checked })}
                      />
                      アプラス口座振替対象
                    </label>
                    <label className="flex items-center gap-2 font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={form.isIndividualHonorific}
                        onChange={(e) => setForm({ ...form, isIndividualHonorific: e.target.checked })}
                      />
                      個人敬称（様）
                    </label>
                    <label className="flex items-center gap-2 font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={form.sendMailEnabled}
                        onChange={(e) => setForm({ ...form, sendMailEnabled: e.target.checked })}
                      />
                      帳票メール送信有効
                    </label>
                    <label className="flex items-center gap-2 font-medium text-red-700">
                      <input
                        type="checkbox"
                        checked={form.isDeleted}
                        onChange={(e) => setForm({ ...form, isDeleted: e.target.checked })}
                      />
                      削除（無効化）フラグ
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">郵便番号</label>
                      <input
                        type="text"
                        value={form.postalCode}
                        onChange={(e) => setForm({ ...form, postalCode: e.target.value })}
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
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">電話番号</label>
                      <input
                        type="text"
                        value={form.tel}
                        onChange={(e) => setForm({ ...form, tel: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">住所2（建物・部署等）</label>
                    <input
                      type="text"
                      value={form.address2}
                      onChange={(e) => setForm({ ...form, address2: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">代表メールアドレス</label>
                      <input
                        type="text"
                        value={form.email}
                        onChange={(e) => setForm({ ...form, email: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">見積送付先 To / CC</label>
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          placeholder="見積 To"
                          value={form.estimateMailTo}
                          onChange={(e) => setForm({ ...form, estimateMailTo: e.target.value })}
                          className="w-full rounded-lg border border-slate-300 px-3 py-1 text-xs"
                        />
                        <input
                          type="text"
                          placeholder="見積 CC"
                          value={form.estimateMailCc}
                          onChange={(e) => setForm({ ...form, estimateMailCc: e.target.value })}
                          className="w-full rounded-lg border border-slate-300 px-3 py-1 text-xs"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">請求送付先 To / CC</label>
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          placeholder="請求 To"
                          value={form.billMailTo}
                          onChange={(e) => setForm({ ...form, billMailTo: e.target.value })}
                          className="w-full rounded-lg border border-slate-300 px-3 py-1 text-xs"
                        />
                        <input
                          type="text"
                          placeholder="請求 CC"
                          value={form.billMailCc}
                          onChange={(e) => setForm({ ...form, billMailCc: e.target.value })}
                          className="w-full rounded-lg border border-slate-300 px-3 py-1 text-xs"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'billing' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        請求書宛名（空欄時は取引先名を使用）
                      </label>
                      <input
                        type="text"
                        value={form.billingDestinationName}
                        onChange={(e) => setForm({ ...form, billingDestinationName: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        インボイス登録番号（適格請求書発行事業者）
                      </label>
                      <input
                        type="text"
                        value={form.invoiceNo}
                        onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })}
                        placeholder="T1234567890123"
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">締日区分</label>
                      <select
                        value={form.closingDayCode}
                        onChange={(e) => setForm({ ...form, closingDayCode: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.billClosingDays.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">回収サイト区分</label>
                      <select
                        value={form.collectionDayCode}
                        onChange={(e) => setForm({ ...form, collectionDayCode: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.collectionDays.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">入金方法</label>
                      <select
                        value={form.receiptMethodCode}
                        onChange={(e) => setForm({ ...form, receiptMethodCode: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.paymentMethods.map((m) => (
                          <option key={m.id} value={m.methodCode}>
                            {m.methodCode}: {m.methodName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">支払方法</label>
                      <select
                        value={form.paymentMethodCode}
                        onChange={(e) => setForm({ ...form, paymentMethodCode: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.paymentMethods.map((m) => (
                          <option key={m.id} value={m.methodCode}>
                            {m.methodCode}: {m.methodName}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-bold text-amber-900">
                          カットオーバー期首残高（売掛・買掛）
                        </h3>
                        <p className="text-[11px] text-amber-800">
                          適用開始基準日（tenant_settings.opening_balance_date）:{' '}
                          <span className="font-mono font-semibold">
                            {lookups.openingBalanceDate ?? '未設定'}
                          </span>
                        </p>
                      </div>
                      {!isAdmin && (
                        <span className="rounded bg-amber-200 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                          管理者のみ変更可（閲覧専用）
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          期首売掛残高（円）
                        </label>
                        <input
                          type="number"
                          step={1}
                          disabled={!isAdmin}
                          value={form.openingArBalance}
                          onChange={(e) => setForm({ ...form, openingArBalance: e.target.value })}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono disabled:bg-slate-100 disabled:text-slate-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-700 mb-1">
                          期首買掛残高（円）
                        </label>
                        <input
                          type="number"
                          step={1}
                          disabled={!isAdmin}
                          value={form.openingApBalance}
                          onChange={(e) => setForm({ ...form, openingApBalance: e.target.value })}
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono disabled:bg-slate-100 disabled:text-slate-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'bank' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">銀行コード・銀行名</label>
                      <select
                        value={form.bankCode}
                        onChange={(e) =>
                          setForm({ ...form, bankCode: e.target.value, branchCode: '' })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.banks.map((b) => (
                          <option key={b.id} value={b.bankCode}>
                            {b.bankCode}: {b.bankName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">支店コード・支店名</label>
                      <select
                        value={form.branchCode}
                        disabled={form.bankCode === ''}
                        onChange={(e) => setForm({ ...form, branchCode: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm disabled:bg-slate-100"
                      >
                        <option value="">（未選択）</option>
                        {filteredBranches.map((br) => (
                          <option key={br.id} value={br.branchCode}>
                            {br.branchCode}: {br.branchName}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">口座種別</label>
                      <select
                        value={form.bankAccountType}
                        onChange={(e) => setForm({ ...form, bankAccountType: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.bankAccountTypes.map((t) => (
                          <option key={t.code} value={t.code}>
                            {t.code}: {t.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-slate-700">
                          口座番号（AES-256-GCM 暗号化）
                        </label>
                        <button
                          type="button"
                          onClick={() => setRevealBankAccountNo(!revealBankAccountNo)}
                          className="text-[11px] font-medium text-blue-600 hover:underline"
                        >
                          {revealBankAccountNo ? 'マスクする' : '表示切替'}
                        </button>
                      </div>
                      <input
                        type={revealBankAccountNo ? 'text' : 'password'}
                        value={form.bankAccountNo}
                        onChange={(e) => setForm({ ...form, bankAccountNo: e.target.value })}
                        placeholder={maskSecretValue(form.bankAccountNo || null)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">口座名義（カナ等）</label>
                      <input
                        type="text"
                        value={form.bankAccountHolder}
                        onChange={(e) => setForm({ ...form, bankAccountHolder: e.target.value })}
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'advisory' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">法人番号</label>
                      <input
                        type="text"
                        value={form.advisory.corporateNo}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, corporateNo: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">設立年月日（テキスト）</label>
                      <input
                        type="text"
                        value={form.advisory.establishedAtText}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, establishedAtText: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">資本金（テキスト）</label>
                      <input
                        type="text"
                        value={form.advisory.capitalText}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, capitalText: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">決算月（1〜12）</label>
                      <input
                        type="number"
                        min={0}
                        max={12}
                        value={form.advisory.fiscalClosingMonth}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, fiscalClosingMonth: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">事業内容</label>
                    <input
                      type="text"
                      value={form.advisory.businessDescription}
                      onChange={(e) =>
                        setForm({ ...form, advisory: { ...form.advisory, businessDescription: e.target.value } })
                      }
                      className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">顧問料（円）</label>
                      <input
                        type="number"
                        step={1}
                        value={form.advisory.advisoryFee}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, advisoryFee: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">決算料（円）</label>
                      <input
                        type="number"
                        step={1}
                        value={form.advisory.settlementFee}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, settlementFee: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">給与締日</label>
                      <select
                        value={form.advisory.payrollClosingCode}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, payrollClosingCode: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.payrollClosingDays.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">給与支給日</label>
                      <select
                        value={form.advisory.payrollPayCode}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, payrollPayCode: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.payrollPayDays.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">労働保険区分</label>
                      <select
                        value={form.advisory.laborInsuranceCode}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, laborInsuranceCode: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.laborInsuranceStates.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">労働保険番号</label>
                      <input
                        type="text"
                        value={form.advisory.laborInsuranceNo}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, laborInsuranceNo: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">雇用保険事業所番号</label>
                      <input
                        type="text"
                        value={form.advisory.employmentInsOfficeNo}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            advisory: { ...form.advisory, employmentInsOfficeNo: e.target.value },
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">社会保険区分</label>
                      <select
                        value={form.advisory.socialInsuranceCode}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, socialInsuranceCode: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.socialInsuranceStates.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">年金事務所番号</label>
                      <input
                        type="text"
                        value={form.advisory.pensionOfficeNo}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, pensionOfficeNo: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">年金整理番号</label>
                      <input
                        type="text"
                        value={form.advisory.pensionSerialNo}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, pensionSerialNo: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">所轄税務署</label>
                      <select
                        value={form.advisory.taxOfficeId}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, taxOfficeId: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.taxOffices.map((to) => (
                          <option key={to.id} value={to.id}>
                            {to.taxOfficeCode}: {to.taxOfficeName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">税務整理番号</label>
                      <input
                        type="text"
                        value={form.advisory.taxOfficeSerialNo}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, taxOfficeSerialNo: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">所得税区分</label>
                      <select
                        value={form.advisory.incomeTaxCode}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, incomeTaxCode: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.incomeTaxTypes.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">消費税区分</label>
                      <select
                        value={form.advisory.consumptionTaxCode}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, consumptionTaxCode: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.consumptionTaxTypes.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">住民税区分</label>
                      <select
                        value={form.advisory.residentTaxCode}
                        onChange={(e) =>
                          setForm({ ...form, advisory: { ...form.advisory, residentTaxCode: e.target.value } })
                        }
                        className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                      >
                        <option value="">（未選択）</option>
                        {lookups.residentTaxTypes.map((d) => (
                          <option key={d.code} value={d.code}>
                            {d.code}: {d.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                    <h3 className="text-xs font-bold text-slate-700">
                      顧問・振替口座機微情報（AES-256-GCM 暗号化保存・デフォルトマスク表示）
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-xs font-medium text-slate-700">ダイレクト納付・振替情報</label>
                          <button
                            type="button"
                            onClick={() => setRevealTaxTransfer(!revealTaxTransfer)}
                            className="text-[11px] font-medium text-blue-600 hover:underline"
                          >
                            {revealTaxTransfer ? 'マスクする' : '表示切替'}
                          </button>
                        </div>
                        <input
                          type={revealTaxTransfer ? 'text' : 'password'}
                          value={form.advisory.taxTransferInfo}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              advisory: { ...form.advisory, taxTransferInfo: e.target.value },
                            })
                          }
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-xs font-medium text-slate-700">労働保険振替口座</label>
                          <button
                            type="button"
                            onClick={() => setRevealLaborBank(!revealLaborBank)}
                            className="text-[11px] font-medium text-blue-600 hover:underline"
                          >
                            {revealLaborBank ? 'マスクする' : '表示切替'}
                          </button>
                        </div>
                        <input
                          type={revealLaborBank ? 'text' : 'password'}
                          value={form.advisory.laborBankAccount}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              advisory: { ...form.advisory, laborBankAccount: e.target.value },
                            })
                          }
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono"
                        />
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-xs font-medium text-slate-700">社会保険振替口座</label>
                          <button
                            type="button"
                            onClick={() => setRevealSocialBank(!revealSocialBank)}
                            className="text-[11px] font-medium text-blue-600 hover:underline"
                          >
                            {revealSocialBank ? 'マスクする' : '表示切替'}
                          </button>
                        </div>
                        <input
                          type={revealSocialBank ? 'text' : 'password'}
                          value={form.advisory.socialBankAccount}
                          onChange={(e) =>
                            setForm({
                              ...form,
                              advisory: { ...form.advisory, socialBankAccount: e.target.value },
                            })
                          }
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-mono"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

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
                  {saving ? '保存中...' : '取引先を保存する'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
