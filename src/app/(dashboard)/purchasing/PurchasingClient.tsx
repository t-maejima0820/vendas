'use client';

import Decimal from 'decimal.js';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  calculateSalesSlip,
  type RoundingMode,
  type TaxCode,
} from '@/lib/domain/calculations';
import { computePageCount, type SnapshotHistoryItemDto } from '@/lib/estimates/types';
import { normalizeNullableText, requestMasterApi } from '@/lib/masters/client-api';
import {
  ORDER_STATUS_LABELS,
  PAYABLE_STATUS_LABELS,
  PURCHASE_STATUS_LABELS,
  type OrderStatus,
  type PurchaseDetailDto,
  type PurchaseInput,
  type PurchaseLineInput,
  type PurchaseOrderDetailDto,
  type PurchaseOrderInput,
  type PurchaseOrderLineInput,
  type PurchaseOrderPageDto,
  type PurchasePageDto,
  type PurchaseStatus,
  type PurchasingLookupsDto,
} from '@/lib/purchasing/types';

interface PurchasingClientProps {
  initialTab: 'ORDERS' | 'PURCHASES';
  todayIso: string;
  lookups: PurchasingLookupsDto;
  initialOrders: PurchaseOrderPageDto | null;
  initialPurchases: PurchasePageDto | null;
}

interface OrderFormLineState {
  key: string;
  productId: string | null;
  itemCode: string;
  itemName: string;
  unitName: string;
  isHeading: boolean;
  quantityStr: string;
  taxCode: TaxCode;
  masterUnitPrice: number | null;
  appliedUnitPriceStr: string;
  remarks: string;
}

interface PurchaseFormLineState extends OrderFormLineState {
  projectId: string;
}

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

function parseIntOrZero(raw: string): number {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '') return 0;
  const num = Number(cleaned);
  return Number.isFinite(num) && Number.isInteger(num) ? num : 0;
}

function parseQtyForCalc(raw: string): string {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '') return '0';
  try {
    const dec = new Decimal(cleaned);
    if (!dec.isFinite()) return '0';
    return dec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();
  } catch {
    return '0';
  }
}

function newEmptyOrderLine(keySeed: number): OrderFormLineState {
  return {
    key: `ol-${keySeed}-${Date.now()}`,
    productId: null,
    itemCode: '',
    itemName: '',
    unitName: '式',
    isHeading: false,
    quantityStr: '1',
    taxCode: 'A',
    masterUnitPrice: null,
    appliedUnitPriceStr: '0',
    remarks: '',
  };
}

function newEmptyPurchaseLine(keySeed: number, defaultProjectId: string): PurchaseFormLineState {
  return {
    key: `pl-${keySeed}-${Date.now()}`,
    projectId: defaultProjectId,
    productId: null,
    itemCode: '',
    itemName: '',
    unitName: '式',
    isHeading: false,
    quantityStr: '1',
    taxCode: 'A',
    masterUnitPrice: null,
    appliedUnitPriceStr: '0',
    remarks: '',
  };
}

export default function PurchasingClient({
  initialTab,
  todayIso,
  lookups,
  initialOrders,
  initialPurchases,
}: PurchasingClientProps) {
  const [activeTab, setActiveTab] = useState<'ORDERS' | 'PURCHASES'>(initialTab);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [bannerSuccess, setBannerSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 発注一覧 state
  const [ordersData, setOrdersData] = useState<PurchaseOrderPageDto | null>(initialOrders);
  const [ordKw, setOrdKw] = useState('');
  const [ordSupplierId, setOrdSupplierId] = useState('');
  const [ordProjectId, setOrdProjectId] = useState('');
  const [ordStatus, setOrdStatus] = useState<'' | OrderStatus>('');
  const [ordDateFrom, setOrdDateFrom] = useState('');
  const [ordDateTo, setOrdDateTo] = useState('');

  // 仕入一覧 state
  const [purchasesData, setPurchasesData] = useState<PurchasePageDto | null>(initialPurchases);
  const [purKw, setPurKw] = useState('');
  const [purSupplierId, setPurSupplierId] = useState('');
  const [purStatus, setPurStatus] = useState<'' | PurchaseStatus>('');
  const [purDateFrom, setPurDateFrom] = useState('');
  const [purDateTo, setPurDateTo] = useState('');

  // 発注エディタモーダル
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [editingOrderNo, setEditingOrderNo] = useState<number | null>(null);
  const [orderName, setOrderName] = useState('');
  const [orderDate, setOrderDate] = useState(todayIso);
  const [orderSupplierId, setOrderSupplierId] = useState('');
  const [orderProjectId, setOrderProjectId] = useState('');
  const [orderHonorific, setOrderHonorific] = useState('御中');
  const [orderDeliveryDate, setOrderDeliveryDate] = useState('');
  const [orderStatus, setOrderStatus] = useState<OrderStatus>('O1');
  const [orderRoundingMode, setOrderRoundingMode] = useState<RoundingMode>(lookups.defaultRoundingMode);
  const [orderRemarks, setOrderRemarks] = useState('');
  const [orderLines, setOrderLines] = useState<OrderFormLineState[]>([]);
  const [orderSnapshots, setOrderSnapshots] = useState<SnapshotHistoryItemDto[]>([]);
  const [orderLinkedPurchaseCount, setOrderLinkedPurchaseCount] = useState(0);
  const [orderTemplateVariant, setOrderTemplateVariant] = useState<'10_ROWS' | '20_ROWS'>(
    lookups.defaultTemplateVariant,
  );
  const [previewOrderSnapshotId, setPreviewOrderSnapshotId] = useState<string | null>(null);
  const [orderModalError, setOrderModalError] = useState<string | null>(null);

  // 仕入エディタモーダル
  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);
  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null);
  const [editingPurchaseNo, setEditingPurchaseNo] = useState<number | null>(null);
  const [purchaseName, setPurchaseName] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(
    todayIso > lookups.openingBalanceDate ? todayIso : '',
  );
  const [purchaseSupplierId, setPurchaseSupplierId] = useState('');
  const [purchaseOrderId, setPurchaseOrderId] = useState<string | null>(null);
  const [purchaseOrderNo, setPurchaseOrderNo] = useState<number | null>(null);
  const [purchaseHonorific, setPurchaseHonorific] = useState('御中');
  const [purchaseStatus, setPurchaseStatus] = useState<PurchaseStatus>('P1');
  const [savedPurchaseStatus, setSavedPurchaseStatus] = useState<PurchaseStatus>('P1');
  const [savedPayableStatus, setSavedPayableStatus] = useState<'A1' | 'A2' | null>(null);
  const [savedScheduledPayAt, setSavedScheduledPayAt] = useState<string | null>(null);
  const [purchaseRoundingMode, setPurchaseRoundingMode] = useState<RoundingMode>(
    lookups.defaultRoundingMode,
  );
  const [purchaseRemarks, setPurchaseRemarks] = useState('');
  const [purchaseBatchProjectId, setPurchaseBatchProjectId] = useState('');
  const [purchaseLines, setPurchaseLines] = useState<PurchaseFormLineState[]>([]);
  const [purchaseModalError, setPurchaseModalError] = useState<string | null>(null);

  const selectedOrderProject = useMemo(
    () => lookups.projects.find((pj) => pj.id === orderProjectId) ?? null,
    [lookups.projects, orderProjectId],
  );

  // リアルタイム計算 (calculations.ts 必須使用: Rule G4)
  const orderCalc = useMemo(() => {
    return calculateSalesSlip(
      orderLines.map((l, idx) => ({
        lineNo: idx + 1,
        isHeading: l.isHeading,
        quantity: l.isHeading ? '0' : parseQtyForCalc(l.quantityStr),
        appliedUnitPrice: BigInt(l.isHeading ? 0 : parseIntOrZero(l.appliedUnitPriceStr)),
        taxCode: l.isHeading ? 'C' : l.taxCode,
      })),
      orderRoundingMode,
      lookups.taxCalcPolicy,
    );
  }, [orderLines, orderRoundingMode, lookups.taxCalcPolicy]);

  const purchaseCalc = useMemo(() => {
    return calculateSalesSlip(
      purchaseLines.map((l, idx) => ({
        lineNo: idx + 1,
        isHeading: l.isHeading,
        quantity: l.isHeading ? '0' : parseQtyForCalc(l.quantityStr),
        appliedUnitPrice: BigInt(l.isHeading ? 0 : parseIntOrZero(l.appliedUnitPriceStr)),
        taxCode: l.isHeading ? 'C' : l.taxCode,
      })),
      purchaseRoundingMode,
      lookups.taxCalcPolicy,
    );
  }, [purchaseLines, purchaseRoundingMode, lookups.taxCalcPolicy]);

  function buildOrdersQueryString(page: number): string {
    const sp = new URLSearchParams();
    sp.set('page', String(page));
    sp.set('pageSize', '25');
    if (ordKw.trim() !== '') sp.set('keyword', ordKw.trim());
    if (ordSupplierId !== '') sp.set('supplierId', ordSupplierId);
    if (ordProjectId !== '') sp.set('projectId', ordProjectId);
    if (ordStatus !== '') sp.set('status', ordStatus);
    if (ordDateFrom !== '') sp.set('dateFrom', ordDateFrom);
    if (ordDateTo !== '') sp.set('dateTo', ordDateTo);
    return sp.toString();
  }

  function buildPurchasesQueryString(page: number): string {
    const sp = new URLSearchParams();
    sp.set('page', String(page));
    sp.set('pageSize', '25');
    if (purKw.trim() !== '') sp.set('keyword', purKw.trim());
    if (purSupplierId !== '') sp.set('supplierId', purSupplierId);
    if (purStatus !== '') sp.set('status', purStatus);
    if (purDateFrom !== '') sp.set('dateFrom', purDateFrom);
    if (purDateTo !== '') sp.set('dateTo', purDateTo);
    return sp.toString();
  }

  async function reloadOrders(page = 1) {
    if (!lookups.orderEnabled) return;
    setLoading(true);
    setBannerError(null);
    const res = await requestMasterApi<PurchaseOrderPageDto>(
      `/api/v1/purchase-orders?${buildOrdersQueryString(page)}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setOrdersData(res.data);
  }

  async function reloadPurchases(page = 1) {
    if (!lookups.purchaseEnabled) return;
    setLoading(true);
    setBannerError(null);
    const res = await requestMasterApi<PurchasePageDto>(
      `/api/v1/purchases?${buildPurchasesQueryString(page)}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setPurchasesData(res.data);
  }

  function openNewOrderModal() {
    setEditingOrderId(null);
    setEditingOrderNo(null);
    setOrderName('');
    setOrderDate(todayIso);
    setOrderSupplierId('');
    setOrderProjectId('');
    setOrderHonorific('御中');
    setOrderDeliveryDate('');
    setOrderStatus('O1');
    setOrderRoundingMode(lookups.defaultRoundingMode);
    setOrderRemarks('');
    setOrderLines([newEmptyOrderLine(1)]);
    setOrderSnapshots([]);
    setOrderLinkedPurchaseCount(0);
    setPreviewOrderSnapshotId(null);
    setOrderModalError(null);
    setOrderModalOpen(true);
  }

  function hydrateOrderModal(detail: PurchaseOrderDetailDto) {
    setEditingOrderId(detail.id);
    setEditingOrderNo(detail.orderNo);
    setOrderName(detail.orderName);
    setOrderDate(detail.orderDate);
    setOrderSupplierId(detail.supplierId);
    setOrderProjectId(detail.projectId !== null ? detail.projectId : '');
    setOrderHonorific(detail.honorific);
    setOrderDeliveryDate(detail.deliveryDate !== null ? detail.deliveryDate : '');
    setOrderStatus(detail.status);
    setOrderRoundingMode(detail.roundingMode);
    setOrderRemarks(detail.remarks !== null ? detail.remarks : '');
    setOrderLines(
      detail.lines.map((l) => ({
        key: l.id,
        productId: l.productId,
        itemCode: l.itemCode !== null ? l.itemCode : '',
        itemName: l.itemName,
        unitName: l.unitName !== null ? l.unitName : '',
        isHeading: l.isHeading,
        quantityStr: String(l.quantity),
        taxCode: l.taxCode,
        masterUnitPrice: l.masterUnitPrice,
        appliedUnitPriceStr: String(l.appliedUnitPrice),
        remarks: l.remarks !== null ? l.remarks : '',
      })),
    );
    setOrderSnapshots(detail.snapshots);
    setOrderLinkedPurchaseCount(detail.linkedPurchaseCount);
    setPreviewOrderSnapshotId(
      detail.snapshots[0] !== undefined ? detail.snapshots[0].id : null,
    );
    setOrderModalError(null);
    setOrderModalOpen(true);
  }

  async function openEditOrderModal(orderId: string) {
    setBannerError(null);
    setLoading(true);
    const res = await requestMasterApi<{ item: PurchaseOrderDetailDto }>(
      `/api/v1/purchase-orders/${encodeURIComponent(orderId)}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    hydrateOrderModal(res.data.item);
  }

  function handleSelectOrderSupplier(supplierId: string) {
    setOrderSupplierId(supplierId);
    const partner = lookups.partners.find((p) => p.id === supplierId);
    if (partner !== undefined) {
      setOrderHonorific(partner.isIndividualHonorific ? '様' : '御中');
    }
  }

  async function handleSaveOrder(e: React.FormEvent) {
    e.preventDefault();
    setOrderModalError(null);
    setBannerSuccess(null);

    const cleanLines: PurchaseOrderLineInput[] = orderLines.map((l) => ({
      productId: l.productId,
      itemCode: normalizeNullableText(l.itemCode),
      itemName: l.itemName.trim(),
      unitName: l.isHeading ? null : normalizeNullableText(l.unitName),
      isHeading: l.isHeading,
      quantity: l.isHeading ? 0 : Number(parseQtyForCalc(l.quantityStr)),
      taxCode: l.isHeading ? 'C' : l.taxCode,
      masterUnitPrice: l.masterUnitPrice,
      appliedUnitPrice: l.isHeading ? 0 : parseIntOrZero(l.appliedUnitPriceStr),
      remarks: normalizeNullableText(l.remarks),
    }));

    const payload: PurchaseOrderInput = {
      orderName: orderName.trim(),
      orderDate,
      supplierId: orderSupplierId,
      projectId: orderProjectId !== '' ? orderProjectId : null,
      honorific: orderHonorific.trim(),
      deliveryDate: normalizeNullableText(orderDeliveryDate),
      status: orderStatus,
      roundingMode: orderRoundingMode,
      remarks: normalizeNullableText(orderRemarks),
      lines: cleanLines,
    };

    setSaving(true);
    const url =
      editingOrderId !== null
        ? `/api/v1/purchase-orders/${encodeURIComponent(editingOrderId)}`
        : '/api/v1/purchase-orders';
    const method = editingOrderId !== null ? 'PUT' : 'POST';
    const res = await requestMasterApi<{ item: PurchaseOrderDetailDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);

    if (!res.ok) {
      setOrderModalError(res.error);
      return;
    }
    hydrateOrderModal(res.data.item);
    setBannerSuccess(`発注No.${res.data.item.orderNo} を保存しました。`);
    await reloadOrders(ordersData !== null ? ordersData.page : 1);
  }

  async function handleDeleteOrder(orderId: string, orderNo: number) {
    if (!window.confirm(`発注No.${orderNo} を削除しますか？`)) return;
    setBannerError(null);
    setBannerSuccess(null);
    const res = await requestMasterApi<{ ok: boolean }>(
      `/api/v1/purchase-orders/${encodeURIComponent(orderId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`発注No.${orderNo} を削除しました。`);
    await reloadOrders(ordersData !== null ? ordersData.page : 1);
  }

  async function handleIssueOrderSnapshot() {
    if (editingOrderId === null) return;
    setOrderModalError(null);
    setSaving(true);
    const res = await requestMasterApi<{ item: SnapshotHistoryItemDto }>('/api/v1/snapshots', {
      method: 'POST',
      body: JSON.stringify({
        documentType: 'PURCHASE_ORDER',
        sourceEntityId: editingOrderId,
        templateVariant: orderTemplateVariant,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      setOrderModalError(res.error);
      return;
    }
    setPreviewOrderSnapshotId(res.data.item.id);
    setBannerSuccess(
      `発注書スナップショット v${res.data.item.versionNo} ${res.data.item.isReissue ? '＜再発行＞' : ''}を発行しました。`,
    );
    await openEditOrderModal(editingOrderId);
    await reloadOrders(ordersData !== null ? ordersData.page : 1);
  }

  async function handleTransferOrderToPurchase(orderId: string) {
    if (!lookups.purchaseEnabled) {
      setBannerError('仕入機能（purchase）が有効化されていません。');
      return;
    }
    setBannerError(null);
    setBannerSuccess(null);
    setSaving(true);
    const res = await requestMasterApi<{ item: PurchaseDetailDto }>(
      '/api/v1/purchases/from-order',
      {
        method: 'POST',
        body: JSON.stringify({
          orderId,
          purchaseDate: todayIso,
          initialStatus: 'P2',
        }),
      },
    );
    setSaving(false);
    if (!res.ok) {
      setOrderModalError(res.error);
      setBannerError(res.error);
      return;
    }
    setOrderModalOpen(false);
    setActiveTab('PURCHASES');
    setBannerSuccess(
      `発注から仕入No.${res.data.item.purchaseNo}（仕入待ち P2）を作成しました。内容確認後、仕入確定を行ってください。`,
    );
    await Promise.all([reloadOrders(1), reloadPurchases(1)]);
    hydratePurchaseModal(res.data.item);
  }

  function openNewPurchaseModal() {
    setEditingPurchaseId(null);
    setEditingPurchaseNo(null);
    setPurchaseName('');
    setPurchaseDate(todayIso > lookups.openingBalanceDate ? todayIso : lookups.openingBalanceDate);
    setPurchaseSupplierId('');
    setPurchaseOrderId(null);
    setPurchaseOrderNo(null);
    setPurchaseHonorific('御中');
    setPurchaseStatus('P1');
    setSavedPurchaseStatus('P1');
    setSavedPayableStatus(null);
    setSavedScheduledPayAt(null);
    setPurchaseRoundingMode(lookups.defaultRoundingMode);
    setPurchaseRemarks('');
    setPurchaseBatchProjectId('');
    setPurchaseLines([newEmptyPurchaseLine(1, '')]);
    setPurchaseModalError(null);
    setPurchaseModalOpen(true);
  }

  function hydratePurchaseModal(detail: PurchaseDetailDto) {
    setEditingPurchaseId(detail.id);
    setEditingPurchaseNo(detail.purchaseNo);
    setPurchaseName(detail.purchaseName);
    setPurchaseDate(detail.purchaseDate);
    setPurchaseSupplierId(detail.supplierId);
    setPurchaseOrderId(detail.purchaseOrderId);
    setPurchaseOrderNo(detail.orderNo);
    setPurchaseHonorific(detail.honorific);
    setPurchaseStatus(detail.status);
    setSavedPurchaseStatus(detail.status);
    setSavedPayableStatus(detail.payableStatus);
    setSavedScheduledPayAt(detail.scheduledPayAt);
    setPurchaseRoundingMode(detail.roundingMode);
    setPurchaseRemarks(detail.remarks !== null ? detail.remarks : '');
    const firstProj = detail.lines.find((l) => l.projectId !== null)?.projectId ?? '';
    setPurchaseBatchProjectId(firstProj);
    setPurchaseLines(
      detail.lines.map((l) => ({
        key: l.id,
        projectId: l.projectId !== null ? l.projectId : '',
        productId: l.productId,
        itemCode: l.itemCode !== null ? l.itemCode : '',
        itemName: l.itemName,
        unitName: l.unitName !== null ? l.unitName : '',
        isHeading: l.isHeading,
        quantityStr: String(l.quantity),
        taxCode: l.taxCode,
        masterUnitPrice: l.masterUnitPrice,
        appliedUnitPriceStr: String(l.appliedUnitPrice),
        remarks: l.remarks !== null ? l.remarks : '',
      })),
    );
    setPurchaseModalError(null);
    setPurchaseModalOpen(true);
  }

  async function openEditPurchaseModal(purchaseId: string) {
    setBannerError(null);
    setLoading(true);
    const res = await requestMasterApi<{ item: PurchaseDetailDto }>(
      `/api/v1/purchases/${encodeURIComponent(purchaseId)}`,
    );
    setLoading(false);
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    hydratePurchaseModal(res.data.item);
  }

  function handleSelectPurchaseSupplier(supplierId: string) {
    setPurchaseSupplierId(supplierId);
    const partner = lookups.partners.find((p) => p.id === supplierId);
    if (partner !== undefined) {
      setPurchaseHonorific(partner.isIndividualHonorific ? '様' : '御中');
    }
  }

  async function savePurchaseWithStatus(targetStatus: PurchaseStatus) {
    setPurchaseModalError(null);
    setBannerSuccess(null);

    if (targetStatus === 'P3' && purchaseDate <= lookups.openingBalanceDate) {
      setPurchaseModalError(
        `仕入確定（P3）は期首残高基準日（${lookups.openingBalanceDate}）より後の日付が必要です。基準日以前は P1/P2 のまま保存するか、仕入日を基準日以降へ変更してください。`,
      );
      return;
    }

    const cleanLines: PurchaseLineInput[] = purchaseLines.map((l) => ({
      projectId: l.projectId !== '' ? l.projectId : null,
      productId: l.productId,
      itemCode: normalizeNullableText(l.itemCode),
      itemName: l.itemName.trim(),
      unitName: l.isHeading ? null : normalizeNullableText(l.unitName),
      isHeading: l.isHeading,
      quantity: l.isHeading ? 0 : Number(parseQtyForCalc(l.quantityStr)),
      taxCode: l.isHeading ? 'C' : l.taxCode,
      masterUnitPrice: l.masterUnitPrice,
      appliedUnitPrice: l.isHeading ? 0 : parseIntOrZero(l.appliedUnitPriceStr),
      remarks: normalizeNullableText(l.remarks),
    }));

    const payload: PurchaseInput = {
      purchaseName: purchaseName.trim(),
      purchaseDate,
      supplierId: purchaseSupplierId,
      purchaseOrderId,
      honorific: purchaseHonorific.trim(),
      status: targetStatus,
      roundingMode: purchaseRoundingMode,
      remarks: normalizeNullableText(purchaseRemarks),
      lines: cleanLines,
    };

    setSaving(true);
    const url =
      editingPurchaseId !== null
        ? `/api/v1/purchases/${encodeURIComponent(editingPurchaseId)}`
        : '/api/v1/purchases';
    const method = editingPurchaseId !== null ? 'PUT' : 'POST';
    const res = await requestMasterApi<{ item: PurchaseDetailDto }>(url, {
      method,
      body: JSON.stringify(payload),
    });
    setSaving(false);

    if (!res.ok) {
      setPurchaseModalError(res.error);
      return;
    }
    hydratePurchaseModal(res.data.item);
    setBannerSuccess(
      res.data.item.status === 'P3'
        ? `仕入No.${res.data.item.purchaseNo} を確定（P3）し、買掛台帳へ自動計上しました。`
        : `仕入No.${res.data.item.purchaseNo}（${PURCHASE_STATUS_LABELS[res.data.item.status]}）を保存しました。`,
    );
    await reloadPurchases(purchasesData !== null ? purchasesData.page : 1);
  }

  async function handleCancelPurchaseConfirm() {
    if (editingPurchaseId === null) return;
    if (!window.confirm('仕入確定（P3）を取り消し、買掛台帳を削除して仕入待ち（P2）に戻しますか？')) {
      return;
    }
    setPurchaseModalError(null);
    setSaving(true);
    const res = await requestMasterApi<{ item: PurchaseDetailDto }>(
      `/api/v1/purchases/${encodeURIComponent(editingPurchaseId)}/cancel-confirm`,
      { method: 'POST' },
    );
    setSaving(false);
    if (!res.ok) {
      setPurchaseModalError(res.error);
      return;
    }
    hydratePurchaseModal(res.data.item);
    setBannerSuccess(
      `仕入No.${res.data.item.purchaseNo} の仕入確定を取消し、仕入待ち（P2）へ戻しました。`,
    );
    await reloadPurchases(purchasesData !== null ? purchasesData.page : 1);
  }

  async function handleDeletePurchase(purchaseId: string, purchaseNo: number) {
    if (!window.confirm(`仕入No.${purchaseNo} を削除しますか？`)) return;
    setBannerError(null);
    setBannerSuccess(null);
    const res = await requestMasterApi<{ ok: boolean }>(
      `/api/v1/purchases/${encodeURIComponent(purchaseId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) {
      setBannerError(res.error);
      return;
    }
    setBannerSuccess(`仕入No.${purchaseNo} を削除しました。`);
    await reloadPurchases(purchasesData !== null ? purchasesData.page : 1);
  }

  const isPurchaseLocked = savedPurchaseStatus === 'P3';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">発注・仕入管理</h1>
          <p className="text-sm text-slate-600 mt-1">
            発注伝票作成・発注書スナップショット発行・仕入転記・仕入確定（P3）と買掛台帳自動連携を行います。
            <span className="ml-2 text-xs text-slate-500">
              （期首残高基準日: <span className="font-mono">{lookups.openingBalanceDate}</span>）
            </span>
          </p>
        </div>
        {lookups.payableEnabled && (
          <Link
            href="/payables"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            買掛・支払管理へ →
          </Link>
        )}
      </div>

      {/* タブ切替 */}
      <div className="flex items-center gap-2 border-b border-slate-200">
        {lookups.orderEnabled && (
          <button
            type="button"
            onClick={() => setActiveTab('ORDERS')}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === 'ORDERS'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            発注管理（発注書）
          </button>
        )}
        {lookups.purchaseEnabled && (
          <button
            type="button"
            onClick={() => setActiveTab('PURCHASES')}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              activeTab === 'PURCHASES'
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            仕入管理（買掛計上）
          </button>
        )}
      </div>

      {bannerError !== null && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {bannerError}
        </div>
      )}
      {bannerSuccess !== null && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {bannerSuccess}
        </div>
      )}

      {/* === 発注一覧タブ === */}
      {activeTab === 'ORDERS' && lookups.orderEnabled && (
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">検索</label>
                <input
                  type="text"
                  value={ordKw}
                  onChange={(e) => setOrdKw(e.target.value)}
                  placeholder="発注No・件名・仕入先・案件名"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">仕入先</label>
                <select
                  value={ordSupplierId}
                  onChange={(e) => setOrdSupplierId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                >
                  <option value="">すべて</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.partnerCode} {p.partnerName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">案件</label>
                <select
                  value={ordProjectId}
                  onChange={(e) => setOrdProjectId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                >
                  <option value="">すべて</option>
                  {lookups.projects.map((pj) => (
                    <option key={pj.id} value={pj.id}>
                      {pj.projectNo} {pj.projectName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">状態</label>
                <select
                  value={ordStatus}
                  onChange={(e) => setOrdStatus(e.target.value as '' | OrderStatus)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                >
                  <option value="">すべて</option>
                  <option value="O1">O1: 新規</option>
                  <option value="O2">O2: 発注待ち</option>
                  <option value="O3">O3: 発注済</option>
                </select>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => reloadOrders(1)}
                  disabled={loading}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  検索
                </button>
                <button
                  type="button"
                  onClick={openNewOrderModal}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  + 新規発注
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs text-slate-600">
              <div className="flex items-center gap-2">
                <span>発注日期間:</span>
                <input
                  type="date"
                  value={ordDateFrom}
                  onChange={(e) => setOrdDateFrom(e.target.value)}
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                />
                <span>〜</span>
                <input
                  type="date"
                  value={ordDateTo}
                  onChange={(e) => setOrdDateTo(e.target.value)}
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/v1/purchase-orders/export?format=csv&${buildOrdersQueryString(1)}`}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  CSV出力
                </a>
                <a
                  href={`/api/v1/purchase-orders/export?format=pdf&${buildOrdersQueryString(1)}`}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  一覧PDF出力
                </a>
              </div>
            </div>
          </div>

          {ordersData !== null && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">対象発注明細件数</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    {ordersData.summary.totalCount} 件
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">税抜金額合計</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    {formatYen(ordersData.summary.subtotalAmount)}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">消費税合計</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    {formatYen(ordersData.summary.taxTotal)}
                  </div>
                </div>
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <div className="text-xs text-blue-700">税込発注金額合計</div>
                  <div className="text-lg font-bold text-blue-900 mt-0.5">
                    {formatYen(ordersData.summary.totalAmount)}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-right">発注No</th>
                      <th className="px-3 py-2 text-left">発注日</th>
                      <th className="px-3 py-2 text-center">状態</th>
                      <th className="px-3 py-2 text-left">仕入先名</th>
                      <th className="px-3 py-2 text-left">件名 / 案件・納入場所</th>
                      <th className="px-3 py-2 text-left">納期</th>
                      <th className="px-3 py-2 text-right">税抜金額</th>
                      <th className="px-3 py-2 text-right">消費税</th>
                      <th className="px-3 py-2 text-right">税込金額</th>
                      <th className="px-3 py-2 text-center">発注書版</th>
                      <th className="px-3 py-2 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {ordersData.items.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="px-4 py-8 text-center text-slate-500">
                          該当する発注データはありません。
                        </td>
                      </tr>
                    ) : (
                      ordersData.items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="px-3 py-2 text-right font-mono font-semibold">
                            {item.orderNo}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                            {item.orderDate}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span
                              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                item.status === 'O3'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : item.status === 'O2'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              {item.status} {ORDER_STATUS_LABELS[item.status]}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-slate-900">{item.supplierName}</div>
                            <div className="text-[11px] font-mono text-slate-400">
                              {item.supplierCode}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-slate-900">{item.orderName}</div>
                            {(item.projectName !== null || item.deliveryPlace !== null) && (
                              <div className="text-[11px] text-slate-500">
                                {item.projectName !== null
                                  ? `${item.projectNo ?? ''} ${item.projectName}`
                                  : ''}
                                {item.deliveryPlace !== null
                                  ? ` / 納入場所: ${item.deliveryPlace}`
                                  : ''}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">
                            {item.deliveryDate !== null ? item.deliveryDate : '-'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(item.subtotalAmount)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-600">
                            {formatYen(item.taxTotal)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
                            {formatYen(item.totalAmount)}
                          </td>
                          <td className="px-3 py-2 text-center text-xs">
                            {item.latestSnapshotVersion !== null ? (
                              <span className="rounded bg-blue-50 px-2 py-0.5 text-blue-700 font-mono">
                                v{item.latestSnapshotVersion}
                              </span>
                            ) : (
                              <span className="text-slate-400">未発行</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap space-x-1.5">
                            <button
                              type="button"
                              onClick={() => openEditOrderModal(item.id)}
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                            >
                              編集 / 発注書
                            </button>
                            {lookups.purchaseEnabled && (
                              <button
                                type="button"
                                onClick={() => handleTransferOrderToPurchase(item.id)}
                                className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100"
                              >
                                仕入転記
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDeleteOrder(item.id, item.orderNo)}
                              disabled={item.snapshotCount > 0 || item.linkedPurchaseCount > 0}
                              className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
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

              <div className="flex items-center justify-between text-xs text-slate-600">
                <span>
                  ページ {ordersData.page} /{' '}
                  {computePageCount(ordersData.summary.totalCount, ordersData.pageSize)}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={ordersData.page <= 1}
                    onClick={() => reloadOrders(ordersData.page - 1)}
                    className="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-40"
                  >
                    前へ
                  </button>
                  <button
                    type="button"
                    disabled={
                      ordersData.page >=
                      computePageCount(ordersData.summary.totalCount, ordersData.pageSize)
                    }
                    onClick={() => reloadOrders(ordersData.page + 1)}
                    className="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-40"
                  >
                    次へ
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* === 仕入一覧タブ === */}
      {activeTab === 'PURCHASES' && lookups.purchaseEnabled && (
        <section className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-600 mb-1">検索</label>
                <input
                  type="text"
                  value={purKw}
                  onChange={(e) => setPurKw(e.target.value)}
                  placeholder="仕入No・件名・仕入先名"
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">仕入先</label>
                <select
                  value={purSupplierId}
                  onChange={(e) => setPurSupplierId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                >
                  <option value="">すべて</option>
                  {lookups.partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.partnerCode} {p.partnerName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">状態</label>
                <select
                  value={purStatus}
                  onChange={(e) => setPurStatus(e.target.value as '' | PurchaseStatus)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                >
                  <option value="">すべて</option>
                  <option value="P1">P1: 新規</option>
                  <option value="P2">P2: 仕入待ち</option>
                  <option value="P3">P3: 仕入済（買掛計上）</option>
                </select>
              </div>
              <div className="md:col-span-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => reloadPurchases(1)}
                  disabled={loading}
                  className="rounded-lg bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  検索
                </button>
                <button
                  type="button"
                  onClick={openNewPurchaseModal}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                >
                  + 新規仕入
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 text-xs text-slate-600">
              <div className="flex items-center gap-2">
                <span>仕入日期間:</span>
                <input
                  type="date"
                  value={purDateFrom}
                  onChange={(e) => setPurDateFrom(e.target.value)}
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                />
                <span>〜</span>
                <input
                  type="date"
                  value={purDateTo}
                  onChange={(e) => setPurDateTo(e.target.value)}
                  className="rounded border border-slate-300 px-2 py-1 text-xs"
                />
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`/api/v1/purchases/export?format=csv&${buildPurchasesQueryString(1)}`}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  CSV出力
                </a>
                <a
                  href={`/api/v1/purchases/export?format=pdf&${buildPurchasesQueryString(1)}`}
                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  一覧PDF出力
                </a>
              </div>
            </div>
          </div>

          {purchasesData !== null && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">対象仕入件数</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    {purchasesData.summary.totalCount} 件
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">税抜仕入合計</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    {formatYen(purchasesData.summary.subtotalAmount)}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="text-xs text-slate-500">消費税合計</div>
                  <div className="text-lg font-bold text-slate-900 mt-0.5">
                    {formatYen(purchasesData.summary.taxTotal)}
                  </div>
                </div>
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                  <div className="text-xs text-blue-700">税込仕入合計</div>
                  <div className="text-lg font-bold text-blue-900 mt-0.5">
                    {formatYen(purchasesData.summary.totalAmount)}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                    <tr>
                      <th className="px-3 py-2 text-right">仕入No</th>
                      <th className="px-3 py-2 text-left">仕入日</th>
                      <th className="px-3 py-2 text-center">状態</th>
                      <th className="px-3 py-2 text-right">元発注No</th>
                      <th className="px-3 py-2 text-left">仕入先名</th>
                      <th className="px-3 py-2 text-left">件名</th>
                      <th className="px-3 py-2 text-center">買掛状態</th>
                      <th className="px-3 py-2 text-right">税抜金額</th>
                      <th className="px-3 py-2 text-right">消費税</th>
                      <th className="px-3 py-2 text-right">税込金額</th>
                      <th className="px-3 py-2 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {purchasesData.items.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="px-4 py-8 text-center text-slate-500">
                          該当する仕入データはありません。
                        </td>
                      </tr>
                    ) : (
                      purchasesData.items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50">
                          <td className="px-3 py-2 text-right font-mono font-semibold">
                            {item.purchaseNo}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap font-mono text-xs">
                            {item.purchaseDate}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <span
                              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                item.status === 'P3'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : item.status === 'P2'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              {item.status} {PURCHASE_STATUS_LABELS[item.status]}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-xs text-slate-500">
                            {item.orderNo !== null ? `No.${item.orderNo}` : '-'}
                          </td>
                          <td className="px-3 py-2">
                            <div className="font-medium text-slate-900">{item.supplierName}</div>
                            <div className="text-[11px] font-mono text-slate-400">
                              {item.supplierCode}
                            </div>
                          </td>
                          <td className="px-3 py-2 font-medium text-slate-900">
                            {item.purchaseName}
                          </td>
                          <td className="px-3 py-2 text-center text-xs">
                            {item.payableStatus !== null ? (
                              <span
                                className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                                  item.payableStatus === 'A2'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-rose-100 text-rose-800'
                                }`}
                              >
                                {item.payableStatus} {PAYABLE_STATUS_LABELS[item.payableStatus]}
                              </span>
                            ) : (
                              <span className="text-slate-400">未計上</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-mono">
                            {formatYen(item.subtotalAmount)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-600">
                            {formatYen(item.taxTotal)}
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
                            {formatYen(item.totalAmount)}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap space-x-1.5">
                            <button
                              type="button"
                              onClick={() => openEditPurchaseModal(item.id)}
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
                            >
                              {item.status === 'P3' ? '詳細 / 取消' : '編集 / 確定'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeletePurchase(item.id, item.purchaseNo)}
                              disabled={item.status === 'P3'}
                              className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
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

              <div className="flex items-center justify-between text-xs text-slate-600">
                <span>
                  ページ {purchasesData.page} /{' '}
                  {computePageCount(purchasesData.summary.totalCount, purchasesData.pageSize)}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={purchasesData.page <= 1}
                    onClick={() => reloadPurchases(purchasesData.page - 1)}
                    className="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-40"
                  >
                    前へ
                  </button>
                  <button
                    type="button"
                    disabled={
                      purchasesData.page >=
                      computePageCount(purchasesData.summary.totalCount, purchasesData.pageSize)
                    }
                    onClick={() => reloadPurchases(purchasesData.page + 1)}
                    className="rounded border border-slate-300 px-2.5 py-1 disabled:opacity-40"
                  >
                    次へ
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* === 発注エディタ・発注書スナップショットモーダル === */}
      {orderModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-6xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {editingOrderNo !== null ? `発注編集（No.${editingOrderNo}）` : '新規発注登録'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  金額・消費税は calculations.ts（{lookups.taxCalcPolicy}）で厳密計算されます。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOrderModalOpen(false)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100"
              >
                閉じる
              </button>
            </div>

            {orderModalError !== null && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {orderModalError}
              </div>
            )}

            <form onSubmit={handleSaveOrder} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">発注日 *</label>
                  <input
                    type="date"
                    required
                    value={orderDate}
                    onChange={(e) => setOrderDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">ステータス</label>
                  <select
                    value={orderStatus}
                    onChange={(e) => setOrderStatus(e.target.value as OrderStatus)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                  >
                    <option value="O1">O1: 新規</option>
                    <option value="O2">O2: 発注待ち</option>
                    <option value="O3">O3: 発注済</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">仕入先 *</label>
                  <select
                    required
                    value={orderSupplierId}
                    onChange={(e) => handleSelectOrderSupplier(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                  >
                    <option value="">-- 仕入先を選択 --</option>
                    {lookups.partners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.partnerCode} {p.partnerName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    案件紐付け（既存案件参照）
                  </label>
                  <select
                    value={orderProjectId}
                    onChange={(e) => setOrderProjectId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                  >
                    <option value="">（未紐付け）</option>
                    {lookups.projects.map((pj) => (
                      <option key={pj.id} value={pj.id}>
                        {pj.projectNo} {pj.projectName}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">発注件名 *</label>
                  <input
                    type="text"
                    required
                    value={orderName}
                    onChange={(e) => setOrderName(e.target.value)}
                    placeholder="例：屋根修繕工事 外注一式"
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">敬称 / 端数処理</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      value={orderHonorific}
                      onChange={(e) => setOrderHonorific(e.target.value)}
                      className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                    />
                    <select
                      value={orderRoundingMode}
                      onChange={(e) => setOrderRoundingMode(e.target.value as RoundingMode)}
                      className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                    >
                      <option value="FLOOR">切り捨て</option>
                      <option value="ROUND">四捨五入</option>
                      <option value="CEIL">切り上げ</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">納期</label>
                  <input
                    type="text"
                    value={orderDeliveryDate}
                    onChange={(e) => setOrderDeliveryDate(e.target.value)}
                    placeholder="例：2026-07-15 / ご相談"
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    納入場所（選択案件の現場名）
                  </label>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700">
                    {selectedOrderProject !== null && selectedOrderProject.sitePlace !== null
                      ? selectedOrderProject.sitePlace
                      : '（案件未選択または現場名未登録）'}
                  </div>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">備考</label>
                  <input
                    type="text"
                    value={orderRemarks}
                    onChange={(e) => setOrderRemarks(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                </div>
              </div>

              {/* 明細行 */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">
                    発注明細（{orderLines.length}行）
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    <select
                      value=""
                      onChange={(e) => {
                        const prod = lookups.products.find((p) => p.id === e.target.value);
                        if (prod === undefined) return;
                        const basePrice =
                          prod.standardPurchasePrice > 0
                            ? prod.standardPurchasePrice
                            : prod.standardCostPrice;
                        setOrderLines((prev) => [
                          ...prev,
                          {
                            key: `ol-p-${Date.now()}-${prev.length}`,
                            productId: prod.id,
                            itemCode: prod.productCode,
                            itemName: prod.productName,
                            unitName: prod.isHeading ? '' : (prod.unitName ?? '式'),
                            isHeading: prod.isHeading,
                            quantityStr: prod.isHeading ? '0' : '1',
                            taxCode: prod.isHeading ? 'C' : prod.defaultTaxCode,
                            masterUnitPrice: basePrice,
                            appliedUnitPriceStr: prod.isHeading ? '0' : String(basePrice),
                            remarks: '',
                          },
                        ]);
                      }}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                    >
                      <option value="">+ 商品マスタから追加...</option>
                      {lookups.products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.productCode} {p.productName}
                        </option>
                      ))}
                    </select>
                    <select
                      value=""
                      onChange={(e) => {
                        const intel = lookups.intelligences.find((i) => i.id === e.target.value);
                        if (intel === undefined) return;
                        const basePrice = intel.costPrice > 0 ? intel.costPrice : intel.unitPrice;
                        setOrderLines((prev) => [
                          ...prev,
                          {
                            key: `ol-i-${Date.now()}-${prev.length}`,
                            productId: null,
                            itemCode: '',
                            itemName: intel.itemName,
                            unitName: intel.unitName ?? '式',
                            isHeading: false,
                            quantityStr: '1',
                            taxCode: intel.taxCode,
                            masterUnitPrice: basePrice,
                            appliedUnitPriceStr: String(basePrice),
                            remarks: '',
                          },
                        ]);
                      }}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                    >
                      <option value="">+ 入力候補から追加...</option>
                      {lookups.intelligences.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.itemName}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() =>
                        setOrderLines((prev) => [...prev, newEmptyOrderLine(prev.length + 1)])
                      }
                      className="rounded-lg border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                    >
                      + 明細行
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setOrderLines((prev) => [
                          ...prev,
                          {
                            key: `ol-h-${Date.now()}-${prev.length}`,
                            productId: null,
                            itemCode: '',
                            itemName: '【見出し】',
                            unitName: '',
                            isHeading: true,
                            quantityStr: '0',
                            taxCode: 'C',
                            masterUnitPrice: null,
                            appliedUnitPriceStr: '0',
                            remarks: '',
                          },
                        ])
                      }
                      className="rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                    >
                      + 見出し行
                    </button>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <tr>
                        <th className="px-2 py-1.5 text-center w-8">#</th>
                        <th className="px-2 py-1.5 text-center w-12">見出</th>
                        <th className="px-2 py-1.5 text-left">品名・仕様 *</th>
                        <th className="px-2 py-1.5 text-left w-16">単位</th>
                        <th className="px-2 py-1.5 text-right w-20">数量</th>
                        <th className="px-2 py-1.5 text-right w-28">発注単価</th>
                        <th className="px-2 py-1.5 text-center w-24">税区分</th>
                        <th className="px-2 py-1.5 text-right w-24">金額</th>
                        <th className="px-2 py-1.5 text-right w-20">消費税</th>
                        <th className="px-2 py-1.5 text-right w-24">行合計</th>
                        <th className="px-2 py-1.5 text-left w-28">備考</th>
                        <th className="px-2 py-1.5 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {orderLines.map((line, idx) => {
                        const calcRow = orderCalc.lineResults[idx];
                        return (
                          <tr key={line.key} className={line.isHeading ? 'bg-slate-50' : ''}>
                            <td className="px-2 py-1.5 text-center font-mono">{idx + 1}</td>
                            <td className="px-2 py-1.5 text-center">
                              <input
                                type="checkbox"
                                checked={line.isHeading}
                                onChange={(e) => {
                                  const nextHead = e.target.checked;
                                  setOrderLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx
                                        ? {
                                            ...row,
                                            isHeading: nextHead,
                                            quantityStr: nextHead ? '0' : '1',
                                            appliedUnitPriceStr: nextHead ? '0' : row.appliedUnitPriceStr,
                                            taxCode: nextHead ? 'C' : row.taxCode,
                                          }
                                        : row,
                                    ),
                                  );
                                }}
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                required
                                value={line.itemName}
                                onChange={(e) =>
                                  setOrderLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx ? { ...row, itemName: e.target.value } : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                disabled={line.isHeading}
                                value={line.unitName}
                                onChange={(e) =>
                                  setOrderLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx ? { ...row, unitName: e.target.value } : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                disabled={line.isHeading}
                                value={line.quantityStr}
                                onChange={(e) =>
                                  setOrderLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx ? { ...row, quantityStr: e.target.value } : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono disabled:bg-slate-100"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                disabled={line.isHeading}
                                value={line.appliedUnitPriceStr}
                                onChange={(e) =>
                                  setOrderLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx
                                        ? { ...row, appliedUnitPriceStr: e.target.value }
                                        : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono disabled:bg-slate-100"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <select
                                disabled={line.isHeading}
                                value={line.taxCode}
                                onChange={(e) =>
                                  setOrderLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx
                                        ? { ...row, taxCode: e.target.value as TaxCode }
                                        : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-1 py-1 disabled:bg-slate-100"
                              >
                                {lookups.taxCodes.map((tc) => (
                                  <option key={tc.taxCode} value={tc.taxCode}>
                                    {tc.taxCode}:{tc.taxName}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">
                              {calcRow !== undefined ? Number(calcRow.lineAmount).toLocaleString('ja-JP') : '0'}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono text-slate-600">
                              {calcRow !== undefined ? Number(calcRow.lineTax).toLocaleString('ja-JP') : '0'}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono font-semibold">
                              {calcRow !== undefined ? Number(calcRow.rowTotal).toLocaleString('ja-JP') : '0'}
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                value={line.remarks}
                                onChange={(e) =>
                                  setOrderLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx ? { ...row, remarks: e.target.value } : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1"
                              />
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              <button
                                type="button"
                                disabled={orderLines.length <= 1}
                                onClick={() =>
                                  setOrderLines((prev) => prev.filter((_, i) => i !== idx))
                                }
                                className="text-red-600 hover:underline disabled:opacity-30"
                              >
                                削除
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                  <div className="flex flex-wrap gap-6 font-mono">
                    <span>税抜計: {formatYen(Number(orderCalc.subtotalAmount))}</span>
                    <span>消費税: {formatYen(Number(orderCalc.taxTotal))}</span>
                    <span className="font-bold text-blue-800">
                      税込合計: {formatYen(Number(orderCalc.totalAmount))}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="submit"
                      disabled={saving}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {saving ? '保存中...' : '発注を保存'}
                    </button>
                    {editingOrderId !== null && lookups.purchaseEnabled && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => handleTransferOrderToPurchase(editingOrderId)}
                        className="rounded-lg border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        仕入伝票へ転記
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </form>

            {/* 発注書スナップショットセクション */}
            {editingOrderId !== null && (
              <div className="border-t border-slate-200 pt-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900">
                      発注書スナップショット履歴（PURCHASE_ORDER / 転記済仕入: {orderLinkedPurchaseCount}件）
                    </h3>
                    <p className="text-xs text-slate-500">
                      発行時点の自社情報・仕入先・案件・納期・納入場所・税率別内訳を不変凍結します。
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={orderTemplateVariant}
                      onChange={(e) =>
                        setOrderTemplateVariant(e.target.value as '10_ROWS' | '20_ROWS')
                      }
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                    >
                      <option value="10_ROWS">10行レイアウト</option>
                      <option value="20_ROWS">20行レイアウト</option>
                    </select>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={handleIssueOrderSnapshot}
                      className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                    >
                      {orderSnapshots.length > 0
                        ? '発注書を再発行 (＜再発行＞)'
                        : '発注書を発行 (v1)'}
                    </button>
                  </div>
                </div>

                {orderSnapshots.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      {orderSnapshots.map((snap) => (
                        <div
                          key={snap.id}
                          className={`rounded-lg border p-2.5 text-xs flex items-center justify-between ${
                            previewOrderSnapshotId === snap.id
                              ? 'border-blue-500 bg-blue-50'
                              : 'border-slate-200 bg-white'
                          }`}
                        >
                          <div>
                            <div className="font-semibold">
                              v{snap.versionNo} {snap.reissueLabel ?? ''}
                            </div>
                            <div className="text-[11px] text-slate-500 font-mono">
                              {snap.issuedAt.slice(0, 16).replace('T', ' ')}
                            </div>
                          </div>
                          <div className="flex gap-1.5">
                            <button
                              type="button"
                              onClick={() => setPreviewOrderSnapshotId(snap.id)}
                              className="rounded border border-slate-300 px-2 py-0.5 text-[11px] hover:bg-slate-100"
                            >
                              表示
                            </button>
                            <a
                              href={`/api/v1/snapshots/${encodeURIComponent(snap.id)}/pdf?download=1`}
                              className="rounded border border-blue-300 px-2 py-0.5 text-[11px] text-blue-700 hover:bg-blue-50"
                            >
                              PDF
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="md:col-span-2">
                      {previewOrderSnapshotId !== null && (
                        <iframe
                          title="発注書スナップショットプレビュー"
                          src={`/api/v1/snapshots/${encodeURIComponent(previewOrderSnapshotId)}/pdf`}
                          className="w-full h-96 rounded-xl border border-slate-300 bg-slate-50"
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* === 仕入エディタモーダル === */}
      {purchaseModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-6xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white shadow-xl border border-slate-200 p-6 space-y-5">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {editingPurchaseNo !== null
                    ? `仕入編集（No.${editingPurchaseNo}）`
                    : '新規仕入登録'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  P1/P2 は基準日（{lookups.openingBalanceDate}）以前も編集可能。P3（仕入確定）は基準日より後の日付でのみ実行でき、同時に買掛台帳が自動生成されます。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPurchaseModalOpen(false)}
                className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-600 hover:bg-slate-100"
              >
                閉じる
              </button>
            </div>

            {isPurchaseLocked && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-bold">仕入確定済（P3）ロック中</span>
                  {savedPayableStatus !== null && (
                    <span className="ml-2">
                      買掛状態: {savedPayableStatus} {PAYABLE_STATUS_LABELS[savedPayableStatus]}
                      {savedScheduledPayAt !== null ? ` / 支払予定日: ${savedScheduledPayAt}` : ''}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {lookups.payableEnabled && (
                    <Link
                      href="/payables?tab=LEDGERS"
                      className="rounded border border-emerald-400 bg-white px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                    >
                      買掛台帳を確認 →
                    </Link>
                  )}
                  {savedPayableStatus !== 'A2' && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={handleCancelPurchaseConfirm}
                      className="rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      仕入確定取消（P3 → P2）
                    </button>
                  )}
                </div>
              </div>
            )}

            {purchaseModalError !== null && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                {purchaseModalError}
              </div>
            )}

            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">仕入日 *</label>
                  <input
                    type="date"
                    disabled={isPurchaseLocked}
                    value={purchaseDate}
                    onChange={(e) => setPurchaseDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:bg-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">仕入先 *</label>
                  <select
                    disabled={isPurchaseLocked}
                    value={purchaseSupplierId}
                    onChange={(e) => handleSelectPurchaseSupplier(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
                  >
                    <option value="">-- 仕入先を選択 --</option>
                    {lookups.partners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.partnerCode} {p.partnerName}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    一括案件適用（明細行へ一括反映）
                  </label>
                  <div className="flex gap-1.5">
                    <select
                      disabled={isPurchaseLocked}
                      value={purchaseBatchProjectId}
                      onChange={(e) => setPurchaseBatchProjectId(e.target.value)}
                      className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
                    >
                      <option value="">（案件指定なし）</option>
                      {lookups.projects.map((pj) => (
                        <option key={pj.id} value={pj.id}>
                          {pj.projectNo} {pj.projectName}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={isPurchaseLocked}
                      onClick={() =>
                        setPurchaseLines((prev) =>
                          prev.map((row) => ({ ...row, projectId: purchaseBatchProjectId })),
                        )
                      }
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                    >
                      反映
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    元発注No / ステータス
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-500">
                      {purchaseOrderNo !== null ? `発注No.${purchaseOrderNo}` : '直接仕入'}
                    </span>
                    <select
                      disabled={isPurchaseLocked}
                      value={purchaseStatus}
                      onChange={(e) => setPurchaseStatus(e.target.value as PurchaseStatus)}
                      className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
                    >
                      <option value="P1">P1: 新規</option>
                      <option value="P2">P2: 仕入待ち</option>
                      <option value="P3">P3: 仕入済（買掛計上）</option>
                    </select>
                  </div>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-slate-700 mb-1">仕入件名 *</label>
                  <input
                    type="text"
                    disabled={isPurchaseLocked}
                    value={purchaseName}
                    onChange={(e) => setPurchaseName(e.target.value)}
                    placeholder="例：屋根工事 材料一式"
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:bg-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">敬称 / 端数処理</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      disabled={isPurchaseLocked}
                      value={purchaseHonorific}
                      onChange={(e) => setPurchaseHonorific(e.target.value)}
                      className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
                    />
                    <select
                      disabled={isPurchaseLocked}
                      value={purchaseRoundingMode}
                      onChange={(e) => setPurchaseRoundingMode(e.target.value as RoundingMode)}
                      className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-100"
                    >
                      <option value="FLOOR">切り捨て</option>
                      <option value="ROUND">四捨五入</option>
                      <option value="CEIL">切り上げ</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">備考</label>
                  <input
                    type="text"
                    disabled={isPurchaseLocked}
                    value={purchaseRemarks}
                    onChange={(e) => setPurchaseRemarks(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:bg-slate-100"
                  />
                </div>
              </div>

              {/* 仕入明細 */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-800">
                    仕入明細（{purchaseLines.length}行）
                  </h3>
                  {!isPurchaseLocked && (
                    <div className="flex flex-wrap gap-2">
                      <select
                        value=""
                        onChange={(e) => {
                          const prod = lookups.products.find((p) => p.id === e.target.value);
                          if (prod === undefined) return;
                          const basePrice =
                            prod.standardPurchasePrice > 0
                              ? prod.standardPurchasePrice
                              : prod.standardCostPrice;
                          setPurchaseLines((prev) => [
                            ...prev,
                            {
                              key: `pl-p-${Date.now()}-${prev.length}`,
                              projectId: purchaseBatchProjectId,
                              productId: prod.id,
                              itemCode: prod.productCode,
                              itemName: prod.productName,
                              unitName: prod.isHeading ? '' : (prod.unitName ?? '式'),
                              isHeading: prod.isHeading,
                              quantityStr: prod.isHeading ? '0' : '1',
                              taxCode: prod.isHeading ? 'C' : prod.defaultTaxCode,
                              masterUnitPrice: basePrice,
                              appliedUnitPriceStr: prod.isHeading ? '0' : String(basePrice),
                              remarks: '',
                            },
                          ]);
                        }}
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                      >
                        <option value="">+ 商品マスタから追加...</option>
                        {lookups.products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.productCode} {p.productName}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() =>
                          setPurchaseLines((prev) => [
                            ...prev,
                            newEmptyPurchaseLine(prev.length + 1, purchaseBatchProjectId),
                          ])
                        }
                        className="rounded-lg border border-blue-300 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                      >
                        + 明細行
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPurchaseLines((prev) => [
                            ...prev,
                            {
                              key: `pl-h-${Date.now()}-${prev.length}`,
                              projectId: '',
                              productId: null,
                              itemCode: '',
                              itemName: '【見出し】',
                              unitName: '',
                              isHeading: true,
                              quantityStr: '0',
                              taxCode: 'C',
                              masterUnitPrice: null,
                              appliedUnitPriceStr: '0',
                              remarks: '',
                            },
                          ])
                        }
                        className="rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        + 見出し行
                      </button>
                    </div>
                  )}
                </div>

                <div className="border border-slate-200 rounded-xl overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <tr>
                        <th className="px-2 py-1.5 text-center w-8">#</th>
                        <th className="px-2 py-1.5 text-left w-36">案件参照</th>
                        <th className="px-2 py-1.5 text-left">品名・仕様 *</th>
                        <th className="px-2 py-1.5 text-left w-16">単位</th>
                        <th className="px-2 py-1.5 text-right w-20">数量</th>
                        <th className="px-2 py-1.5 text-right w-28">仕入単価</th>
                        <th className="px-2 py-1.5 text-center w-24">税区分</th>
                        <th className="px-2 py-1.5 text-right w-24">金額</th>
                        <th className="px-2 py-1.5 text-right w-20">消費税</th>
                        <th className="px-2 py-1.5 text-right w-24">行合計</th>
                        <th className="px-2 py-1.5 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {purchaseLines.map((line, idx) => {
                        const calcRow = purchaseCalc.lineResults[idx];
                        return (
                          <tr key={line.key} className={line.isHeading ? 'bg-slate-50' : ''}>
                            <td className="px-2 py-1.5 text-center font-mono">{idx + 1}</td>
                            <td className="px-2 py-1.5">
                              <select
                                disabled={isPurchaseLocked || line.isHeading}
                                value={line.projectId}
                                onChange={(e) =>
                                  setPurchaseLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx ? { ...row, projectId: e.target.value } : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-1 py-1 disabled:bg-slate-100"
                              >
                                <option value="">（なし）</option>
                                {lookups.projects.map((pj) => (
                                  <option key={pj.id} value={pj.id}>
                                    {pj.projectNo} {pj.projectName}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                disabled={isPurchaseLocked}
                                value={line.itemName}
                                onChange={(e) =>
                                  setPurchaseLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx ? { ...row, itemName: e.target.value } : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                disabled={isPurchaseLocked || line.isHeading}
                                value={line.unitName}
                                onChange={(e) =>
                                  setPurchaseLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx ? { ...row, unitName: e.target.value } : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1 disabled:bg-slate-100"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                disabled={isPurchaseLocked || line.isHeading}
                                value={line.quantityStr}
                                onChange={(e) =>
                                  setPurchaseLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx ? { ...row, quantityStr: e.target.value } : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono disabled:bg-slate-100"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <input
                                type="text"
                                disabled={isPurchaseLocked || line.isHeading}
                                value={line.appliedUnitPriceStr}
                                onChange={(e) =>
                                  setPurchaseLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx
                                        ? { ...row, appliedUnitPriceStr: e.target.value }
                                        : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-2 py-1 text-right font-mono disabled:bg-slate-100"
                              />
                            </td>
                            <td className="px-2 py-1.5">
                              <select
                                disabled={isPurchaseLocked || line.isHeading}
                                value={line.taxCode}
                                onChange={(e) =>
                                  setPurchaseLines((prev) =>
                                    prev.map((row, i) =>
                                      i === idx
                                        ? { ...row, taxCode: e.target.value as TaxCode }
                                        : row,
                                    ),
                                  )
                                }
                                className="w-full rounded border border-slate-300 px-1 py-1 disabled:bg-slate-100"
                              >
                                {lookups.taxCodes.map((tc) => (
                                  <option key={tc.taxCode} value={tc.taxCode}>
                                    {tc.taxCode}:{tc.taxName}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono">
                              {calcRow !== undefined ? Number(calcRow.lineAmount).toLocaleString('ja-JP') : '0'}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono text-slate-600">
                              {calcRow !== undefined ? Number(calcRow.lineTax).toLocaleString('ja-JP') : '0'}
                            </td>
                            <td className="px-2 py-1.5 text-right font-mono font-semibold">
                              {calcRow !== undefined ? Number(calcRow.rowTotal).toLocaleString('ja-JP') : '0'}
                            </td>
                            <td className="px-2 py-1.5 text-center">
                              {!isPurchaseLocked && (
                                <button
                                  type="button"
                                  disabled={purchaseLines.length <= 1}
                                  onClick={() =>
                                    setPurchaseLines((prev) => prev.filter((_, i) => i !== idx))
                                  }
                                  className="text-red-600 hover:underline disabled:opacity-30"
                                >
                                  削除
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
                  <div className="flex flex-wrap gap-6 font-mono">
                    <span>税抜計: {formatYen(Number(purchaseCalc.subtotalAmount))}</span>
                    <span>消費税: {formatYen(Number(purchaseCalc.taxTotal))}</span>
                    <span className="font-bold text-blue-800">
                      税込合計: {formatYen(Number(purchaseCalc.totalAmount))}
                    </span>
                  </div>
                  {!isPurchaseLocked && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() =>
                          savePurchaseWithStatus(
                            purchaseStatus === 'P3' ? 'P2' : purchaseStatus,
                          )
                        }
                        className="rounded-lg border border-slate-400 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
                      >
                        仕入保存 ({purchaseStatus === 'P3' ? 'P2' : purchaseStatus})
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => savePurchaseWithStatus('P3')}
                        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        仕入確定・買掛計上 (P3)
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
