import type {
  BillingDocumentType,
  BillingListFilter,
  ConfirmBillingItemInput,
  ConfirmBillingRequestInput,
  ReceivableStatus,
} from '@/lib/billing/types';
import { MasterDataError } from '@/lib/masters/error-mapper';

function asOptStr(val: unknown): string | null {
  return typeof val === 'string' && val.trim() !== '' ? val.trim() : null;
}

function asReqStr(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

const VALID_BILLING_DOC_TYPES = new Set<BillingDocumentType>([
  'INVOICE',
  'INVOICE_STANDALONE',
  'INVOICE_COVER',
  'INVOICE_COVER_MEMO_SUM',
  'INVOICE_COVER_DETAIL',
  'FIXED_INVOICE',
]);

export function parseBillingDocumentType(raw: unknown, fallback: BillingDocumentType = 'INVOICE'): BillingDocumentType {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  if (typeof raw === 'string' && VALID_BILLING_DOC_TYPES.has(raw as BillingDocumentType)) {
    return raw as BillingDocumentType;
  }
  throw new MasterDataError(400, 'INVALID_DOCUMENT_TYPE', '請求書帳票種別が不正です。');
}

export function parseConfirmBillingBody(raw: Record<string, unknown>): ConfirmBillingRequestInput {
  const billingDate = asReqStr(raw.billingDate);
  if (billingDate === '') {
    throw new MasterDataError(400, 'BILLING_DATE_REQUIRED', '請求日を指定してください。');
  }

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new MasterDataError(400, 'ITEMS_REQUIRED', '請求確定対象の明細を1件以上指定してください。');
  }

  const items: ConfirmBillingItemInput[] = raw.items.map((entry, idx) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new MasterDataError(400, 'INVALID_ITEM', `${idx + 1}件目のリクエスト形式が不正です。`);
    }
    const obj = entry as Record<string, unknown>;
    const partnerId = asReqStr(obj.partnerId);
    if (!Array.isArray(obj.slipIds) || obj.slipIds.length === 0) {
      throw new MasterDataError(400, 'SLIP_IDS_REQUIRED', `${idx + 1}件目の売上伝票を選択してください。`);
    }
    const slipIds = obj.slipIds.map((sid) => {
      if (typeof sid !== 'string' || sid.trim() === '') {
        throw new MasterDataError(400, 'INVALID_SLIP_ID', '伝票IDの形式が不正です。');
      }
      return sid.trim();
    });

    let templateVariant: '10_ROWS' | '20_ROWS' | undefined;
    if (obj.templateVariant === '10_ROWS' || obj.templateVariant === '20_ROWS') {
      templateVariant = obj.templateVariant;
    } else if (obj.templateVariant !== undefined && obj.templateVariant !== null) {
      throw new MasterDataError(400, 'INVALID_TEMPLATE_VARIANT', 'templateVariant が不正です。');
    }

    return {
      partnerId,
      slipIds,
      paymentDueDate: asOptStr(obj.paymentDueDate),
      documentType: parseBillingDocumentType(obj.documentType, 'INVOICE'),
      templateVariant,
      issueCoverDetail: obj.issueCoverDetail === false ? false : true,
    };
  });

  return {
    billingDate,
    targetPeriodStart: asOptStr(raw.targetPeriodStart),
    targetPeriodEnd: asOptStr(raw.targetPeriodEnd),
    allowUnapproved: raw.allowUnapproved === true,
    items,
  };
}

export function parseBillingListFilterFromUrl(url: URL): BillingListFilter {
  const statusParam = url.searchParams.get('status');
  const status: ReceivableStatus | null =
    statusParam === 'N1' || statusParam === 'N2' || statusParam === 'N3' || statusParam === 'N4'
      ? statusParam
      : null;

  const subParam = url.searchParams.get('isSubscription');
  const isSubscription =
    subParam === 'STANDARD' || subParam === 'SUBSCRIPTION' ? subParam : 'ALL';

  const rawPage = url.searchParams.get('page');
  const rawSize = url.searchParams.get('pageSize');

  return {
    keyword: url.searchParams.get('q'),
    partnerId: url.searchParams.get('partnerId'),
    status,
    isSubscription,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    page: rawPage !== null ? Number(rawPage) : 1,
    pageSize: rawSize !== null ? Number(rawSize) : 25,
  };
}
