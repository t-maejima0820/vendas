import type { DbExecutor } from '@/lib/db/tenant-client';
import { renderMailTargetListPdf } from '@/lib/domain/pdf-renderer';
import { requireFeature } from '@/lib/feature-flags/gate';
import { MasterDataError } from '@/lib/masters/error-mapper';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MailTemplateDto {
  id: string;
  templateNo: number;
  templateName: string;
  subject: string;
  bodyIntro: string | null;
  bodyMain: string | null;
  bodyFooter: string | null;
}

export interface MailPartnerTargetDto {
  partnerId: string;
  partnerCode: string;
  partnerName: string;
  sendMailEnabled: boolean;
  email: string | null;
  estimateMailTo: string | null;
  estimateMailCc: string | null;
  billMailTo: string | null;
  billMailCc: string | null;
  latestDocType: 'BILLING' | 'ESTIMATE' | 'PURCHASE_ORDER' | null;
  latestDocTypeLabel: string;
  latestDocNo: string;
  latestDocTitle: string;
  latestDocDate: string;
  latestDocAmount: number;
}

export interface MailOverviewDto {
  companyName: string;
  companyEmail: string | null;
  companyTel: string | null;
  representativeName: string | null;
  templates: MailTemplateDto[];
  targets: MailPartnerTargetDto[];
  totalCount: number;
  mailEnabledCount: number;
}

export interface MailComposeInput {
  partnerId: string;
  templateId: string;
  docKind?: 'ESTIMATE' | 'BILLING' | 'PURCHASE_ORDER';
  customTo?: string | null;
  customCc?: string | null;
}

export interface MailComposeResultDto {
  partnerId: string;
  partnerName: string;
  templateName: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  mailtoHref: string;
}

function escapeCsvCell(val: string | number | null | undefined): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function applyPlaceholders(
  raw: string,
  vars: Readonly<Record<string, string>>,
): string {
  let out = raw;
  for (const [token, value] of Object.entries(vars)) {
    out = out.split(token).join(value);
  }
  return out;
}

export async function getMailOverview(
  tx: DbExecutor,
  tenantId: string,
  filter: { keyword?: string | null; mailEnabledOnly?: boolean } = {},
): Promise<MailOverviewDto> {
  await requireFeature(tx, tenantId, 'mail');

  const kw =
    filter.keyword !== undefined && filter.keyword !== null && filter.keyword.trim() !== ''
      ? filter.keyword.trim()
      : null;
  const mailEnabledOnly = filter.mailEnabledOnly === true;

  const [tsRows, tmplRows, targetRows] = await Promise.all([
    tx.query<{
      company_name: string;
      email: string | null;
      tel: string | null;
      representative_name: string | null;
    }>(
      `SELECT company_name, email, tel, representative_name
         FROM tenant_settings
        WHERE tenant_id = $1::uuid
        LIMIT 1`,
      [tenantId],
    ),
    tx.query<{
      id: string;
      template_no: number;
      template_name: string;
      subject: string;
      body_intro: string | null;
      body_main: string | null;
      body_footer: string | null;
    }>(
      `SELECT id, template_no, template_name, subject, body_intro, body_main, body_footer
         FROM mail_templates
        WHERE tenant_id = $1::uuid
        ORDER BY template_no ASC`,
      [tenantId],
    ),
    tx.query<{
      id: string;
      partner_code: string;
      partner_name: string;
      send_mail_enabled: boolean;
      email: string | null;
      estimate_mail_to: string | null;
      estimate_mail_cc: string | null;
      bill_mail_to: string | null;
      bill_mail_cc: string | null;
      latest_bill_no: string | null;
      latest_bill_date: string | null;
      latest_bill_amount: string | null;
      latest_est_no: string | null;
      latest_est_name: string | null;
      latest_est_date: string | null;
      latest_est_amount: string | null;
      latest_po_no: string | null;
      latest_po_name: string | null;
      latest_po_date: string | null;
      latest_po_amount: string | null;
    }>(
      `SELECT bp.id, bp.partner_code, bp.partner_name, bp.send_mail_enabled,
              bp.email, bp.estimate_mail_to, bp.estimate_mail_cc,
              bp.bill_mail_to, bp.bill_mail_cc,
              bh.billing_no::text AS latest_bill_no,
              bh.billing_date::text AS latest_bill_date,
              bh.billing_amount::text AS latest_bill_amount,
              q.quotation_no::text AS latest_est_no,
              q.quotation_name AS latest_est_name,
              q.quotation_date::text AS latest_est_date,
              q.total_amount::text AS latest_est_amount,
              po.order_no::text AS latest_po_no,
              po.order_name AS latest_po_name,
              po.order_date::text AS latest_po_date,
              po.total_amount::text AS latest_po_amount
         FROM business_partners bp
         LEFT JOIN LATERAL (
           SELECT billing_no, billing_date, billing_amount
             FROM billing_headers b
            WHERE b.tenant_id = bp.tenant_id AND b.partner_id = bp.id
            ORDER BY b.billing_date DESC, b.billing_no DESC
            LIMIT 1
         ) bh ON true
         LEFT JOIN LATERAL (
           SELECT quotation_no, quotation_name, quotation_date, total_amount
             FROM quotations qq
            WHERE qq.tenant_id = bp.tenant_id AND qq.partner_id = bp.id
            ORDER BY qq.quotation_date DESC, qq.quotation_no DESC
            LIMIT 1
         ) q ON true
         LEFT JOIN LATERAL (
           SELECT order_no, order_name, order_date, total_amount
             FROM purchase_orders poo
            WHERE poo.tenant_id = bp.tenant_id AND poo.supplier_id = bp.id
            ORDER BY poo.order_date DESC, poo.order_no DESC
            LIMIT 1
         ) po ON true
        WHERE bp.tenant_id = $1::uuid
          AND bp.is_deleted = false
          AND ($2::boolean = false OR bp.send_mail_enabled = true)
          AND (
            $3::text IS NULL
            OR bp.partner_code ILIKE '%' || $3 || '%'
            OR bp.partner_name ILIKE '%' || $3 || '%'
            OR COALESCE(bp.email, '') ILIKE '%' || $3 || '%'
          )
        ORDER BY bp.send_mail_enabled DESC, bp.partner_code ASC`,
      [tenantId, mailEnabledOnly, kw],
    ),
  ]);

  const ts = tsRows[0];
  let mailEnabledCount = 0;

  const targets: MailPartnerTargetDto[] = targetRows.map((r) => {
    if (r.send_mail_enabled) {
      mailEnabledCount += 1;
    }

    let latestDocType: MailPartnerTargetDto['latestDocType'] = null;
    let latestDocTypeLabel = '-';
    let latestDocNo = '';
    let latestDocTitle = '';
    let latestDocDate = '';
    let latestDocAmount = 0;

    if (r.latest_bill_no !== null) {
      latestDocType = 'BILLING';
      latestDocTypeLabel = '請求書';
      latestDocNo = r.latest_bill_no;
      latestDocTitle = `請求締日 ${r.latest_bill_date !== null ? r.latest_bill_date.slice(0, 10) : ''}`;
      latestDocDate = r.latest_bill_date !== null ? r.latest_bill_date.slice(0, 10) : '';
      latestDocAmount = r.latest_bill_amount !== null ? Number(r.latest_bill_amount) : 0;
    } else if (r.latest_est_no !== null) {
      latestDocType = 'ESTIMATE';
      latestDocTypeLabel = '見積書';
      latestDocNo = r.latest_est_no;
      latestDocTitle = r.latest_est_name !== null ? r.latest_est_name : '';
      latestDocDate = r.latest_est_date !== null ? r.latest_est_date.slice(0, 10) : '';
      latestDocAmount = r.latest_est_amount !== null ? Number(r.latest_est_amount) : 0;
    } else if (r.latest_po_no !== null) {
      latestDocType = 'PURCHASE_ORDER';
      latestDocTypeLabel = '発注書';
      latestDocNo = r.latest_po_no;
      latestDocTitle = r.latest_po_name !== null ? r.latest_po_name : '';
      latestDocDate = r.latest_po_date !== null ? r.latest_po_date.slice(0, 10) : '';
      latestDocAmount = r.latest_po_amount !== null ? Number(r.latest_po_amount) : 0;
    }

    return {
      partnerId: r.id,
      partnerCode: r.partner_code,
      partnerName: r.partner_name,
      sendMailEnabled: r.send_mail_enabled,
      email: r.email,
      estimateMailTo: r.estimate_mail_to,
      estimateMailCc: r.estimate_mail_cc,
      billMailTo: r.bill_mail_to,
      billMailCc: r.bill_mail_cc,
      latestDocType,
      latestDocTypeLabel,
      latestDocNo,
      latestDocTitle,
      latestDocDate,
      latestDocAmount,
    };
  });

  return {
    companyName: ts !== undefined ? ts.company_name : '',
    companyEmail: ts !== undefined ? ts.email : null,
    companyTel: ts !== undefined ? ts.tel : null,
    representativeName: ts !== undefined ? ts.representative_name : null,
    templates: tmplRows.map((t) => ({
      id: t.id,
      templateNo: Number(t.template_no),
      templateName: t.template_name,
      subject: t.subject,
      bodyIntro: t.body_intro,
      bodyMain: t.body_main,
      bodyFooter: t.body_footer,
    })),
    targets,
    totalCount: targets.length,
    mailEnabledCount,
  };
}

export async function composeMailPreview(
  tx: DbExecutor,
  tenantId: string,
  input: MailComposeInput,
): Promise<MailComposeResultDto> {
  await requireFeature(tx, tenantId, 'mail');

  if (!UUID_REGEX.test(input.partnerId) || !UUID_REGEX.test(input.templateId)) {
    throw new MasterDataError(400, 'INVALID_ID', '取引先IDおよびテンプレートIDの形式が不正です。');
  }

  const overview = await getMailOverview(tx, tenantId, {});
  const target = overview.targets.find((t) => t.partnerId === input.partnerId);
  if (target === undefined) {
    throw new MasterDataError(404, 'PARTNER_NOT_FOUND', '対象の取引先が見つかりません。');
  }
  const tmpl = overview.templates.find((t) => t.id === input.templateId);
  if (tmpl === undefined) {
    throw new MasterDataError(404, 'TEMPLATE_NOT_FOUND', '指定されたメール定型文が見つかりません。');
  }

  const docKind = input.docKind ?? target.latestDocType ?? 'BILLING';
  const defaultTo =
    docKind === 'ESTIMATE'
      ? target.estimateMailTo ?? target.email ?? ''
      : target.billMailTo ?? target.email ?? '';
  const defaultCc =
    docKind === 'ESTIMATE'
      ? target.estimateMailCc ?? ''
      : target.billMailCc ?? '';

  const resolvedTo =
    input.customTo !== undefined && input.customTo !== null && input.customTo.trim() !== ''
      ? input.customTo.trim()
      : defaultTo;
  const resolvedCc =
    input.customCc !== undefined && input.customCc !== null && input.customCc.trim() !== ''
      ? input.customCc.trim()
      : defaultCc;

  const docKindLabel =
    docKind === 'ESTIMATE'
      ? '御見積書'
      : docKind === 'PURCHASE_ORDER'
        ? '発注書'
        : '御請求書';

  const vars: Record<string, string> = {
    '{顧客名}': target.partnerName,
    '{相手先名}': target.partnerName,
    '{取引先名}': target.partnerName,
    '{自社名}': overview.companyName,
    '{帳票種別}': docKindLabel,
    '{帳票番号}': target.latestDocNo !== '' ? target.latestDocNo : '-',
    '{件名}': target.latestDocTitle !== '' ? target.latestDocTitle : docKindLabel,
    '{日付}':
      target.latestDocDate !== ''
        ? target.latestDocDate
        : new Date().toISOString().slice(0, 10),
    '{金額}': `¥${target.latestDocAmount.toLocaleString('ja-JP')}`,
  };

  const subject = applyPlaceholders(tmpl.subject, vars);
  const blocks = [
    `${target.partnerName} 御中`,
    '',
    tmpl.bodyIntro !== null && tmpl.bodyIntro !== ''
      ? applyPlaceholders(tmpl.bodyIntro, vars)
      : null,
    tmpl.bodyMain !== null && tmpl.bodyMain !== ''
      ? applyPlaceholders(tmpl.bodyMain, vars)
      : null,
    target.latestDocNo !== ''
      ? `■ 対象帳票: ${docKindLabel} No.${target.latestDocNo} (${target.latestDocDate}) 金額: ¥${target.latestDocAmount.toLocaleString('ja-JP')}`
      : null,
    tmpl.bodyFooter !== null && tmpl.bodyFooter !== ''
      ? applyPlaceholders(tmpl.bodyFooter, vars)
      : null,
    '',
    '----------------------------------------',
    overview.companyName,
    overview.companyTel !== null ? `TEL: ${overview.companyTel}` : null,
    overview.companyEmail !== null ? `Email: ${overview.companyEmail}` : null,
  ].filter((line): line is string => line !== null);

  const body = blocks.join('\n');
  const queryParts: string[] = [];
  if (resolvedCc !== '') {
    queryParts.push(`cc=${encodeURIComponent(resolvedCc)}`);
  }
  queryParts.push(`subject=${encodeURIComponent(subject)}`);
  queryParts.push(`body=${encodeURIComponent(body)}`);
  const mailtoHref = `mailto:${encodeURIComponent(resolvedTo)}?${queryParts.join('&')}`;

  return {
    partnerId: target.partnerId,
    partnerName: target.partnerName,
    templateName: tmpl.templateName,
    to: resolvedTo,
    cc: resolvedCc,
    subject,
    body,
    mailtoHref,
  };
}

export async function exportMailTargetsCsv(
  tx: DbExecutor,
  tenantId: string,
  filter: { keyword?: string | null; mailEnabledOnly?: boolean } = {},
): Promise<string> {
  const overview = await getMailOverview(tx, tenantId, filter);
  const header = [
    '取引先コード',
    '取引先名',
    'メール送信許可',
    '代表Email',
    '見積To',
    '見積Cc',
    '請求To',
    '請求Cc',
    '最新帳票種別',
    '最新帳票番号',
    '最新帳票日付',
    '最新帳票金額(円)',
  ]
    .map(escapeCsvCell)
    .join(',');

  const lines = overview.targets.map((t) =>
    [
      t.partnerCode,
      t.partnerName,
      t.sendMailEnabled ? '許可' : '無効',
      t.email !== null ? t.email : '',
      t.estimateMailTo !== null ? t.estimateMailTo : '',
      t.estimateMailCc !== null ? t.estimateMailCc : '',
      t.billMailTo !== null ? t.billMailTo : '',
      t.billMailCc !== null ? t.billMailCc : '',
      t.latestDocTypeLabel,
      t.latestDocNo,
      t.latestDocDate,
      t.latestDocAmount,
    ]
      .map(escapeCsvCell)
      .join(','),
  );

  return `\uFEFF${[header, ...lines].join('\r\n')}`;
}

export async function exportMailTargetsPdf(
  tx: DbExecutor,
  tenantId: string,
  filter: { keyword?: string | null; mailEnabledOnly?: boolean } = {},
): Promise<Uint8Array> {
  const overview = await getMailOverview(tx, tenantId, filter);
  const parts: string[] = [];
  if (filter.mailEnabledOnly) parts.push('メール送信許可のみ');
  if (filter.keyword !== undefined && filter.keyword !== null && filter.keyword.trim() !== '') {
    parts.push(`キーワード:${filter.keyword.trim()}`);
  }

  return renderMailTargetListPdf({
    companyName: overview.companyName,
    generatedDate: new Date().toISOString().slice(0, 10),
    filterSummary: parts.length > 0 ? parts.join(' / ') : '全取引先',
    items: overview.targets.map((t) => ({
      partnerCode: t.partnerCode,
      partnerName: t.partnerName,
      sendMailEnabled: t.sendMailEnabled,
      email: t.email !== null ? t.email : '-',
      estimateMailTo: t.estimateMailTo !== null ? t.estimateMailTo : '-',
      billMailTo: t.billMailTo !== null ? t.billMailTo : '-',
      latestDocTypeLabel: t.latestDocTypeLabel,
      latestDocNo: t.latestDocNo,
      latestDocAmount: t.latestDocAmount,
    })),
    totals: {
      count: overview.totalCount,
      mailEnabledCount: overview.mailEnabledCount,
    },
  });
}
