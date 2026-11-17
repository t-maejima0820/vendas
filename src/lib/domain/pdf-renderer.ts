import fs from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import {
  decryptSnapshotBankAccounts,
  type DecryptedBankAccount,
  type DocumentSnapshotPayload,
  type DocumentType,
} from '@/lib/domain/snapshots';

const A4_PORTRAIT: readonly [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: readonly [number, number] = [841.89, 595.28];

let cachedFontBytes: Uint8Array | null = null;

function loadJapaneseFontBytes(): Uint8Array {
  if (cachedFontBytes === null) {
    const fontPath = path.join(process.cwd(), 'src', 'assets', 'fonts', 'NotoSansJP-Regular.ttf');
    cachedFontBytes = fs.readFileSync(fontPath);
  }
  return cachedFontBytes;
}

function computeChunkPageCount(totalItems: number, itemsPerPage: number): number {
  if (totalItems <= 0) {
    return 1;
  }
  const rem = totalItems % itemsPerPage;
  const full = (totalItems - rem) / itemsPerPage;
  return rem > 0 ? full + 1 : full;
}

function sanitizePdfText(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '');
}

function formatYen(amount: number): string {
  return amount.toLocaleString('ja-JP');
}

function formatQuantity(qty: number): string {
  if (Number.isInteger(qty)) {
    return qty.toLocaleString('ja-JP');
  }
  const fixed = qty.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return fixed;
}

function isBillingDocumentType(docType: DocumentType): boolean {
  return (
    docType === 'INVOICE' ||
    docType === 'INVOICE_STANDALONE' ||
    docType === 'INVOICE_COVER' ||
    docType === 'INVOICE_COVER_MEMO_SUM' ||
    docType === 'INVOICE_COVER_DETAIL' ||
    docType === 'FIXED_INVOICE'
  );
}

function getBillingTypeDisplayLabel(docType: DocumentType): string {
  switch (docType) {
    case 'INVOICE':
      return '標準請求書';
    case 'INVOICE_STANDALONE':
      return '単独請求書';
    case 'INVOICE_COVER':
      return '請求書（鏡）';
    case 'INVOICE_COVER_MEMO_SUM':
      return '請求書（鏡・備考集約）';
    case 'INVOICE_COVER_DETAIL':
      return '請求書（鏡明細）';
    case 'FIXED_INVOICE':
      return '定額請求書';
    default:
      return docType;
  }
}

function getDocumentTitle(docType: DocumentType): string {
  switch (docType) {
    case 'ESTIMATE':
      return '御 見 積 書';
    case 'ESTIMATE_SUMMARY_COVER':
      return 'まとめ御見積書（鑑）';
    case 'ESTIMATE_SUMMARY_DETAIL':
      return 'まとめ御見積書（明細）';
    case 'PURCHASE_ORDER':
      return '発 注 書';
    case 'DELIVERY_NOTE':
      return '納 品 書';
    case 'DELIVERY_RECEIPT':
      return '受 領 書';
    case 'RECEIPT':
      return '領 収 書';
    case 'INVOICE':
    case 'INVOICE_STANDALONE':
      return '御 請 求 書';
    case 'INVOICE_COVER':
      return '御 請 求 書（鏡）';
    case 'INVOICE_COVER_MEMO_SUM':
      return '御 請 求 書（鏡・備考集約）';
    case 'INVOICE_COVER_DETAIL':
      return '御 請 求 明 細 書';
    case 'FIXED_INVOICE':
      return '御 請 求 書（定額）';
  }
}

function truncateTextToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const clean = sanitizePdfText(text).replace(/\n/g, ' ');
  if (clean.length === 0) {
    return '';
  }
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) {
    return clean;
  }
  const ellipsis = '…';
  const ellipsisWidth = font.widthOfTextAtSize(ellipsis, size);
  let out = '';
  for (const ch of clean) {
    const next = out + ch;
    if (font.widthOfTextAtSize(next, size) + ellipsisWidth > maxWidth) {
      break;
    }
    out = next;
  }
  return out + ellipsis;
}

function wrapTextToLines(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
  maxLines: number,
): string[] {
  const clean = sanitizePdfText(text);
  if (clean.length === 0) {
    return [];
  }
  const paragraphs = clean.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    if (para.length === 0) {
      lines.push('');
      if (lines.length >= maxLines) break;
      continue;
    }
    let current = '';
    for (const ch of para) {
      const candidate = current + ch;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current.length > 0) {
        lines.push(current);
        current = ch;
        if (lines.length >= maxLines) break;
      } else {
        current = candidate;
      }
    }
    if (lines.length >= maxLines) break;
    if (current.length > 0) {
      lines.push(current);
      if (lines.length >= maxLines) break;
    }
  }

  return lines.slice(0, maxLines);
}

function drawAlignedText(
  page: PDFPage,
  text: string,
  opts: {
    x: number;
    y: number;
    width: number;
    size: number;
    font: PDFFont;
    align?: 'left' | 'center' | 'right';
    color?: ReturnType<typeof rgb>;
    paddingX?: number;
  },
): void {
  const pad = opts.paddingX !== undefined ? opts.paddingX : 3;
  const usableWidth = opts.width - pad * 2;
  const fitted = truncateTextToWidth(text, opts.font, opts.size, usableWidth > 4 ? usableWidth : opts.width);
  if (fitted.length === 0) {
    return;
  }
  const textWidth = opts.font.widthOfTextAtSize(fitted, opts.size);
  let drawX = opts.x + pad;
  if (opts.align === 'right') {
    drawX = opts.x + opts.width - pad - textWidth;
  } else if (opts.align === 'center') {
    drawX = opts.x + (opts.width - textWidth) / 2;
  }
  page.drawText(fitted, {
    x: drawX,
    y: opts.y,
    size: opts.size,
    font: opts.font,
    color: opts.color !== undefined ? opts.color : rgb(0.09, 0.11, 0.15),
  });
}

function formatBankAccountLine(acc: DecryptedBankAccount): string {
  const parts: string[] = [];
  if (acc.bankName !== null && acc.bankName !== '') parts.push(acc.bankName);
  if (acc.branchName !== null && acc.branchName !== '') parts.push(acc.branchName);
  if (acc.accountTypeLabel !== null && acc.accountTypeLabel !== '') parts.push(acc.accountTypeLabel);
  if (acc.accountNo !== null && acc.accountNo !== '') parts.push(acc.accountNo);
  if (acc.accountHolder !== null && acc.accountHolder !== '') parts.push(`(${acc.accountHolder})`);
  return parts.join(' ');
}

function parseIssueDateForMetadata(issueDate: string): Date {
  const trimmed = issueDate.trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }
  return new Date('2026-01-01T00:00:00.000Z');
}

function getDocumentIntroText(docType: DocumentType): string {
  switch (docType) {
    case 'PURCHASE_ORDER':
      return '下記の通り発注いたします。';
    case 'DELIVERY_NOTE':
      return '下記の通り納品いたしました。';
    case 'DELIVERY_RECEIPT':
      return '下記の通り正に受領いたしました。';
    case 'INVOICE_COVER_DETAIL':
      return '下記の通り御請求明細を申し上げます。';
    case 'INVOICE':
    case 'INVOICE_STANDALONE':
    case 'INVOICE_COVER':
    case 'INVOICE_COVER_MEMO_SUM':
    case 'FIXED_INVOICE':
      return '下記の通り御請求申し上げます。';
    default:
      return '下記の通り御見積申し上げます。';
  }
}

function getDocumentAmountBoxLabel(docType: DocumentType): string {
  switch (docType) {
    case 'PURCHASE_ORDER':
      return '御発注金額（税込）';
    case 'DELIVERY_NOTE':
      return '御納品金額（税込）';
    case 'DELIVERY_RECEIPT':
      return '御受領金額（税込）';
    case 'INVOICE':
    case 'INVOICE_STANDALONE':
    case 'INVOICE_COVER':
    case 'INVOICE_COVER_MEMO_SUM':
    case 'INVOICE_COVER_DETAIL':
    case 'FIXED_INVOICE':
      return '今回御請求金額（税込）';
    default:
      return '御見積金額（税込）';
  }
}

function drawDocumentPageHeader(
  page: PDFPage,
  font: PDFFont,
  payload: DocumentSnapshotPayload,
  decryptedBanks: readonly DecryptedBankAccount[],
  pageNumber: number,
  totalPages: number,
): void {
  const marginX = 34;
  const contentWidth = A4_PORTRAIT[0] - marginX * 2;
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.35, 0.4, 0.48);
  const border = rgb(0.75, 0.78, 0.84);

  // 最上部メタ行
  page.drawText(sanitizePdfText(`No. ${payload.documentNo}`), {
    x: marginX,
    y: 814,
    size: 8.5,
    font,
    color: ink,
  });
  page.drawText(sanitizePdfText(`発行日: ${payload.issueDate}`), {
    x: marginX + 120,
    y: 814,
    size: 8.5,
    font,
    color: ink,
  });

  if (payload.isReissue && payload.reissueLabel !== null && payload.reissueLabel.trim() !== '') {
    const label = sanitizePdfText(payload.reissueLabel);
    const badgeW = font.widthOfTextAtSize(label, 9) + 14;
    const badgeX = A4_PORTRAIT[0] - marginX - badgeW - 65;
    page.drawRectangle({
      x: badgeX,
      y: 809,
      width: badgeW,
      height: 15,
      borderColor: rgb(0.76, 0.14, 0.14),
      borderWidth: 1,
      color: rgb(1, 0.96, 0.96),
    });
    drawAlignedText(page, label, {
      x: badgeX,
      y: 813,
      width: badgeW,
      size: 8.5,
      font,
      align: 'center',
      color: rgb(0.76, 0.14, 0.14),
      paddingX: 2,
    });
  }

  drawAlignedText(page, `Page ${pageNumber} / ${totalPages}`, {
    x: A4_PORTRAIT[0] - marginX - 60,
    y: 814,
    width: 60,
    size: 8,
    font,
    align: 'right',
    color: muted,
    paddingX: 0,
  });

  // 帳票タイトル
  const title = getDocumentTitle(payload.documentType);
  drawAlignedText(page, title, {
    x: marginX,
    y: 785,
    width: contentWidth,
    size: 17,
    font,
    align: 'center',
    color: ink,
  });
  page.drawLine({
    start: { x: marginX + 165, y: 779 },
    end: { x: marginX + contentWidth - 165, y: 779 },
    thickness: 1.2,
    color: ink,
  });

  // 左ブロック：宛先＆伝票メタ＆税込金額ボックス
  const leftX = marginX;
  const leftW = 278;

  let curLeftY = 760;
  if (payload.recipient.resolvedPostalCode !== null && payload.recipient.resolvedPostalCode !== '') {
    page.drawText(sanitizePdfText(`〒${payload.recipient.resolvedPostalCode}`), {
      x: leftX,
      y: curLeftY,
      size: 8,
      font,
      color: muted,
    });
    curLeftY -= 11;
  }
  if (payload.recipient.resolvedAddress !== null && payload.recipient.resolvedAddress !== '') {
    const addrLines = wrapTextToLines(payload.recipient.resolvedAddress, font, 8, leftW, 2);
    for (const line of addrLines) {
      page.drawText(line, { x: leftX, y: curLeftY, size: 8, font, color: ink });
      curLeftY -= 10;
    }
  }

  const addresseeLine = `${payload.recipient.resolvedAddressee}  ${payload.recipient.honorific}`;
  const addresseeY = curLeftY < 732 ? curLeftY - 2 : 732;
  drawAlignedText(page, addresseeLine, {
    x: leftX,
    y: addresseeY,
    width: leftW,
    size: 11.5,
    font,
    align: 'left',
    color: ink,
    paddingX: 0,
  });
  page.drawLine({
    start: { x: leftX, y: addresseeY - 4 },
    end: { x: leftX + leftW - 10, y: addresseeY - 4 },
    thickness: 0.7,
    color: border,
  });

  page.drawText(getDocumentIntroText(payload.documentType), {
    x: leftX,
    y: addresseeY - 17,
    size: 8,
    font,
    color: muted,
  });

  const projectText =
    payload.header.projectNo !== null
      ? `${payload.header.projectNo} ${payload.header.projectName !== null ? payload.header.projectName : ''}`.trim()
      : '-';

  const isDeliveryDoc =
    payload.documentType === 'DELIVERY_NOTE' || payload.documentType === 'DELIVERY_RECEIPT';
  const isBillingDoc = isBillingDocumentType(payload.documentType);
  const slipDateText =
    payload.lines[0] !== undefined && payload.lines[0].sourceSlipDate !== null
      ? payload.lines[0].sourceSlipDate
      : payload.issueDate;
  const hasAdvanceMark = payload.lines.some((l) => l.advanceMark === 'T');

  const metaRows: Array<[string, string]> = isBillingDoc
    ? [
        ['件名', payload.header.title],
        [
          'お支払期限',
          payload.header.paymentDueDate !== null ? payload.header.paymentDueDate : '-',
        ],
        ['取引先コード', payload.recipient.partnerCode],
        payload.header.showCarryover && payload.header.mirrorSummary !== null
          ? [
              '今回売掛残高',
              `¥ ${formatYen(payload.header.mirrorSummary.closingArBalance)}`,
            ]
          : ['帳票区分', getBillingTypeDisplayLabel(payload.documentType)],
      ]
    : isDeliveryDoc
      ? [
          ['件名', payload.header.title],
          ['案件', projectText],
          ['売上日', slipDateText],
          ['区分', hasAdvanceMark ? '立替金 (T)' : '通常売上'],
        ]
      : payload.documentType === 'PURCHASE_ORDER'
        ? [
            ['件名', payload.header.title],
            ['案件', projectText],
            ['納期', payload.header.deliveryDate !== null ? payload.header.deliveryDate : '-'],
            [
              '納入場所',
              payload.header.deliveryPlace !== undefined && payload.header.deliveryPlace !== null
                ? payload.header.deliveryPlace
                : '-',
            ],
          ]
        : [
            ['件名', payload.header.title],
            ['案件', projectText],
            ['有効期限', payload.header.validityPeriod !== null ? payload.header.validityPeriod : '-'],
            ['納期', payload.header.deliveryDate !== null ? payload.header.deliveryDate : '-'],
          ];

  let metaY = addresseeY - 31;
  for (const [k, v] of metaRows) {
    page.drawText(k, { x: leftX, y: metaY, size: 7.5, font, color: muted });
    drawAlignedText(page, v, {
      x: leftX + 42,
      y: metaY,
      width: leftW - 44,
      size: 8,
      font,
      align: 'left',
      color: ink,
      paddingX: 0,
    });
    metaY -= 12;
  }

  // 合計金額ボックス
  page.drawRectangle({
    x: leftX,
    y: 626,
    width: leftW - 8,
    height: 26,
    color: rgb(0.95, 0.96, 0.98),
    borderColor: rgb(0.25, 0.32, 0.42),
    borderWidth: 1,
  });
  page.drawText(getDocumentAmountBoxLabel(payload.documentType), {
    x: leftX + 6,
    y: 636,
    size: 8.5,
    font,
    color: ink,
  });
  drawAlignedText(page, `¥ ${formatYen(payload.header.totalAmount)} -`, {
    x: leftX + 95,
    y: 634,
    width: leftW - 108,
    size: 13,
    font,
    align: 'right',
    color: ink,
    paddingX: 2,
  });

  // 右ブロック：発行者情報＆T番号＆口座情報
  const rightX = marginX + 292;
  const rightW = contentWidth - 292;
  let ry = 758;

  drawAlignedText(page, payload.issuer.companyName, {
    x: rightX,
    y: ry,
    width: rightW,
    size: 10.5,
    font,
    align: 'left',
    color: ink,
    paddingX: 0,
  });
  ry -= 13;

  if (payload.issuer.invoiceRegistrationNo !== null && payload.issuer.invoiceRegistrationNo !== '') {
    page.drawText(sanitizePdfText(`登録番号: ${payload.issuer.invoiceRegistrationNo}`), {
      x: rightX,
      y: ry,
      size: 7.5,
      font,
      color: ink,
    });
    ry -= 11;
  }

  const repText = [payload.issuer.representativeTitle, payload.issuer.representativeName]
    .filter((v): v is string => v !== null && v.trim() !== '')
    .join(' ');
  if (repText.length > 0) {
    drawAlignedText(page, repText, {
      x: rightX,
      y: ry,
      width: rightW,
      size: 8,
      font,
      align: 'left',
      color: ink,
      paddingX: 0,
    });
    ry -= 11;
  }

  const issuerAddr = [
    payload.issuer.postalCode !== null && payload.issuer.postalCode !== ''
      ? `〒${payload.issuer.postalCode}`
      : null,
    payload.issuer.address1,
    payload.issuer.address2,
  ]
    .filter((v): v is string => v !== null && v.trim() !== '')
    .join(' ');
  if (issuerAddr.length > 0) {
    const addrLines = wrapTextToLines(issuerAddr, font, 7.5, rightW, 2);
    for (const line of addrLines) {
      page.drawText(line, { x: rightX, y: ry, size: 7.5, font, color: muted });
      ry -= 10;
    }
  }

  const telFax = [
    payload.issuer.tel !== null && payload.issuer.tel !== '' ? `TEL: ${payload.issuer.tel}` : null,
    payload.issuer.fax !== null && payload.issuer.fax !== '' ? `FAX: ${payload.issuer.fax}` : null,
  ]
    .filter((v): v is string => v !== null)
    .join('  ');
  if (telFax.length > 0) {
    drawAlignedText(page, telFax, {
      x: rightX,
      y: ry,
      width: rightW,
      size: 7.5,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    });
    ry -= 10;
  }

  if (payload.issuer.email !== null && payload.issuer.email !== '') {
    drawAlignedText(page, `Email: ${payload.issuer.email}`, {
      x: rightX,
      y: ry,
      width: rightW,
      size: 7.5,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    });
    ry -= 10;
  }

  const bankLines = decryptedBanks
    .map((acc) => formatBankAccountLine(acc))
    .filter((line) => line.length > 0);
  if (payload.documentType !== 'PURCHASE_ORDER' && bankLines.length > 0) {
    ry -= 2;
    for (const bLine of bankLines.slice(0, 2)) {
      drawAlignedText(page, `振込先: ${bLine}`, {
        x: rightX,
        y: ry,
        width: rightW,
        size: 7,
        font,
        align: 'left',
        color: ink,
        paddingX: 0,
      });
      ry -= 9.5;
    }
  }

  if (payload.issuer.billingMemo !== null && payload.issuer.billingMemo.trim() !== '') {
    drawAlignedText(page, payload.issuer.billingMemo, {
      x: rightX,
      y: ry,
      width: rightW,
      size: 7,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    });
  }
}

interface TableColumnSpec {
  key: string;
  label: string;
  width: number;
  align: 'left' | 'center' | 'right';
}

const ESTIMATE_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'no', label: 'No', width: 24, align: 'center' },
  { key: 'name', label: '品名・仕様', width: 205, align: 'left' },
  { key: 'qty', label: '数量', width: 50, align: 'right' },
  { key: 'unit', label: '単位', width: 36, align: 'center' },
  { key: 'price', label: '単価', width: 68, align: 'right' },
  { key: 'amount', label: '金額', width: 76, align: 'right' },
  { key: 'tax', label: '税', width: 20, align: 'center' },
  { key: 'remarks', label: '備考', width: 48.28, align: 'left' },
];

const BILLING_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'no', label: 'No', width: 22, align: 'center' },
  { key: 'slipRef', label: '日付/伝票', width: 54, align: 'center' },
  { key: 'name', label: '品名・仕様', width: 174, align: 'left' },
  { key: 'qty', label: '数量', width: 42, align: 'right' },
  { key: 'unit', label: '単位', width: 32, align: 'center' },
  { key: 'price', label: '単価', width: 62, align: 'right' },
  { key: 'amount', label: '金額', width: 70, align: 'right' },
  { key: 'tax', label: '税', width: 20, align: 'center' },
  { key: 'remarks', label: '備考', width: 51.28, align: 'left' },
];

function drawInvoiceMirrorStrip(
  page: PDFPage,
  font: PDFFont,
  mirror: NonNullable<DocumentSnapshotPayload['header']['mirrorSummary']>,
): void {
  const marginX = 34;
  const contentWidth = A4_PORTRAIT[0] - marginX * 2;
  const boxTopY = 618;
  const boxH = 36;
  const colW = contentWidth / 5;
  const border = rgb(0.55, 0.62, 0.72);
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.32, 0.38, 0.46);

  const cells: Array<[string, number, boolean]> = [
    ['前回御請求額', mirror.prevCarriedBalance, false],
    ['当月御入金額', mirror.periodReceiptAmount, false],
    ['差引繰越額', mirror.netCarriedBalance, false],
    ['今回御買上額(税込)', mirror.currentBillingAmount, false],
    ['今回御売掛残高', mirror.closingArBalance, true],
  ];

  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (cell === undefined) continue;
    const [label, amount, highlight] = cell;
    const x = marginX + colW * i;
    page.drawRectangle({
      x,
      y: boxTopY - boxH,
      width: colW,
      height: boxH,
      color: highlight ? rgb(0.91, 0.94, 0.99) : rgb(0.97, 0.98, 0.99),
      borderColor: border,
      borderWidth: 0.7,
    });
    drawAlignedText(page, label, {
      x,
      y: boxTopY - 12,
      width: colW,
      size: 7,
      font,
      align: 'center',
      color: muted,
      paddingX: 2,
    });
    drawAlignedText(page, `¥ ${formatYen(amount)}`, {
      x,
      y: boxTopY - 28,
      width: colW,
      size: highlight ? 9.5 : 8.5,
      font,
      align: 'right',
      color: ink,
      paddingX: 5,
    });
  }
}

function drawEstimateLinesTable(
  page: PDFPage,
  font: PDFFont,
  lines: DocumentSnapshotPayload['lines'],
  rowsPerPage: 10 | 20,
  isBillingDoc: boolean,
  hasMirrorStrip: boolean,
): number {
  const marginX = 34;
  const tableWidth = A4_PORTRAIT[0] - marginX * 2;
  const columns = isBillingDoc ? BILLING_COLUMNS : ESTIMATE_COLUMNS;
  const headerTopY = hasMirrorStrip ? 576 : 616;
  const headerH = 20;
  const rowH = hasMirrorStrip ? (rowsPerPage === 20 ? 16 : 24) : rowsPerPage === 20 ? 18 : 26;
  const ink = rgb(0.08, 0.1, 0.14);
  const border = rgb(0.75, 0.78, 0.84);

  // テーブルヘッダ
  page.drawRectangle({
    x: marginX,
    y: headerTopY - headerH,
    width: tableWidth,
    height: headerH,
    color: rgb(0.92, 0.94, 0.97),
    borderColor: rgb(0.45, 0.5, 0.6),
    borderWidth: 0.8,
  });

  let colX = marginX;
  for (const col of columns) {
    drawAlignedText(page, col.label, {
      x: colX,
      y: headerTopY - headerH + 6,
      width: col.width,
      size: 7.5,
      font,
      align: 'center',
      color: ink,
    });
    colX += col.width;
    if (colX < marginX + tableWidth - 0.5) {
      page.drawLine({
        start: { x: colX, y: headerTopY },
        end: { x: colX, y: headerTopY - headerH },
        thickness: 0.5,
        color: border,
      });
    }
  }

  let curY = headerTopY - headerH;
  for (let i = 0; i < rowsPerPage; i += 1) {
    const line = lines[i];
    const rowBottomY = curY - rowH;
    const isHeading = line !== undefined && line.isHeading;
    const bgColor = isHeading
      ? rgb(0.94, 0.96, 0.99)
      : i % 2 === 1
        ? rgb(0.985, 0.988, 0.994)
        : rgb(1, 1, 1);

    page.drawRectangle({
      x: marginX,
      y: rowBottomY,
      width: tableWidth,
      height: rowH,
      color: bgColor,
      borderColor: border,
      borderWidth: 0.5,
    });

    let cx = marginX;
    for (let c = 0; c < columns.length; c += 1) {
      const col = columns[c];
      if (col === undefined) continue;
      if (c > 0) {
        page.drawLine({
          start: { x: cx, y: curY },
          end: { x: cx, y: rowBottomY },
          thickness: 0.4,
          color: border,
        });
      }
      if (line !== undefined) {
        const textY = rowBottomY + (rowsPerPage === 20 ? 4.8 : 8.5);
        const fontSize = rowsPerPage === 20 ? 7.2 : 8;
        if (isHeading) {
          if (col.key === 'no') {
            drawAlignedText(page, String(line.lineNo), {
              x: cx,
              y: textY,
              width: col.width,
              size: fontSize,
              font,
              align: 'center',
              color: rgb(0.35, 0.4, 0.5),
            });
          } else if (col.key === 'name') {
            drawAlignedText(page, `【${line.itemName}】`, {
              x: cx,
              y: textY,
              width: col.width,
              size: fontSize + 0.5,
              font,
              align: 'left',
              color: rgb(0.08, 0.16, 0.34),
            });
          } else if (col.key === 'remarks' && line.remarks !== null) {
            drawAlignedText(page, line.remarks, {
              x: cx,
              y: textY,
              width: col.width,
              size: fontSize - 0.5,
              font,
              align: 'left',
              color: rgb(0.35, 0.4, 0.5),
            });
          }
        } else {
          let cellVal = '';
          switch (col.key) {
            case 'no':
              cellVal = String(line.lineNo);
              break;
            case 'slipRef': {
              const tPrefix = line.advanceMark === 'T' ? 'T ' : '';
              const datePart =
                line.sourceSlipDate !== null && line.sourceSlipDate.length >= 10
                  ? line.sourceSlipDate.slice(5)
                  : '';
              const noPart = line.sourceSlipNo !== null ? `#${line.sourceSlipNo}` : '';
              cellVal = `${tPrefix}${datePart} ${noPart}`.trim();
              break;
            }
            case 'name': {
              const cap =
                line.capacityLabel !== null && line.capacityLabel !== '' ? ` (${line.capacityLabel})` : '';
              const monthTag =
                line.targetMonthLabel !== null && line.targetMonthLabel !== ''
                  ? ` [${line.targetMonthLabel}]`
                  : '';
              cellVal = `${line.itemName}${cap}${monthTag}`;
              break;
            }
            case 'qty':
              cellVal = formatQuantity(line.quantity);
              break;
            case 'unit':
              cellVal = line.unitName !== null ? line.unitName : '';
              break;
            case 'price':
              cellVal = formatYen(line.appliedUnitPrice);
              break;
            case 'amount':
              cellVal = formatYen(line.lineAmount);
              break;
            case 'tax':
              cellVal = line.taxMarkSymbol;
              break;
            case 'remarks': {
              const adv = line.advanceMark === 'T' ? '[立替T] ' : '';
              const rem = line.remarks !== null ? line.remarks : '';
              cellVal = `${adv}${rem}`.trim();
              break;
            }
          }
          drawAlignedText(page, cellVal, {
            x: cx,
            y: textY,
            width: col.width,
            size: fontSize,
            font,
            align: col.align,
            color: ink,
          });
        }
      }
      cx += col.width;
    }

    curY = rowBottomY;
  }

  return curY;
}

function drawDocumentFooter(
  page: PDFPage,
  font: PDFFont,
  payload: DocumentSnapshotPayload,
  tableBottomY: number,
  isLastDetailPage: boolean,
  inlineAttachments: DocumentSnapshotPayload['attachments'],
): void {
  const marginX = 34;
  const contentWidth = A4_PORTRAIT[0] - marginX * 2;
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.35, 0.4, 0.48);
  const border = rgb(0.7, 0.75, 0.82);

  if (!isLastDetailPage) {
    drawAlignedText(page, '（次頁へ続く）', {
      x: marginX,
      y: tableBottomY - 22,
      width: contentWidth,
      size: 9,
      font,
      align: 'right',
      color: muted,
    });
    return;
  }

  // 税率別内訳（左）＋ 合計ボックス（右）
  const isBillingDoc = isBillingDocumentType(payload.documentType);
  const sumTopY = tableBottomY - 10;
  const sumBoxH = isBillingDoc ? 74 : 66;
  const leftW = 310;
  const rightX = marginX + leftW + 12;
  const rightW = contentWidth - leftW - 12;

  page.drawRectangle({
    x: marginX,
    y: sumTopY - sumBoxH,
    width: leftW,
    height: sumBoxH,
    borderColor: border,
    borderWidth: 0.7,
    color: rgb(0.99, 0.99, 1),
  });
  const tb = payload.header.taxBreakdown;
  page.drawText('税率別内訳（インボイス対応）', {
    x: marginX + 6,
    y: sumTopY - 12,
    size: 7.5,
    font,
    color: muted,
  });
  page.drawText(
    `10%対象 (税抜): ¥${formatYen(tb.rate10Excl)}   消費税: ¥${formatYen(tb.rate10Tax)}`,
    { x: marginX + 8, y: sumTopY - 24, size: 7.5, font, color: ink },
  );
  page.drawText(
    ` 8%対象 (税抜): ¥${formatYen(tb.rate8Excl)}   消費税: ¥${formatYen(tb.rate8Tax)}`,
    { x: marginX + 8, y: sumTopY - 35, size: 7.5, font, color: ink },
  );
  page.drawText(`非課税対象: ¥${formatYen(tb.nonTaxAmount)}`, {
    x: marginX + 8,
    y: sumTopY - 46,
    size: 7.5,
    font,
    color: ink,
  });
  if (isBillingDoc) {
    page.drawText(
      `税端数調整額: ¥${formatYen(payload.header.taxAdjustmentAmount)}  (計算方式: ${payload.header.taxCalcPolicy})`,
      { x: marginX + 8, y: sumTopY - 57, size: 7, font, color: ink },
    );
  }
  page.drawText('税記号: .=10%外税  ※=8%軽減外税  内=内税  非=非課税', {
    x: marginX + 8,
    y: sumTopY - (isBillingDoc ? 68 : 61),
    size: 6.5,
    font,
    color: muted,
  });

  // 右：税抜小計 / 消費税合計 / 税込合計
  const totals: Array<[string, number, boolean]> = isBillingDoc
    ? [
        ['今回税抜小計', payload.header.subtotalAmount, false],
        ['消費税合計', payload.header.taxTotal, false],
        ['今回御請求額', payload.header.totalAmount, true],
      ]
    : [
        ['税抜小計', payload.header.subtotalAmount, false],
        ['消費税合計', payload.header.taxTotal, false],
        ['税込合計', payload.header.totalAmount, true],
      ];
  const rowH = sumBoxH / 3;
  let ty = sumTopY;
  for (const [label, val, highlight] of totals) {
    const rBottom = ty - rowH;
    page.drawRectangle({
      x: rightX,
      y: rBottom,
      width: rightW,
      height: rowH,
      color: highlight ? rgb(0.92, 0.94, 0.98) : rgb(1, 1, 1),
      borderColor: border,
      borderWidth: 0.7,
    });
    page.drawText(label, {
      x: rightX + 8,
      y: rBottom + 6.5,
      size: highlight ? 9 : 8,
      font,
      color: ink,
    });
    drawAlignedText(page, `¥ ${formatYen(val)}`, {
      x: rightX + 75,
      y: rBottom + 6.5,
      width: rightW - 80,
      size: highlight ? 10 : 8.5,
      font,
      align: 'right',
      color: ink,
    });
    ty = rBottom;
  }

  // 備考欄（受領書の場合は右側に受領日・受領印枠を配置）
  const remTopY = sumTopY - sumBoxH - 8;
  const remAvailableH = remTopY - 28;
  const hasInlineAtt = inlineAttachments.length > 0;
  const remH = hasInlineAtt ? Math.min(72, Math.max(42, remAvailableH - 76)) : Math.min(115, Math.max(48, remAvailableH));
  const isReceiptDoc = payload.documentType === 'DELIVERY_RECEIPT';
  const remBoxW = isReceiptDoc ? contentWidth - 188 : contentWidth;

  page.drawRectangle({
    x: marginX,
    y: remTopY - remH,
    width: remBoxW,
    height: remH,
    borderColor: border,
    borderWidth: 0.7,
    color: rgb(1, 1, 1),
  });
  page.drawText('備考', {
    x: marginX + 6,
    y: remTopY - 12,
    size: 7.5,
    font,
    color: muted,
  });
  const remText = payload.header.remarks !== null ? payload.header.remarks : '';
  const remLines = wrapTextToLines(remText, font, 7.5, remBoxW - 14, remH > 65 ? 5 : 3);
  let remLineY = remTopY - 24;
  for (const rLine of remLines) {
    page.drawText(rLine, { x: marginX + 8, y: remLineY, size: 7.5, font, color: ink });
    remLineY -= 10.5;
  }

  if (isReceiptDoc) {
    const signX = marginX + remBoxW + 8;
    const signW = 180;
    page.drawRectangle({
      x: signX,
      y: remTopY - remH,
      width: signW,
      height: remH,
      borderColor: rgb(0.35, 0.4, 0.48),
      borderWidth: 0.8,
      color: rgb(0.99, 0.99, 1),
    });
    page.drawText('受領確認欄', {
      x: signX + 6,
      y: remTopY - 12,
      size: 7.5,
      font,
      color: ink,
    });
    page.drawText('受領日:       年     月     日', {
      x: signX + 8,
      y: remTopY - 26,
      size: 7.5,
      font,
      color: muted,
    });
    page.drawText('ご署名・受領印:', {
      x: signX + 8,
      y: remTopY - 40,
      size: 7.5,
      font,
      color: muted,
    });
  }

  // 添付画像コメント一覧（インライン表示分）
  if (hasInlineAtt) {
    const attTopY = remTopY - remH - 6;
    const attH = Math.max(40, attTopY - 26);
    page.drawRectangle({
      x: marginX,
      y: attTopY - attH,
      width: contentWidth,
      height: attH,
      borderColor: border,
      borderWidth: 0.7,
      color: rgb(0.99, 0.99, 1),
    });
    page.drawText(`添付画像コメント一覧（全${payload.attachments.length}件）`, {
      x: marginX + 6,
      y: attTopY - 12,
      size: 7.5,
      font,
      color: muted,
    });
    let ay = attTopY - 23;
    for (const att of inlineAttachments) {
      if (ay < attTopY - attH + 5) break;
      const commentTxt = att.comment !== null && att.comment.trim() !== '' ? att.comment : '（コメントなし）';
      drawAlignedText(page, `#${att.sortOrder} [${att.originalName}] ${commentTxt}`, {
        x: marginX + 6,
        y: ay,
        width: contentWidth - 12,
        size: 7.2,
        font,
        align: 'left',
        color: ink,
        paddingX: 2,
      });
      ay -= 10.5;
    }
  }
}

function drawAttachmentsContinuationPage(
  page: PDFPage,
  font: PDFFont,
  payload: DocumentSnapshotPayload,
  pageNumber: number,
  totalPages: number,
): void {
  const marginX = 34;
  const contentWidth = A4_PORTRAIT[0] - marginX * 2;
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.35, 0.4, 0.48);
  const border = rgb(0.75, 0.78, 0.84);

  page.drawText(sanitizePdfText(`No. ${payload.documentNo}  発行日: ${payload.issueDate}`), {
    x: marginX,
    y: 814,
    size: 8.5,
    font,
    color: ink,
  });
  drawAlignedText(page, `Page ${pageNumber} / ${totalPages}`, {
    x: A4_PORTRAIT[0] - marginX - 60,
    y: 814,
    width: 60,
    size: 8,
    font,
    align: 'right',
    color: muted,
    paddingX: 0,
  });
  drawAlignedText(page, `添付画像・コメント一覧（${payload.header.title}）`, {
    x: marginX,
    y: 785,
    width: contentWidth,
    size: 13,
    font,
    align: 'center',
    color: ink,
  });

  let curY = 755;
  const rowH = 26;
  page.drawRectangle({
    x: marginX,
    y: curY - 20,
    width: contentWidth,
    height: 20,
    color: rgb(0.92, 0.94, 0.97),
    borderColor: border,
    borderWidth: 0.7,
  });
  drawAlignedText(page, '順', { x: marginX, y: curY - 14, width: 35, size: 8, font, align: 'center', color: ink });
  drawAlignedText(page, 'ファイル名', {
    x: marginX + 35,
    y: curY - 14,
    width: 180,
    size: 8,
    font,
    align: 'left',
    color: ink,
  });
  drawAlignedText(page, 'コメント', {
    x: marginX + 215,
    y: curY - 14,
    width: contentWidth - 215,
    size: 8,
    font,
    align: 'left',
    color: ink,
  });
  curY -= 20;

  for (const att of payload.attachments) {
    if (curY - rowH < 40) break;
    const bottomY = curY - rowH;
    page.drawRectangle({
      x: marginX,
      y: bottomY,
      width: contentWidth,
      height: rowH,
      color: rgb(1, 1, 1),
      borderColor: border,
      borderWidth: 0.5,
    });
    drawAlignedText(page, String(att.sortOrder), {
      x: marginX,
      y: bottomY + 9,
      width: 35,
      size: 8,
      font,
      align: 'center',
      color: ink,
    });
    drawAlignedText(page, att.originalName, {
      x: marginX + 35,
      y: bottomY + 9,
      width: 180,
      size: 8,
      font,
      align: 'left',
      color: ink,
    });
    const commentTxt = att.comment !== null && att.comment.trim() !== '' ? att.comment : '（コメントなし）';
    drawAlignedText(page, commentTxt, {
      x: marginX + 215,
      y: bottomY + 9,
      width: contentWidth - 215,
      size: 8,
      font,
      align: 'left',
      color: ink,
    });
    curY = bottomY;
  }
}

function drawReceiptDocumentPage(
  page: PDFPage,
  font: PDFFont,
  payload: DocumentSnapshotPayload,
): void {
  const marginX = 34;
  const contentWidth = A4_PORTRAIT[0] - marginX * 2;
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.35, 0.4, 0.48);
  const border = rgb(0.45, 0.52, 0.62);
  const lightBorder = rgb(0.75, 0.78, 0.84);

  // 領収書外枠（A4上半〜中段を使った公式領収証レイアウト）
  const boxBottomY = 340;
  const boxTopY = 805;
  const boxH = boxTopY - boxBottomY;
  page.drawRectangle({
    x: marginX,
    y: boxBottomY,
    width: contentWidth,
    height: boxH,
    borderColor: border,
    borderWidth: 1.2,
    color: rgb(1, 1, 1),
  });

  // 上部メタ情報
  page.drawText(sanitizePdfText(`領収書 No. ${payload.documentNo}`), {
    x: marginX + 14,
    y: boxTopY - 22,
    size: 9,
    font,
    color: ink,
  });
  page.drawText(sanitizePdfText(`発行日: ${payload.issueDate}`), {
    x: marginX + 150,
    y: boxTopY - 22,
    size: 9,
    font,
    color: ink,
  });

  if (payload.isReissue && payload.reissueLabel !== null && payload.reissueLabel.trim() !== '') {
    const label = sanitizePdfText(payload.reissueLabel);
    const badgeW = font.widthOfTextAtSize(label, 9) + 14;
    const badgeX = marginX + contentWidth - badgeW - 60;
    page.drawRectangle({
      x: badgeX,
      y: boxTopY - 27,
      width: badgeW,
      height: 15,
      borderColor: rgb(0.76, 0.14, 0.14),
      borderWidth: 1,
      color: rgb(1, 0.96, 0.96),
    });
    drawAlignedText(page, label, {
      x: badgeX,
      y: boxTopY - 23,
      width: badgeW,
      size: 8.5,
      font,
      align: 'center',
      color: rgb(0.76, 0.14, 0.14),
      paddingX: 2,
    });
  }

  drawAlignedText(page, 'Page 1 / 1', {
    x: marginX + contentWidth - 56,
    y: boxTopY - 22,
    width: 44,
    size: 8,
    font,
    align: 'right',
    color: muted,
    paddingX: 0,
  });

  // タイトル
  drawAlignedText(page, getDocumentTitle(payload.documentType), {
    x: marginX,
    y: boxTopY - 52,
    width: contentWidth,
    size: 18,
    font,
    align: 'center',
    color: ink,
  });
  page.drawLine({
    start: { x: marginX + 165, y: boxTopY - 58 },
    end: { x: marginX + contentWidth - 165, y: boxTopY - 58 },
    thickness: 1.2,
    color: ink,
  });

  // 宛名
  const addressee = `${payload.recipient.resolvedAddressee}  ${payload.recipient.honorific}`;
  drawAlignedText(page, addressee, {
    x: marginX + 18,
    y: boxTopY - 88,
    width: contentWidth - 36,
    size: 12.5,
    font,
    align: 'left',
    color: ink,
    paddingX: 0,
  });
  page.drawLine({
    start: { x: marginX + 18, y: boxTopY - 93 },
    end: { x: marginX + 340, y: boxTopY - 93 },
    thickness: 0.8,
    color: border,
  });

  // 領収金額ボックス
  const rs = payload.receiptSpecific;
  const totalReceiptAmount = rs !== undefined ? rs.totalDeposit : payload.header.totalAmount;
  const amtBoxY = boxTopY - 140;
  page.drawRectangle({
    x: marginX + 18,
    y: amtBoxY,
    width: contentWidth - 36,
    height: 36,
    color: rgb(0.95, 0.96, 0.98),
    borderColor: rgb(0.22, 0.28, 0.38),
    borderWidth: 1.2,
  });
  page.drawText('領収金額（税込）', {
    x: marginX + 30,
    y: amtBoxY + 13,
    size: 10,
    font,
    color: ink,
  });
  drawAlignedText(page, `¥ ${formatYen(totalReceiptAmount)} -`, {
    x: marginX + 150,
    y: amtBoxY + 10,
    width: contentWidth - 196,
    size: 17,
    font,
    align: 'right',
    color: ink,
    paddingX: 4,
  });

  // 但し書き
  const tadashiRaw =
    rs !== undefined && rs.tadashi !== null && rs.tadashi.trim() !== ''
      ? rs.tadashi.trim()
      : payload.header.title;
  const tadashiText = `但し、${tadashiRaw}  として上記正に領収いたしました。`;
  drawAlignedText(page, tadashiText, {
    x: marginX + 20,
    y: amtBoxY - 22,
    width: contentWidth - 40,
    size: 9.5,
    font,
    align: 'left',
    color: ink,
    paddingX: 0,
  });
  page.drawLine({
    start: { x: marginX + 20, y: amtBoxY - 27 },
    end: { x: marginX + contentWidth - 20, y: amtBoxY - 27 },
    thickness: 0.6,
    color: lightBorder,
  });

  // 左下エリア：入金手段内訳 ＋ 税率別内訳 ＋ 備考
  const lowerTopY = amtBoxY - 40;
  const leftColX = marginX + 18;
  const leftColW = 265;

  // 入金方法内訳ボックス
  const brkBoxH = 74;
  page.drawRectangle({
    x: leftColX,
    y: lowerTopY - brkBoxH,
    width: leftColW,
    height: brkBoxH,
    borderColor: lightBorder,
    borderWidth: 0.7,
    color: rgb(0.99, 0.99, 1),
  });
  page.drawText('入金内訳', {
    x: leftColX + 8,
    y: lowerTopY - 13,
    size: 7.5,
    font,
    color: muted,
  });
  const breakdowns = rs !== undefined ? rs.paymentBreakdowns : [];
  let py = lowerTopY - 26;
  for (const pb of breakdowns.slice(0, 3)) {
    drawAlignedText(page, `${pb.methodName} (${pb.methodCode})`, {
      x: leftColX + 10,
      y: py,
      width: 120,
      size: 8,
      font,
      align: 'left',
      color: ink,
      paddingX: 0,
    });
    drawAlignedText(page, `¥ ${formatYen(pb.amount)}`, {
      x: leftColX + 130,
      y: py,
      width: leftColW - 140,
      size: 8,
      font,
      align: 'right',
      color: ink,
      paddingX: 0,
    });
    py -= 11.5;
  }
  const billMetaParts: string[] = [];
  if (rs !== undefined && rs.billNo !== null && rs.billNo.trim() !== '') {
    billMetaParts.push(`請求・手形番号: ${rs.billNo}`);
  }
  if (rs !== undefined && rs.billDueDate !== null && rs.billDueDate.trim() !== '') {
    billMetaParts.push(`手形期日: ${rs.billDueDate}`);
  }
  if (billMetaParts.length > 0) {
    drawAlignedText(page, billMetaParts.join('  /  '), {
      x: leftColX + 10,
      y: lowerTopY - brkBoxH + 6,
      width: leftColW - 18,
      size: 7,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    });
  }

  // 税率別内訳ボックス
  const taxBoxTopY = lowerTopY - brkBoxH - 8;
  const taxBoxH = 66;
  page.drawRectangle({
    x: leftColX,
    y: taxBoxTopY - taxBoxH,
    width: leftColW,
    height: taxBoxH,
    borderColor: lightBorder,
    borderWidth: 0.7,
    color: rgb(0.99, 0.99, 1),
  });
  const tb = payload.header.taxBreakdown;
  page.drawText('消費税内訳（インボイス対応）', {
    x: leftColX + 8,
    y: taxBoxTopY - 12,
    size: 7.5,
    font,
    color: muted,
  });
  page.drawText(`10%対象(税抜): ¥${formatYen(tb.rate10Excl)}  消費税: ¥${formatYen(tb.rate10Tax)}`, {
    x: leftColX + 8,
    y: taxBoxTopY - 25,
    size: 7.5,
    font,
    color: ink,
  });
  page.drawText(` 8%対象(税抜): ¥${formatYen(tb.rate8Excl)}  消費税: ¥${formatYen(tb.rate8Tax)}`, {
    x: leftColX + 8,
    y: taxBoxTopY - 37,
    size: 7.5,
    font,
    color: ink,
  });
  page.drawText(
    `非課税対象: ¥${formatYen(tb.nonTaxAmount)}  (税抜合計: ¥${formatYen(payload.header.subtotalAmount)})`,
    {
      x: leftColX + 8,
      y: taxBoxTopY - 49,
      size: 7.5,
      font,
      color: ink,
    },
  );
  if (payload.header.remarks !== null && payload.header.remarks.trim() !== '') {
    drawAlignedText(page, `備考: ${payload.header.remarks}`, {
      x: leftColX + 8,
      y: taxBoxTopY - 61,
      width: leftColW - 14,
      size: 7,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    });
  }

  // 右下エリア：収入印紙枠 ＋ 発行者欄
  const stampSize = 72;
  const stampX = marginX + contentWidth - 18 - stampSize;
  const stampTopY = lowerTopY;
  page.drawRectangle({
    x: stampX,
    y: stampTopY - stampSize,
    width: stampSize,
    height: stampSize,
    borderColor: border,
    borderWidth: 0.9,
    color: rgb(0.99, 0.99, 0.99),
  });
  drawAlignedText(page, '収入印紙', {
    x: stampX,
    y: stampTopY - 32,
    width: stampSize,
    size: 8.5,
    font,
    align: 'center',
    color: muted,
    paddingX: 2,
  });
  if (payload.header.subtotalAmount >= 50000) {
    drawAlignedText(page, '貼付欄(5万円以上)', {
      x: stampX,
      y: stampTopY - 48,
      width: stampSize,
      size: 6.2,
      font,
      align: 'center',
      color: muted,
      paddingX: 2,
    });
  }

  // 発行者情報（印紙枠の下〜左寄りに配置）
  const issuerX = leftColX + leftColW + 14;
  const issuerW = contentWidth - 36 - leftColW - 14;
  let iy = stampTopY - stampSize - 14;
  if (iy > boxBottomY + 72) {
    iy = boxBottomY + 72;
  }

  drawAlignedText(page, payload.issuer.companyName, {
    x: issuerX,
    y: iy,
    width: issuerW,
    size: 10,
    font,
    align: 'left',
    color: ink,
    paddingX: 0,
  });
  iy -= 12;

  if (payload.issuer.invoiceRegistrationNo !== null && payload.issuer.invoiceRegistrationNo !== '') {
    page.drawText(sanitizePdfText(`登録番号: ${payload.issuer.invoiceRegistrationNo}`), {
      x: issuerX,
      y: iy,
      size: 7.5,
      font,
      color: ink,
    });
    iy -= 10.5;
  }

  const repLine = [payload.issuer.representativeTitle, payload.issuer.representativeName]
    .filter((v): v is string => v !== null && v.trim() !== '')
    .join(' ');
  if (repLine !== '') {
    drawAlignedText(page, repLine, {
      x: issuerX,
      y: iy,
      width: issuerW,
      size: 7.5,
      font,
      align: 'left',
      color: ink,
      paddingX: 0,
    });
    iy -= 10.5;
  }

  const addrLine = [
    payload.issuer.postalCode !== null && payload.issuer.postalCode !== ''
      ? `〒${payload.issuer.postalCode}`
      : null,
    payload.issuer.address1,
    payload.issuer.address2,
  ]
    .filter((v): v is string => v !== null && v.trim() !== '')
    .join(' ');
  if (addrLine !== '') {
    drawAlignedText(page, addrLine, {
      x: issuerX,
      y: iy,
      width: issuerW,
      size: 7.2,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    });
    iy -= 10;
  }

  const telStr = [
    payload.issuer.tel !== null && payload.issuer.tel !== '' ? `TEL: ${payload.issuer.tel}` : null,
    payload.issuer.fax !== null && payload.issuer.fax !== '' ? `FAX: ${payload.issuer.fax}` : null,
  ]
    .filter((v): v is string => v !== null)
    .join('  ');
  if (telStr !== '') {
    drawAlignedText(page, telStr, {
      x: issuerX,
      y: iy,
      width: issuerW,
      size: 7.2,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    });
  }
}

/**
 * 保存済みイミュータブルスナップショット（DocumentSnapshotPayload）のみから
 * 決定論的日本語PDFを生成する（現行マスタを一切参照しない）
 */
export async function renderDocumentSnapshotPdf(
  payload: DocumentSnapshotPayload,
  encryptionKeyHex: string,
): Promise<Uint8Array> {
  if (payload.documentType === 'RECEIPT') {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fixedDate = parseIssueDateForMetadata(payload.issueDate);
    pdfDoc.setCreationDate(fixedDate);
    pdfDoc.setModificationDate(fixedDate);
    pdfDoc.setTitle(sanitizePdfText(`領収書 No.${payload.documentNo}`));
    pdfDoc.setProducer('Vendas Web Deterministic PDF Renderer');
    const font = await pdfDoc.embedFont(loadJapaneseFontBytes(), { subset: true });
    const page = pdfDoc.addPage([...A4_PORTRAIT]);
    drawReceiptDocumentPage(page, font, payload);
    return pdfDoc.save({ useObjectStreams: false });
  }

  const decryptedBanks = decryptSnapshotBankAccounts(payload, encryptionKeyHex);
  const rowsPerPage: 10 | 20 = payload.templateVariant === '20_ROWS' ? 20 : 10;

  const detailPageCount = computeChunkPageCount(payload.lines.length, rowsPerPage);
  const maxInlineAttachments = rowsPerPage === 20 ? 2 : 4;
  const needsSeparateAttachmentsPage = payload.attachments.length > maxInlineAttachments;
  const totalPages = detailPageCount + (needsSeparateAttachmentsPage ? 1 : 0);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);

  const fixedDate = parseIssueDateForMetadata(payload.issueDate);
  pdfDoc.setCreationDate(fixedDate);
  pdfDoc.setModificationDate(fixedDate);
  pdfDoc.setTitle(sanitizePdfText(`${payload.documentNo} ${payload.header.title}`));
  pdfDoc.setProducer('Vendas Web Deterministic PDF Renderer');

  const font = await pdfDoc.embedFont(loadJapaneseFontBytes(), { subset: true });
  const isBillingDoc = isBillingDocumentType(payload.documentType);
  const mirrorSummary = payload.header.showCarryover ? payload.header.mirrorSummary : null;
  const hasMirrorStrip = isBillingDoc && mirrorSummary !== null;

  for (let p = 0; p < detailPageCount; p += 1) {
    const page = pdfDoc.addPage([...A4_PORTRAIT]);
    const pageNumber = p + 1;
    const slice = payload.lines.slice(p * rowsPerPage, (p + 1) * rowsPerPage);
    drawDocumentPageHeader(page, font, payload, decryptedBanks, pageNumber, totalPages);
    if (hasMirrorStrip) {
      drawInvoiceMirrorStrip(page, font, mirrorSummary);
    }
    const tableBottomY = drawEstimateLinesTable(
      page,
      font,
      slice,
      rowsPerPage,
      isBillingDoc,
      hasMirrorStrip,
    );
    const isLastDetailPage = p === detailPageCount - 1;
    const inlineAttachments =
      isLastDetailPage && !needsSeparateAttachmentsPage ? payload.attachments : [];
    drawDocumentFooter(page, font, payload, tableBottomY, isLastDetailPage, inlineAttachments);
  }

  if (needsSeparateAttachmentsPage) {
    const attPage = pdfDoc.addPage([...A4_PORTRAIT]);
    drawAttachmentsContinuationPage(attPage, font, payload, totalPages, totalPages);
  }

  return pdfDoc.save({ useObjectStreams: false });
}

export interface EstimateListPdfItem {
  quotationNo: number;
  quotationDate: string;
  status: string;
  isSelected: boolean;
  isAdvanceType: boolean;
  partnerName: string;
  quotationName: string;
  projectName: string | null;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
  costSubtotal: number;
  grossProfitExcl: number;
}

export interface EstimateListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly EstimateListPdfItem[];
  totals: {
    count: number;
    subtotalAmount: number;
    taxTotal: number;
    totalAmount: number;
    costSubtotal: number;
    grossProfitExcl: number;
  };
}

const ESTIMATE_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'no', label: '見積No', width: 42, align: 'right' },
  { key: 'date', label: '見積日', width: 62, align: 'center' },
  { key: 'status', label: '状態', width: 42, align: 'center' },
  { key: 'flags', label: '採/立', width: 32, align: 'center' },
  { key: 'partner', label: '取引先名', width: 120, align: 'left' },
  { key: 'title', label: '件名', width: 136, align: 'left' },
  { key: 'project', label: '案件名', width: 90, align: 'left' },
  { key: 'subtotal', label: '税抜金額', width: 68, align: 'right' },
  { key: 'tax', label: '消費税', width: 56, align: 'right' },
  { key: 'total', label: '税込金額', width: 70, align: 'right' },
  { key: 'profit', label: '予定粗利(税抜)', width: 67.89, align: 'right' },
];

function formatQuotationStatusLabel(status: string): string {
  switch (status) {
    case 'Q1':
      return '見積済';
    case 'Q2':
      return '注文確定';
    case 'Q3':
      return '-';
    default:
      return status;
  }
}

async function renderLandscapeReportPdf(params: {
  docTitle: string;
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  totalCount: number;
  columns: readonly TableColumnSpec[];
  rows: readonly Record<string, string>[];
  summaryText: string;
}): Promise<Uint8Array> {
  const rowsPerPage = 20;
  const totalPages = computeChunkPageCount(params.rows.length, rowsPerPage);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const fixedDate = parseIssueDateForMetadata(params.generatedDate);
  pdfDoc.setCreationDate(fixedDate);
  pdfDoc.setModificationDate(fixedDate);
  pdfDoc.setTitle(sanitizePdfText(params.docTitle));
  pdfDoc.setProducer('Vendas Web Deterministic PDF Renderer');

  const font = await pdfDoc.embedFont(loadJapaneseFontBytes(), { subset: true });

  const marginX = 28;
  const tableWidth = A4_LANDSCAPE[0] - marginX * 2;
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.35, 0.4, 0.48);
  const border = rgb(0.75, 0.78, 0.84);

  for (let p = 0; p < totalPages; p += 1) {
    const page = pdfDoc.addPage([...A4_LANDSCAPE]);
    const pageNo = p + 1;

    page.drawText(sanitizePdfText(params.docTitle), {
      x: marginX,
      y: 562,
      size: 14,
      font,
      color: ink,
    });
    drawAlignedText(
      page,
      `${params.companyName}  |  出力日: ${params.generatedDate}  |  Page ${pageNo} / ${totalPages}`,
      {
        x: marginX + 260,
        y: 564,
        width: tableWidth - 260,
        size: 8.5,
        font,
        align: 'right',
        color: muted,
        paddingX: 0,
      },
    );
    drawAlignedText(page, `条件: ${params.filterSummary}  /  対象件数: ${params.totalCount}件`, {
      x: marginX,
      y: 544,
      width: tableWidth,
      size: 8,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    });

    const headerTopY = 532;
    const headerH = 20;
    const rowH = 20;

    page.drawRectangle({
      x: marginX,
      y: headerTopY - headerH,
      width: tableWidth,
      height: headerH,
      color: rgb(0.92, 0.94, 0.97),
      borderColor: rgb(0.45, 0.5, 0.6),
      borderWidth: 0.8,
    });

    let colX = marginX;
    for (const col of params.columns) {
      drawAlignedText(page, col.label, {
        x: colX,
        y: headerTopY - headerH + 6,
        width: col.width,
        size: 7.8,
        font,
        align: 'center',
        color: ink,
      });
      colX += col.width;
      if (colX < marginX + tableWidth - 0.5) {
        page.drawLine({
          start: { x: colX, y: headerTopY },
          end: { x: colX, y: headerTopY - headerH },
          thickness: 0.5,
          color: border,
        });
      }
    }

    const slice = params.rows.slice(p * rowsPerPage, (p + 1) * rowsPerPage);
    let curY = headerTopY - headerH;

    for (let i = 0; i < slice.length; i += 1) {
      const row = slice[i];
      if (row === undefined) continue;
      const bottomY = curY - rowH;
      page.drawRectangle({
        x: marginX,
        y: bottomY,
        width: tableWidth,
        height: rowH,
        color: i % 2 === 1 ? rgb(0.985, 0.988, 0.994) : rgb(1, 1, 1),
        borderColor: border,
        borderWidth: 0.4,
      });

      let cx = marginX;
      for (let c = 0; c < params.columns.length; c += 1) {
        const col = params.columns[c];
        if (col === undefined) continue;
        if (c > 0) {
          page.drawLine({
            start: { x: cx, y: curY },
            end: { x: cx, y: bottomY },
            thickness: 0.4,
            color: border,
          });
        }
        const rawCell = row[col.key];
        const cellVal = rawCell !== undefined ? rawCell : '';
        drawAlignedText(page, cellVal, {
          x: cx,
          y: bottomY + 6.5,
          width: col.width,
          size: 7.5,
          font,
          align: col.align,
          color: ink,
        });
        cx += col.width;
      }
      curY = bottomY;
    }

    if (p === totalPages - 1) {
      const totY = curY - 24;
      page.drawRectangle({
        x: marginX,
        y: totY,
        width: tableWidth,
        height: 24,
        color: rgb(0.92, 0.94, 0.98),
        borderColor: rgb(0.45, 0.5, 0.6),
        borderWidth: 0.8,
      });
      drawAlignedText(page, params.summaryText, {
        x: marginX + 6,
        y: totY + 8,
        width: tableWidth - 12,
        size: 8.5,
        font,
        align: 'left',
        color: ink,
        paddingX: 4,
      });
    }
  }

  return pdfDoc.save({ useObjectStreams: false });
}

/**
 * 見積一覧PDF（内部管理帳票）を生成する
 * - 旧Access rp_見積一覧 の売上参照バグを是正し、quotations 正規データのみを描画
 */
export async function renderEstimateListPdf(input: EstimateListPdfInput): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    no: String(item.quotationNo),
    date: item.quotationDate,
    status: formatQuotationStatusLabel(item.status),
    flags: `${item.isSelected ? '採' : '-'}/${item.isAdvanceType ? '立' : '-'}`,
    partner: item.partnerName,
    title: item.quotationName,
    project: item.projectName !== null ? item.projectName : '-',
    subtotal: formatYen(item.subtotalAmount),
    tax: formatYen(item.taxTotal),
    total: formatYen(item.totalAmount),
    profit: formatYen(item.grossProfitExcl),
  }));

  return renderLandscapeReportPdf({
    docTitle: '見積一覧表（正規見積管理）',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: ESTIMATE_LIST_COLUMNS,
    rows,
    summaryText: `総合計（${input.totals.count}件）  税抜合計: ¥${formatYen(input.totals.subtotalAmount)}  |  消費税合計: ¥${formatYen(input.totals.taxTotal)}  |  税込合計: ¥${formatYen(input.totals.totalAmount)}  |  予定原価(税抜): ¥${formatYen(input.totals.costSubtotal)}  |  予定粗利(税抜): ¥${formatYen(input.totals.grossProfitExcl)}`,
  });
}

export interface SalesListPdfItem {
  slipNo: number;
  slipDate: string;
  entryTypeLabel: string;
  statusLabel: string;
  approvalLabel: string;
  partnerName: string;
  slipName: string;
  projectName: string | null;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
}

export interface SalesListPdfInput {
  reportTitle: string;
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly SalesListPdfItem[];
  totals: {
    count: number;
    subtotalAmount: number;
    taxTotal: number;
    totalAmount: number;
  };
}

const SALES_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'no', label: '伝票No', width: 46, align: 'right' },
  { key: 'date', label: '売上日', width: 62, align: 'center' },
  { key: 'type', label: '区分', width: 38, align: 'center' },
  { key: 'status', label: '状態', width: 52, align: 'center' },
  { key: 'approval', label: '承認', width: 46, align: 'center' },
  { key: 'partner', label: '取引先名', width: 124, align: 'left' },
  { key: 'title', label: '件名', width: 140, align: 'left' },
  { key: 'project', label: '案件名', width: 88, align: 'left' },
  { key: 'subtotal', label: '税抜金額', width: 66, align: 'right' },
  { key: 'tax', label: '消費税', width: 56, align: 'right' },
  { key: 'total', label: '税込合計', width: 67.89, align: 'right' },
];

/**
 * 売上一覧 / 立替金一覧PDF（旧 rp_売上一覧 / rp_立替金一覧）を生成する
 */
export async function renderSalesListPdf(input: SalesListPdfInput): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    no: String(item.slipNo),
    date: item.slipDate,
    type: item.entryTypeLabel,
    status: item.statusLabel,
    approval: item.approvalLabel,
    partner: item.partnerName,
    title: item.slipName,
    project: item.projectName !== null ? item.projectName : '-',
    subtotal: formatYen(item.subtotalAmount),
    tax: formatYen(item.taxTotal),
    total: formatYen(item.totalAmount),
  }));

  return renderLandscapeReportPdf({
    docTitle: input.reportTitle,
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: SALES_LIST_COLUMNS,
    rows,
    summaryText: `総合計（${input.totals.count}件）  税抜合計: ¥${formatYen(input.totals.subtotalAmount)}  |  消費税合計: ¥${formatYen(input.totals.taxTotal)}  |  税込合計: ¥${formatYen(input.totals.totalAmount)}`,
  });
}

export interface SalesProductSummaryPdfItem {
  entryTypeLabel: string;
  itemCode: string | null;
  itemName: string;
  unitName: string | null;
  taxCode: string;
  slipCount: number;
  totalQuantity: number;
  exclAmount: number;
  taxAmount: number;
  inclAmount: number;
}

export interface SalesProductSummaryPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly SalesProductSummaryPdfItem[];
  totals: {
    rowCount: number;
    exclAmount: number;
    taxAmount: number;
    inclAmount: number;
  };
}

const SALES_PRODUCT_SUMMARY_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'type', label: '区分', width: 42, align: 'center' },
  { key: 'code', label: '商品コード', width: 76, align: 'left' },
  { key: 'name', label: '品名・仕様', width: 220, align: 'left' },
  { key: 'unit', label: '単位', width: 40, align: 'center' },
  { key: 'taxCode', label: '税区分', width: 40, align: 'center' },
  { key: 'slipCount', label: '伝票数', width: 46, align: 'right' },
  { key: 'qty', label: '合計数量', width: 76, align: 'right' },
  { key: 'excl', label: '税抜金額', width: 84, align: 'right' },
  { key: 'tax', label: '消費税額', width: 72, align: 'right' },
  { key: 'incl', label: '税込金額', width: 89.89, align: 'right' },
];

/**
 * 商品別売上・立替金集計PDF（旧 rp_商品別売上立替金集計）を生成する
 */
export async function renderSalesProductSummaryPdf(
  input: SalesProductSummaryPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    type: item.entryTypeLabel,
    code: item.itemCode !== null ? item.itemCode : '-',
    name: item.itemName,
    unit: item.unitName !== null ? item.unitName : '-',
    taxCode: item.taxCode,
    slipCount: String(item.slipCount),
    qty: formatQuantity(item.totalQuantity),
    excl: formatYen(item.exclAmount),
    tax: formatYen(item.taxAmount),
    incl: formatYen(item.inclAmount),
  }));

  return renderLandscapeReportPdf({
    docTitle: '商品別売上・立替金集計表',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.rowCount,
    columns: SALES_PRODUCT_SUMMARY_COLUMNS,
    rows,
    summaryText: `集計品目数（${input.totals.rowCount}行）  税抜合計: ¥${formatYen(input.totals.exclAmount)}  |  消費税合計: ¥${formatYen(input.totals.taxAmount)}  |  税込合計: ¥${formatYen(input.totals.inclAmount)}`,
  });
}

export interface BillingListPdfItem {
  billingNo: number;
  billingDate: string;
  paymentDueDate: string | null;
  partnerName: string;
  isSubscriptionBill: boolean;
  statusLabel: string;
  prevCarriedBalance: number;
  periodReceiptAmount: number;
  netCarriedBalance: number;
  currentExclAmount: number;
  taxTotal: number;
  billingAmount: number;
  closingArBalance: number;
}

export interface BillingListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly BillingListPdfItem[];
  totals: {
    count: number;
    prevCarriedBalance: number;
    periodReceiptAmount: number;
    currentExclAmount: number;
    taxTotal: number;
    billingAmount: number;
    closingArBalance: number;
  };
}

const BILLING_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'no', label: '請求No', width: 40, align: 'right' },
  { key: 'billDate', label: '請求日', width: 56, align: 'center' },
  { key: 'dueDate', label: '支払期限', width: 56, align: 'center' },
  { key: 'partner', label: '取引先名', width: 110, align: 'left' },
  { key: 'kind', label: '区分', width: 36, align: 'center' },
  { key: 'status', label: '状態', width: 42, align: 'center' },
  { key: 'prevCarried', label: '前回繰越', width: 66, align: 'right' },
  { key: 'receipt', label: '当月入金', width: 64, align: 'right' },
  { key: 'netCarried', label: '差引繰越', width: 66, align: 'right' },
  { key: 'excl', label: '今回税抜', width: 64, align: 'right' },
  { key: 'tax', label: '消費税', width: 54, align: 'right' },
  { key: 'total', label: '今回税込', width: 66, align: 'right' },
  { key: 'closing', label: '売掛残高', width: 65.89, align: 'right' },
];

/**
 * 請求一覧PDF（旧 rp_請求一覧）を生成する
 */
export async function renderBillingListPdf(input: BillingListPdfInput): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    no: String(item.billingNo),
    billDate: item.billingDate,
    dueDate: item.paymentDueDate !== null ? item.paymentDueDate : '-',
    partner: item.partnerName,
    kind: item.isSubscriptionBill ? '定額' : '通常',
    status: item.statusLabel,
    prevCarried: formatYen(item.prevCarriedBalance),
    receipt: formatYen(item.periodReceiptAmount),
    netCarried: formatYen(item.netCarriedBalance),
    excl: formatYen(item.currentExclAmount),
    tax: formatYen(item.taxTotal),
    total: formatYen(item.billingAmount),
    closing: formatYen(item.closingArBalance),
  }));

  return renderLandscapeReportPdf({
    docTitle: '請求一覧表（売掛鏡管理）',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: BILLING_LIST_COLUMNS,
    rows,
    summaryText: `合計（${input.totals.count}件） 前回繰越: ¥${formatYen(input.totals.prevCarriedBalance)} | 当月入金: ¥${formatYen(input.totals.periodReceiptAmount)} | 今回請求(税込): ¥${formatYen(input.totals.billingAmount)} | 今回売掛残高: ¥${formatYen(input.totals.closingArBalance)}`,
  });
}

export interface BillingSimpleListPdfItem {
  billingNo: number;
  billingDate: string;
  partnerName: string;
  slipNo: number;
  slipDate: string;
  entryTypeLabel: string;
  slipName: string;
  slipStatusLabel: string;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
}

export interface BillingSimpleListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly BillingSimpleListPdfItem[];
  totals: {
    count: number;
    subtotalAmount: number;
    taxTotal: number;
    totalAmount: number;
  };
}

const BILLING_SIMPLE_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'billNo', label: '請求No', width: 42, align: 'right' },
  { key: 'billDate', label: '請求日', width: 58, align: 'center' },
  { key: 'partner', label: '取引先名', width: 120, align: 'left' },
  { key: 'slipNo', label: '伝票No', width: 44, align: 'right' },
  { key: 'slipDate', label: '売上日', width: 58, align: 'center' },
  { key: 'entryType', label: '区分', width: 36, align: 'center' },
  { key: 'slipName', label: '件名', width: 172, align: 'left' },
  { key: 'slipStatus', label: '状態', width: 48, align: 'center' },
  { key: 'excl', label: '伝票税抜', width: 70, align: 'right' },
  { key: 'tax', label: '消費税', width: 60, align: 'right' },
  { key: 'total', label: '伝票税込', width: 77.89, align: 'right' },
];

/**
 * 請求一覧（簡易）PDF（旧 rp_請求一覧（簡易））を生成する
 */
export async function renderBillingSimpleListPdf(
  input: BillingSimpleListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    billNo: String(item.billingNo),
    billDate: item.billingDate,
    partner: item.partnerName,
    slipNo: String(item.slipNo),
    slipDate: item.slipDate,
    entryType: item.entryTypeLabel,
    slipName: item.slipName,
    slipStatus: item.slipStatusLabel,
    excl: formatYen(item.subtotalAmount),
    tax: formatYen(item.taxTotal),
    total: formatYen(item.totalAmount),
  }));

  return renderLandscapeReportPdf({
    docTitle: '請求一覧表（簡易）',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: BILLING_SIMPLE_LIST_COLUMNS,
    rows,
    summaryText: `対象伝票（${input.totals.count}件） 税抜合計: ¥${formatYen(input.totals.subtotalAmount)} | 消費税合計: ¥${formatYen(input.totals.taxTotal)} | 税込合計: ¥${formatYen(input.totals.totalAmount)}`,
  });
}

export interface BillingDetailListPdfItem {
  billingNo: number;
  billingDate: string;
  partnerName: string;
  slipNo: number;
  lineNo: number;
  itemName: string;
  quantity: number;
  unitName: string | null;
  appliedUnitPrice: number;
  taxCode: string;
  exclAmount: number;
  lineTax: number;
  rowTotal: number;
}

export interface BillingDetailListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly BillingDetailListPdfItem[];
  totals: {
    count: number;
    exclAmount: number;
    lineTax: number;
    rowTotal: number;
  };
}

const BILLING_DETAIL_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'billNo', label: '請求No', width: 40, align: 'right' },
  { key: 'billDate', label: '請求日', width: 56, align: 'center' },
  { key: 'partner', label: '取引先名', width: 100, align: 'left' },
  { key: 'slipNo', label: '伝票No', width: 40, align: 'right' },
  { key: 'lineNo', label: '行', width: 24, align: 'center' },
  { key: 'itemName', label: '品名・仕様', width: 158, align: 'left' },
  { key: 'qty', label: '数量', width: 48, align: 'right' },
  { key: 'unit', label: '単位', width: 32, align: 'center' },
  { key: 'unitPrice', label: '単価', width: 62, align: 'right' },
  { key: 'taxCode', label: '税区分', width: 32, align: 'center' },
  { key: 'excl', label: '税抜額', width: 64, align: 'right' },
  { key: 'tax', label: '消費税', width: 54, align: 'right' },
  { key: 'rowTotal', label: '税込行計', width: 75.89, align: 'right' },
];

/**
 * 請求一覧（詳細）PDF（旧 rp_請求一覧（詳細）— 内税二重加算バグを是正し rowTotal 準拠で出力）
 */
export async function renderBillingDetailListPdf(
  input: BillingDetailListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    billNo: String(item.billingNo),
    billDate: item.billingDate,
    partner: item.partnerName,
    slipNo: String(item.slipNo),
    lineNo: String(item.lineNo),
    itemName: item.itemName,
    qty: formatQuantity(item.quantity),
    unit: item.unitName !== null ? item.unitName : '-',
    unitPrice: formatYen(item.appliedUnitPrice),
    taxCode: item.taxCode,
    excl: formatYen(item.exclAmount),
    tax: formatYen(item.lineTax),
    rowTotal: formatYen(item.rowTotal),
  }));

  return renderLandscapeReportPdf({
    docTitle: '請求一覧表（詳細）',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: BILLING_DETAIL_LIST_COLUMNS,
    rows,
    summaryText: `請求明細（${input.totals.count}行） 税抜合計: ¥${formatYen(input.totals.exclAmount)} | 消費税合計: ¥${formatYen(input.totals.lineTax)} | 税込合計: ¥${formatYen(input.totals.rowTotal)}`,
  });
}

export interface ReceivableListPdfItem {
  partnerCode: string;
  partnerName: string;
  closingDayName: string | null;
  prevCarriedBalance: number;
  periodBillingExcl: number;
  periodBillingTax: number;
  periodBillingIncl: number;
  periodReceiptAmount: number;
  periodNetDelta: number;
  closingArBalance: number;
}

export interface ReceivableListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly ReceivableListPdfItem[];
  totals: {
    count: number;
    prevCarriedBalance: number;
    periodBillingExcl: number;
    periodBillingTax: number;
    periodBillingIncl: number;
    periodReceiptAmount: number;
    periodNetDelta: number;
    closingArBalance: number;
  };
}

const RECEIVABLE_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'code', label: 'コード', width: 50, align: 'left' },
  { key: 'partner', label: '取引先名', width: 130, align: 'left' },
  { key: 'closing', label: '締日', width: 40, align: 'center' },
  { key: 'prevCarried', label: '前回繰越残高', width: 80, align: 'right' },
  { key: 'billExcl', label: '当期請求(税抜)', width: 80, align: 'right' },
  { key: 'billTax', label: '当期消費税', width: 68, align: 'right' },
  { key: 'billIncl', label: '当期請求(税込)', width: 82, align: 'right' },
  { key: 'receipt', label: '当期入金額', width: 82, align: 'right' },
  { key: 'delta', label: '当期増減', width: 84, align: 'right' },
  { key: 'closingAr', label: '当期末売掛残高', width: 89.89, align: 'right' },
];

/**
 * 売掛一覧PDF（旧 rp_売掛一覧）を生成する
 */
export async function renderReceivableListPdf(
  input: ReceivableListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    code: item.partnerCode,
    partner: item.partnerName,
    closing: item.closingDayName !== null ? item.closingDayName : '-',
    prevCarried: formatYen(item.prevCarriedBalance),
    billExcl: formatYen(item.periodBillingExcl),
    billTax: formatYen(item.periodBillingTax),
    billIncl: formatYen(item.periodBillingIncl),
    receipt: formatYen(item.periodReceiptAmount),
    delta: formatYen(item.periodNetDelta),
    closingAr: formatYen(item.closingArBalance),
  }));

  return renderLandscapeReportPdf({
    docTitle: '売掛一覧表（売掛残高推移）',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: RECEIVABLE_LIST_COLUMNS,
    rows,
    summaryText: `合計（${input.totals.count}社） 前回繰越: ¥${formatYen(input.totals.prevCarriedBalance)} | 当期請求(税込): ¥${formatYen(input.totals.periodBillingIncl)} | 当期入金: ¥${formatYen(input.totals.periodReceiptAmount)} | 当期末残高: ¥${formatYen(input.totals.closingArBalance)}`,
  });
}

export interface PurchaseOrderListPdfItem {
  orderNo: number;
  orderDate: string;
  statusLabel: string;
  supplierName: string;
  orderName: string;
  projectName: string | null;
  deliveryDate: string | null;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
}

export interface PurchaseOrderListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly PurchaseOrderListPdfItem[];
  totals: {
    count: number;
    subtotalAmount: number;
    taxTotal: number;
    totalAmount: number;
  };
}

const PURCHASE_ORDER_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'orderNo', label: '発注No', width: 44, align: 'right' },
  { key: 'orderDate', label: '発注日', width: 58, align: 'center' },
  { key: 'status', label: '状態', width: 48, align: 'center' },
  { key: 'supplier', label: '仕入先名', width: 122, align: 'left' },
  { key: 'title', label: '件名', width: 144, align: 'left' },
  { key: 'project', label: '案件名', width: 102, align: 'left' },
  { key: 'delivery', label: '納期', width: 62, align: 'left' },
  { key: 'subtotal', label: '税抜金額', width: 68, align: 'right' },
  { key: 'tax', label: '消費税', width: 58, align: 'right' },
  { key: 'total', label: '税込金額', width: 79.89, align: 'right' },
];

/**
 * 発注一覧PDFを生成する
 */
export async function renderPurchaseOrderListPdf(
  input: PurchaseOrderListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    orderNo: String(item.orderNo),
    orderDate: item.orderDate,
    status: item.statusLabel,
    supplier: item.supplierName,
    title: item.orderName,
    project: item.projectName !== null ? item.projectName : '-',
    delivery: item.deliveryDate !== null ? item.deliveryDate : '-',
    subtotal: formatYen(item.subtotalAmount),
    tax: formatYen(item.taxTotal),
    total: formatYen(item.totalAmount),
  }));

  return renderLandscapeReportPdf({
    docTitle: '発注一覧表',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: PURCHASE_ORDER_LIST_COLUMNS,
    rows,
    summaryText: `合計（${input.totals.count}件） 税抜合計: ¥${formatYen(input.totals.subtotalAmount)} | 消費税合計: ¥${formatYen(input.totals.taxTotal)} | 税込合計: ¥${formatYen(input.totals.totalAmount)}`,
  });
}

export interface PurchaseListPdfItem {
  purchaseNo: number;
  purchaseDate: string;
  statusLabel: string;
  orderNo: number | null;
  supplierName: string;
  purchaseName: string;
  payableStatusLabel: string;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
}

export interface PurchaseListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly PurchaseListPdfItem[];
  totals: {
    count: number;
    subtotalAmount: number;
    taxTotal: number;
    totalAmount: number;
  };
}

const PURCHASE_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'purchaseNo', label: '仕入No', width: 46, align: 'right' },
  { key: 'purchaseDate', label: '仕入日', width: 60, align: 'center' },
  { key: 'status', label: '状態', width: 48, align: 'center' },
  { key: 'orderNo', label: '発注No', width: 46, align: 'right' },
  { key: 'supplier', label: '仕入先名', width: 130, align: 'left' },
  { key: 'title', label: '件名', width: 170, align: 'left' },
  { key: 'payable', label: '買掛状態', width: 72, align: 'center' },
  { key: 'subtotal', label: '税抜金額', width: 72, align: 'right' },
  { key: 'tax', label: '消費税', width: 60, align: 'right' },
  { key: 'total', label: '税込金額', width: 81.89, align: 'right' },
];

/**
 * 仕入一覧PDFを生成する
 */
export async function renderPurchaseListPdf(
  input: PurchaseListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    purchaseNo: String(item.purchaseNo),
    purchaseDate: item.purchaseDate,
    status: item.statusLabel,
    orderNo: item.orderNo !== null ? String(item.orderNo) : '-',
    supplier: item.supplierName,
    title: item.purchaseName,
    payable: item.payableStatusLabel,
    subtotal: formatYen(item.subtotalAmount),
    tax: formatYen(item.taxTotal),
    total: formatYen(item.totalAmount),
  }));

  return renderLandscapeReportPdf({
    docTitle: '仕入一覧表',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: PURCHASE_LIST_COLUMNS,
    rows,
    summaryText: `合計（${input.totals.count}件） 税抜合計: ¥${formatYen(input.totals.subtotalAmount)} | 消費税合計: ¥${formatYen(input.totals.taxTotal)} | 税込合計: ¥${formatYen(input.totals.totalAmount)}`,
  });
}

export interface PayableListPdfItem {
  partnerCode: string;
  partnerName: string;
  closingDayName: string | null;
  prevCarriedBalance: number;
  periodPayableExcl: number;
  periodPayableTax: number;
  periodPayableIncl: number;
  periodPaymentAmount: number;
  periodNetDelta: number;
  closingApBalance: number;
}

export interface PayableListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly PayableListPdfItem[];
  totals: {
    count: number;
    prevCarriedBalance: number;
    periodPayableExcl: number;
    periodPayableTax: number;
    periodPayableIncl: number;
    periodPaymentAmount: number;
    periodNetDelta: number;
    closingApBalance: number;
  };
}

const PAYABLE_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'code', label: 'コード', width: 50, align: 'left' },
  { key: 'supplier', label: '仕入先名', width: 130, align: 'left' },
  { key: 'closing', label: '締日', width: 40, align: 'center' },
  { key: 'prevCarried', label: '前回繰越残高', width: 80, align: 'right' },
  { key: 'payExcl', label: '当期仕入(税抜)', width: 80, align: 'right' },
  { key: 'payTax', label: '当期消費税', width: 68, align: 'right' },
  { key: 'payIncl', label: '当期仕入(税込)', width: 82, align: 'right' },
  { key: 'paid', label: '当期支払額', width: 82, align: 'right' },
  { key: 'delta', label: '当期増減', width: 84, align: 'right' },
  { key: 'closingAp', label: '当期末買掛残高', width: 89.89, align: 'right' },
];

/**
 * 買掛一覧PDF（旧 rp_買掛一覧）を生成する
 */
export async function renderPayableListPdf(
  input: PayableListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    code: item.partnerCode,
    supplier: item.partnerName,
    closing: item.closingDayName !== null ? item.closingDayName : '-',
    prevCarried: formatYen(item.prevCarriedBalance),
    payExcl: formatYen(item.periodPayableExcl),
    payTax: formatYen(item.periodPayableTax),
    payIncl: formatYen(item.periodPayableIncl),
    paid: formatYen(item.periodPaymentAmount),
    delta: formatYen(item.periodNetDelta),
    closingAp: formatYen(item.closingApBalance),
  }));

  return renderLandscapeReportPdf({
    docTitle: '買掛一覧表（買掛残高推移）',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: PAYABLE_LIST_COLUMNS,
    rows,
    summaryText: `合計（${input.totals.count}社） 前回繰越: ¥${formatYen(input.totals.prevCarriedBalance)} | 当期仕入(税込): ¥${formatYen(input.totals.periodPayableIncl)} | 当期支払: ¥${formatYen(input.totals.periodPaymentAmount)} | 当期末買掛残高: ¥${formatYen(input.totals.closingApBalance)}`,
  });
}

export interface SupplierPaymentListPdfItem {
  paymentNo: number;
  paymentDate: string;
  supplierName: string;
  methodsSummary: string;
  deductionTotal: number;
  paymentSubtotal: number;
  totalPayment: number;
  billNo: string | null;
  note: string | null;
}

export interface SupplierPaymentListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly SupplierPaymentListPdfItem[];
  totals: {
    count: number;
    paymentSubtotal: number;
    deductionTotal: number;
    totalPayment: number;
  };
}

const SUPPLIER_PAYMENT_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'paymentNo', label: '支払No', width: 48, align: 'right' },
  { key: 'paymentDate', label: '支払日', width: 60, align: 'center' },
  { key: 'supplier', label: '仕入先名', width: 134, align: 'left' },
  { key: 'methods', label: '支払方法内訳', width: 120, align: 'left' },
  { key: 'deductions', label: '控除額計', width: 70, align: 'right' },
  { key: 'payAmt', label: '支払額計', width: 74, align: 'right' },
  { key: 'total', label: '総充当額', width: 76, align: 'right' },
  { key: 'billNo', label: '対象仕入No', width: 58, align: 'left' },
  { key: 'note', label: '摘要・備考', width: 145.89, align: 'left' },
];

/**
 * 支払一覧PDFを生成する
 */
export async function renderSupplierPaymentListPdf(
  input: SupplierPaymentListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    paymentNo: String(item.paymentNo),
    paymentDate: item.paymentDate,
    supplier: item.supplierName,
    methods: item.methodsSummary,
    deductions: formatYen(item.deductionTotal),
    payAmt: formatYen(item.paymentSubtotal),
    total: formatYen(item.totalPayment),
    billNo: item.billNo !== null ? item.billNo : '-',
    note: item.note !== null ? item.note : '-',
  }));

  return renderLandscapeReportPdf({
    docTitle: '支払一覧表',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: SUPPLIER_PAYMENT_LIST_COLUMNS,
    rows,
    summaryText: `合計（${input.totals.count}件） 支払額計: ¥${formatYen(input.totals.paymentSubtotal)} | 控除額計: ¥${formatYen(input.totals.deductionTotal)} | 総充当額: ¥${formatYen(input.totals.totalPayment)}`,
  });
}

export interface ProjectListPdfItem {
  projectNo: number;
  projectDate: string;
  statusLabel: string;
  partnerName: string;
  projectName: string;
  sitePlace: string | null;
  contractAmount: number;
  budgetTotal: number;
  actualCostTotal: number;
  actualGrossProfit: number;
  actualGrossMarginPercent: string;
  isOverBudget: boolean;
}

export interface ProjectListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  costBasisLabel: string;
  items: readonly ProjectListPdfItem[];
  totals: {
    count: number;
    contractAmount: number;
    budgetTotal: number;
    actualCostTotal: number;
    budgetGrossProfit: number;
    actualGrossProfit: number;
  };
}

const PROJECT_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'projectNo', label: '案件番号', width: 68, align: 'right' },
  { key: 'projectDate', label: '受注日', width: 56, align: 'center' },
  { key: 'status', label: '状態', width: 52, align: 'center' },
  { key: 'partner', label: '取引先名', width: 106, align: 'left' },
  { key: 'title', label: '案件名・現場', width: 146, align: 'left' },
  { key: 'contract', label: '契約金額', width: 72, align: 'right' },
  { key: 'budget', label: '実行予算', width: 70, align: 'right' },
  { key: 'actualCost', label: '実績原価', width: 70, align: 'right' },
  { key: 'profit', label: '実績粗利額', width: 74, align: 'right' },
  { key: 'margin', label: '粗利率 / 超過', width: 71.89, align: 'right' },
];

/**
 * 工事（案件）一覧PDF（旧 rp_工事一覧）を生成する
 */
export async function renderProjectListPdf(
  input: ProjectListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    projectNo: String(item.projectNo),
    projectDate: item.projectDate,
    status: item.statusLabel,
    partner: item.partnerName,
    title:
      item.sitePlace !== null && item.sitePlace !== ''
        ? `${item.projectName} (${item.sitePlace})`
        : item.projectName,
    contract: formatYen(item.contractAmount),
    budget: formatYen(item.budgetTotal),
    actualCost: formatYen(item.actualCostTotal),
    profit: formatYen(item.actualGrossProfit),
    margin: `${item.actualGrossMarginPercent}%${item.isOverBudget ? ' [超過]' : ''}`,
  }));

  return renderLandscapeReportPdf({
    docTitle: `工事（案件）一覧表（原価基準: ${input.costBasisLabel}）`,
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: PROJECT_LIST_COLUMNS,
    rows,
    summaryText: `合計（${input.totals.count}件） 契約計: ¥${formatYen(input.totals.contractAmount)} | 予算計: ¥${formatYen(input.totals.budgetTotal)} | 実績原価計: ¥${formatYen(input.totals.actualCostTotal)} | 実績粗利計: ¥${formatYen(input.totals.actualGrossProfit)}`,
  });
}

export interface ProjectCostListPdfItem {
  entryDate: string;
  projectNo: number;
  projectName: string;
  categoryLabel: string;
  slipTitle: string;
  statusLabel: string;
  lineCount: number;
  subtotalAmount: number;
  taxTotal: number;
  totalAmount: number;
}

export interface ProjectCostListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly ProjectCostListPdfItem[];
  totals: {
    count: number;
    subtotalAmount: number;
    taxTotal: number;
    totalAmount: number;
  };
}

const PROJECT_COST_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'entryDate', label: '計上日', width: 58, align: 'center' },
  { key: 'projectNo', label: '案件番号', width: 70, align: 'right' },
  { key: 'projectName', label: '案件名', width: 140, align: 'left' },
  { key: 'category', label: '費目区分', width: 62, align: 'center' },
  { key: 'title', label: '原価伝票件名', width: 156, align: 'left' },
  { key: 'status', label: '状態', width: 48, align: 'center' },
  { key: 'lines', label: '明細', width: 36, align: 'right' },
  { key: 'subtotal', label: '税抜原価', width: 74, align: 'right' },
  { key: 'tax', label: '消費税', width: 64, align: 'right' },
  { key: 'total', label: '税込原価', width: 77.89, align: 'right' },
];

/**
 * 原価一覧表PDFを生成する
 */
export async function renderProjectCostListPdf(
  input: ProjectCostListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    entryDate: item.entryDate,
    projectNo: String(item.projectNo),
    projectName: item.projectName,
    category: item.categoryLabel,
    title: item.slipTitle,
    status: item.statusLabel,
    lines: `${item.lineCount}行`,
    subtotal: formatYen(item.subtotalAmount),
    tax: formatYen(item.taxTotal),
    total: formatYen(item.totalAmount),
  }));

  return renderLandscapeReportPdf({
    docTitle: '原価一覧表（6費目別・案件別）',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: PROJECT_COST_LIST_COLUMNS,
    rows,
    summaryText: `合計（${input.totals.count}件） 税抜原価計: ¥${formatYen(input.totals.subtotalAmount)} | 消費税計: ¥${formatYen(input.totals.taxTotal)} | 税込原価計: ¥${formatYen(input.totals.totalAmount)}`,
  });
}

export interface ProjectLedgerPdfCategoryRow {
  categoryLabel: string;
  budgetAmount: number;
  actualExclAmount: number;
  actualInclAmount: number;
  actualEvalAmount: number;
  varianceAmount: number;
  consumptionRatePercent: string;
  isOverBudget: boolean;
}

export interface ProjectLedgerPdfCostLine {
  entryDate: string;
  categoryLabel: string;
  slipTitle: string;
  itemName: string;
  quantity: number;
  unitName: string | null;
  appliedUnitPrice: number;
  lineAmount: number;
  lineTax: number;
  lineTotal: number;
  remarks: string | null;
}

export interface ProjectLedgerPdfInput {
  companyName: string;
  generatedDate: string;
  projectNo: number;
  projectName: string;
  projectDate: string;
  statusLabel: string;
  subStatusName: string | null;
  orderKindName: string | null;
  partnerCode: string;
  partnerName: string;
  sitePlace: string | null;
  periodStartDate: string | null;
  periodEndDate: string | null;
  salesEmployeeName: string | null;
  siteEmployeeName: string | null;
  costBasisLabel: string;
  contractSubtotal: number;
  contractTax: number;
  contractTotal: number;
  salesRecordedExcl: number;
  salesRecordedIncl: number;
  budgetTotal: number;
  actualCostExclTotal: number;
  actualCostInclTotal: number;
  actualCostEvalTotal: number;
  budgetVarianceTotal: number;
  budgetGrossProfit: number;
  actualGrossProfit: number;
  actualGrossMarginPercent: string;
  categories: readonly ProjectLedgerPdfCategoryRow[];
  costLines: readonly ProjectLedgerPdfCostLine[];
}

const LEDGER_CATEGORY_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'cat', label: '費目区分', width: 85, align: 'left' },
  { key: 'budget', label: '実行予算', width: 92, align: 'right' },
  { key: 'excl', label: '実績(税抜)', width: 92, align: 'right' },
  { key: 'incl', label: '実績(税込)', width: 92, align: 'right' },
  { key: 'variance', label: '予算残額', width: 92, align: 'right' },
  { key: 'rate', label: '消化率', width: 82.28, align: 'right' },
];

const LEDGER_COST_LINE_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'date', label: '計上日', width: 52, align: 'center' },
  { key: 'cat', label: '費目', width: 48, align: 'center' },
  { key: 'item', label: '件名 / 品名・作業内容', width: 156, align: 'left' },
  { key: 'qty', label: '数量', width: 38, align: 'right' },
  { key: 'unit', label: '単位', width: 28, align: 'center' },
  { key: 'price', label: '単価', width: 54, align: 'right' },
  { key: 'excl', label: '金額', width: 56, align: 'right' },
  { key: 'tax', label: '消費税', width: 44, align: 'right' },
  { key: 'total', label: '行税込計', width: 59.28, align: 'right' },
];

/**
 * 工事台帳PDF（旧 rp_工事台帳：案件ヘッダ・収支サマリ・6費目予実・原価明細一覧）を生成する
 */
export async function renderProjectLedgerPdf(
  input: ProjectLedgerPdfInput,
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const fixedDate = parseIssueDateForMetadata(input.generatedDate);
  pdfDoc.setCreationDate(fixedDate);
  pdfDoc.setModificationDate(fixedDate);
  pdfDoc.setTitle(sanitizePdfText(`工事台帳 No.${input.projectNo} ${input.projectName}`));
  pdfDoc.setProducer('Vendas Web Deterministic PDF Renderer');

  const font = await pdfDoc.embedFont(loadJapaneseFontBytes(), { subset: true });
  const marginX = 30;
  const contentWidth = A4_PORTRAIT[0] - marginX * 2;
  const ink = rgb(0.08, 0.1, 0.14);
  const muted = rgb(0.35, 0.4, 0.48);
  const border = rgb(0.75, 0.78, 0.84);

  const linesPerFirstPage = 14;
  const linesPerNextPage = 32;
  const remainingCount = Math.max(0, input.costLines.length - linesPerFirstPage);
  const extraPages = remainingCount > 0 ? computeChunkPageCount(remainingCount, linesPerNextPage) : 0;
  const totalPages = 1 + extraPages;

  // 1ページ目: ヘッダ + 収支サマリ + 6費目予実表 + 原価明細(先頭14行)
  const page1 = pdfDoc.addPage([...A4_PORTRAIT]);
  page1.drawText(sanitizePdfText('工 事 台 帳'), {
    x: marginX,
    y: 804,
    size: 16,
    font,
    color: ink,
  });
  drawAlignedText(
    page1,
    `${input.companyName} | 出力日: ${input.generatedDate} | Page 1 / ${totalPages}`,
    {
      x: marginX + 160,
      y: 806,
      width: contentWidth - 160,
      size: 8.2,
      font,
      align: 'right',
      color: muted,
      paddingX: 0,
    },
  );

  // 案件情報ボックス
  const infoBoxTop = 794;
  const infoBoxH = 68;
  page1.drawRectangle({
    x: marginX,
    y: infoBoxTop - infoBoxH,
    width: contentWidth,
    height: infoBoxH,
    color: rgb(0.98, 0.99, 1),
    borderColor: border,
    borderWidth: 0.8,
  });
  drawAlignedText(
    page1,
    `案件番号: ${input.projectNo}    案件名: ${input.projectName}`,
    {
      x: marginX + 8,
      y: infoBoxTop - 16,
      width: contentWidth - 16,
      size: 10,
      font,
      align: 'left',
      color: ink,
      paddingX: 0,
    },
  );
  drawAlignedText(
    page1,
    `発注元: ${input.partnerCode} ${input.partnerName}    状態: ${input.statusLabel}${input.subStatusName !== null ? ` (${input.subStatusName})` : ''}    種別: ${input.orderKindName !== null ? input.orderKindName : '-'}`,
    {
      x: marginX + 8,
      y: infoBoxTop - 32,
      width: contentWidth - 16,
      size: 8,
      font,
      align: 'left',
      color: ink,
      paddingX: 0,
    },
  );
  const periodStr =
    input.periodStartDate !== null || input.periodEndDate !== null
      ? `${input.periodStartDate !== null ? input.periodStartDate : '-'} 〜 ${input.periodEndDate !== null ? input.periodEndDate : '-'}`
      : '-';
  drawAlignedText(
    page1,
    `現場場所: ${input.sitePlace !== null ? input.sitePlace : '-'}    受注日: ${input.projectDate}    工期: ${periodStr}`,
    {
      x: marginX + 8,
      y: infoBoxTop - 46,
      width: contentWidth - 16,
      size: 8,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    },
  );
  drawAlignedText(
    page1,
    `営業担当: ${input.salesEmployeeName !== null ? input.salesEmployeeName : '-'}    現場担当: ${input.siteEmployeeName !== null ? input.siteEmployeeName : '-'}    評価基準: ${input.costBasisLabel}`,
    {
      x: marginX + 8,
      y: infoBoxTop - 60,
      width: contentWidth - 16,
      size: 8,
      font,
      align: 'left',
      color: muted,
      paddingX: 0,
    },
  );

  // 収支サマリカード（6列）
  const kpiTop = 716;
  const kpiH = 38;
  const kpiW = contentWidth / 6;
  const kpiItems: Array<{ label: string; value: string; highlight?: boolean }> = [
    { label: `請負契約(${input.costBasisLabel})`, value: `¥${formatYen(input.costBasisLabel === '税抜' ? input.contractSubtotal : input.contractTotal)}` },
    { label: '売上計上済(税込)', value: `¥${formatYen(input.salesRecordedIncl)}` },
    { label: '実行予算合計', value: `¥${formatYen(input.budgetTotal)}` },
    { label: `実績原価(${input.costBasisLabel})`, value: `¥${formatYen(input.actualCostEvalTotal)}` },
    { label: '予定粗利額', value: `¥${formatYen(input.budgetGrossProfit)}` },
    {
      label: `実績粗利(${input.actualGrossMarginPercent}%)`,
      value: `¥${formatYen(input.actualGrossProfit)}`,
      highlight: true,
    },
  ];
  for (let i = 0; i < kpiItems.length; i += 1) {
    const kpi = kpiItems[i];
    if (kpi === undefined) continue;
    const kx = marginX + kpiW * i;
    page1.drawRectangle({
      x: kx,
      y: kpiTop - kpiH,
      width: kpiW,
      height: kpiH,
      color: kpi.highlight ? rgb(0.92, 0.95, 1) : rgb(0.97, 0.98, 0.99),
      borderColor: border,
      borderWidth: 0.6,
    });
    drawAlignedText(page1, kpi.label, {
      x: kx,
      y: kpiTop - 13,
      width: kpiW,
      size: 6.8,
      font,
      align: 'center',
      color: muted,
      paddingX: 2,
    });
    drawAlignedText(page1, kpi.value, {
      x: kx,
      y: kpiTop - 30,
      width: kpiW,
      size: 8.5,
      font,
      align: 'right',
      color: ink,
      paddingX: 4,
    });
  }

  // 6費目予実対比テーブル
  page1.drawText('【6費目 予実対比表】', {
    x: marginX,
    y: 660,
    size: 9,
    font,
    color: ink,
  });

  const catTopY = 654;
  const catHeaderH = 17;
  const catRowH = 16;
  page1.drawRectangle({
    x: marginX,
    y: catTopY - catHeaderH,
    width: contentWidth,
    height: catHeaderH,
    color: rgb(0.92, 0.94, 0.97),
    borderColor: rgb(0.45, 0.5, 0.6),
    borderWidth: 0.7,
  });
  let cxCat = marginX;
  for (const col of LEDGER_CATEGORY_COLUMNS) {
    drawAlignedText(page1, col.label, {
      x: cxCat,
      y: catTopY - catHeaderH + 5,
      width: col.width,
      size: 7.5,
      font,
      align: 'center',
      color: ink,
    });
    cxCat += col.width;
  }

  let curCatY = catTopY - catHeaderH;
  for (let i = 0; i < input.categories.length; i += 1) {
    const cat = input.categories[i];
    if (cat === undefined) continue;
    const botY = curCatY - catRowH;
    page1.drawRectangle({
      x: marginX,
      y: botY,
      width: contentWidth,
      height: catRowH,
      color: cat.isOverBudget
        ? rgb(1, 0.95, 0.95)
        : i % 2 === 1
          ? rgb(0.985, 0.988, 0.994)
          : rgb(1, 1, 1),
      borderColor: border,
      borderWidth: 0.4,
    });
    const rowCells: Record<string, string> = {
      cat: cat.categoryLabel,
      budget: formatYen(cat.budgetAmount),
      excl: formatYen(cat.actualExclAmount),
      incl: formatYen(cat.actualInclAmount),
      variance: formatYen(cat.varianceAmount),
      rate: `${cat.consumptionRatePercent}%${cat.isOverBudget ? ' 超過' : ''}`,
    };
    let rx = marginX;
    for (const col of LEDGER_CATEGORY_COLUMNS) {
      drawAlignedText(page1, rowCells[col.key] ?? '', {
        x: rx,
        y: botY + 4.5,
        width: col.width,
        size: 7.4,
        font,
        align: col.align,
        color: cat.isOverBudget && col.key === 'rate' ? rgb(0.75, 0.12, 0.12) : ink,
      });
      rx += col.width;
    }
    curCatY = botY;
  }

  // 合計行
  const catTotBotY = curCatY - 18;
  page1.drawRectangle({
    x: marginX,
    y: catTotBotY,
    width: contentWidth,
    height: 18,
    color: rgb(0.93, 0.95, 0.98),
    borderColor: rgb(0.45, 0.5, 0.6),
    borderWidth: 0.6,
  });
  const totCells: Record<string, string> = {
    cat: '合計',
    budget: formatYen(input.budgetTotal),
    excl: formatYen(input.actualCostExclTotal),
    incl: formatYen(input.actualCostInclTotal),
    variance: formatYen(input.budgetVarianceTotal),
    rate: '-',
  };
  let txX = marginX;
  for (const col of LEDGER_CATEGORY_COLUMNS) {
    drawAlignedText(page1, totCells[col.key] ?? '', {
      x: txX,
      y: catTotBotY + 5,
      width: col.width,
      size: 7.5,
      font,
      align: col.align,
      color: ink,
    });
    txX += col.width;
  }

  // 原価明細一覧テーブル（1ページ目）
  const drawCostLinesSection = (
    targetPage: PDFPage,
    startTopY: number,
    slice: readonly ProjectLedgerPdfCostLine[],
    emptyMessage: boolean,
  ) => {
    targetPage.drawText(`【原価明細一覧】（全${input.costLines.length}明細）`, {
      x: marginX,
      y: startTopY + 6,
      size: 9,
      font,
      color: ink,
    });
    const hH = 17;
    const rH = 17;
    targetPage.drawRectangle({
      x: marginX,
      y: startTopY - hH,
      width: contentWidth,
      height: hH,
      color: rgb(0.92, 0.94, 0.97),
      borderColor: rgb(0.45, 0.5, 0.6),
      borderWidth: 0.7,
    });
    let hx = marginX;
    for (const col of LEDGER_COST_LINE_COLUMNS) {
      drawAlignedText(targetPage, col.label, {
        x: hx,
        y: startTopY - hH + 5,
        width: col.width,
        size: 7.2,
        font,
        align: 'center',
        color: ink,
      });
      hx += col.width;
    }

    let cy = startTopY - hH;
    if (slice.length === 0 && emptyMessage) {
      const bot = cy - rH;
      targetPage.drawRectangle({
        x: marginX,
        y: bot,
        width: contentWidth,
        height: rH,
        borderColor: border,
        borderWidth: 0.4,
      });
      drawAlignedText(targetPage, '（登録された原価明細はありません）', {
        x: marginX,
        y: bot + 5,
        width: contentWidth,
        size: 7.5,
        font,
        align: 'center',
        color: muted,
      });
      return;
    }

    for (let i = 0; i < slice.length; i += 1) {
      const ln = slice[i];
      if (ln === undefined) continue;
      const bot = cy - rH;
      targetPage.drawRectangle({
        x: marginX,
        y: bot,
        width: contentWidth,
        height: rH,
        color: i % 2 === 1 ? rgb(0.985, 0.988, 0.994) : rgb(1, 1, 1),
        borderColor: border,
        borderWidth: 0.4,
      });
      const cells: Record<string, string> = {
        date: ln.entryDate,
        cat: ln.categoryLabel,
        item: `${ln.slipTitle} / ${ln.itemName}`,
        qty: formatQuantity(ln.quantity),
        unit: ln.unitName !== null ? ln.unitName : '-',
        price: formatYen(ln.appliedUnitPrice),
        excl: formatYen(ln.lineAmount),
        tax: formatYen(ln.lineTax),
        total: formatYen(ln.lineTotal),
      };
      let lx = marginX;
      for (const col of LEDGER_COST_LINE_COLUMNS) {
        drawAlignedText(targetPage, cells[col.key] ?? '', {
          x: lx,
          y: bot + 5,
          width: col.width,
          size: 7,
          font,
          align: col.align,
          color: ink,
        });
        lx += col.width;
      }
      cy = bot;
    }
  };

  const firstSlice = input.costLines.slice(0, linesPerFirstPage);
  drawCostLinesSection(page1, catTotBotY - 26, firstSlice, input.costLines.length === 0);

  for (let ep = 0; ep < extraPages; ep += 1) {
    const p = pdfDoc.addPage([...A4_PORTRAIT]);
    const pageNo = ep + 2;
    p.drawText(sanitizePdfText(`工 事 台 帳  No.${input.projectNo} ${input.projectName}`), {
      x: marginX,
      y: 806,
      size: 11,
      font,
      color: ink,
    });
    drawAlignedText(p, `Page ${pageNo} / ${totalPages}`, {
      x: marginX + contentWidth - 80,
      y: 806,
      width: 80,
      size: 8.2,
      font,
      align: 'right',
      color: muted,
      paddingX: 0,
    });
    const offset = linesPerFirstPage + ep * linesPerNextPage;
    drawCostLinesSection(
      p,
      776,
      input.costLines.slice(offset, offset + linesPerNextPage),
      false,
    );
  }

  return pdfDoc.save({ useObjectStreams: false });
}

export interface StockListPdfItem {
  productCode: string;
  productName: string;
  categoryName: string;
  unitName: string;
  isStockManaged: boolean;
  purchasedQty: number;
  soldQty: number;
  costConsumedQty: number;
  stockQuantity: number;
  standardCostPrice: number;
  stockValuation: number;
}

export interface StockListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly StockListPdfItem[];
  totals: {
    count: number;
    managedCount: number;
    totalStockQuantity: number;
    totalValuation: number;
  };
}

const STOCK_LIST_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'code', label: '商品コード', width: 68, align: 'left' },
  { key: 'name', label: '商品名', width: 170, align: 'left' },
  { key: 'category', label: '分類', width: 70, align: 'left' },
  { key: 'unit', label: '単位', width: 38, align: 'center' },
  { key: 'managed', label: '在庫管理', width: 46, align: 'center' },
  { key: 'purchased', label: '仕入累計', width: 64, align: 'right' },
  { key: 'sold', label: '売上累計', width: 64, align: 'right' },
  { key: 'consumed', label: '原価消費', width: 64, align: 'right' },
  { key: 'stockQty', label: '現在在庫数', width: 66, align: 'right' },
  { key: 'unitCost', label: '基準原価', width: 64, align: 'right' },
  { key: 'valuation', label: '在庫評価額', width: 71.89, align: 'right' },
];

/**
 * 在庫一覧表PDFを生成する
 */
export async function renderStockListPdf(input: StockListPdfInput): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    code: item.productCode,
    name: item.productName,
    category: item.categoryName,
    unit: item.unitName,
    managed: item.isStockManaged ? '管理中' : '対象外',
    purchased: formatQuantity(item.purchasedQty),
    sold: formatQuantity(item.soldQty),
    consumed: formatQuantity(item.costConsumedQty),
    stockQty: formatQuantity(item.stockQuantity),
    unitCost: formatYen(item.standardCostPrice),
    valuation: formatYen(item.stockValuation),
  }));

  return renderLandscapeReportPdf({
    docTitle: '在庫・商品受払一覧表',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: STOCK_LIST_COLUMNS,
    rows,
    summaryText: `対象商品 ${input.totals.count}件（在庫管理対象 ${input.totals.managedCount}件） | 在庫評価額合計: ¥${formatYen(input.totals.totalValuation)}`,
  });
}

export interface CustomAnalyticsPdfItem {
  groupKey: string;
  groupLabel: string;
  subLabel: string;
  recordCount: number;
  salesExcl: number;
  salesIncl: number;
  advanceIncl: number;
  costOrPurchaseExcl: number;
  grossProfit: number;
  grossMarginPercent: string;
}

export interface CustomAnalyticsPdfInput {
  companyName: string;
  generatedDate: string;
  dimensionLabel: string;
  filterSummary: string;
  items: readonly CustomAnalyticsPdfItem[];
  totals: {
    count: number;
    salesExcl: number;
    salesIncl: number;
    advanceIncl: number;
    costOrPurchaseExcl: number;
    grossProfit: number;
    grossMarginPercent: string;
  };
}

const CUSTOM_ANALYTICS_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'code', label: '区分/コード', width: 76, align: 'left' },
  { key: 'label', label: '集計軸名称', width: 170, align: 'left' },
  { key: 'sub', label: '補足', width: 100, align: 'left' },
  { key: 'cnt', label: '件数', width: 42, align: 'right' },
  { key: 'salesExcl', label: '売上(税抜)', width: 76, align: 'right' },
  { key: 'salesIncl', label: '売上(税込)', width: 76, align: 'right' },
  { key: 'advanceIncl', label: '立替計(税込)', width: 72, align: 'right' },
  { key: 'cost', label: '原価・仕入(税抜)', width: 78, align: 'right' },
  { key: 'profit', label: '粗利額(税抜基準)', width: 95.89, align: 'right' },
];

/**
 * カスタム多軸集計（取引先別・項目別・担当者別・月別）PDFを生成する
 */
export async function renderCustomAnalyticsPdf(
  input: CustomAnalyticsPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    code: item.groupKey,
    label: item.groupLabel,
    sub: item.subLabel,
    cnt: String(item.recordCount),
    salesExcl: formatYen(item.salesExcl),
    salesIncl: formatYen(item.salesIncl),
    advanceIncl: formatYen(item.advanceIncl),
    cost: formatYen(item.costOrPurchaseExcl),
    profit: `${formatYen(item.grossProfit)} (${item.grossMarginPercent}%)`,
  }));

  return renderLandscapeReportPdf({
    docTitle: `カスタム集計表（${input.dimensionLabel}）`,
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: CUSTOM_ANALYTICS_COLUMNS,
    rows,
    summaryText: `売上(税抜): ¥${formatYen(input.totals.salesExcl)} | 立替(税込): ¥${formatYen(input.totals.advanceIncl)} | 原価・仕入: ¥${formatYen(input.totals.costOrPurchaseExcl)} | 粗利: ¥${formatYen(input.totals.grossProfit)} (${input.totals.grossMarginPercent}%)`,
  });
}

export interface MailTargetListPdfItem {
  partnerCode: string;
  partnerName: string;
  sendMailEnabled: boolean;
  email: string;
  estimateMailTo: string;
  billMailTo: string;
  latestDocTypeLabel: string;
  latestDocNo: string;
  latestDocAmount: number;
}

export interface MailTargetListPdfInput {
  companyName: string;
  generatedDate: string;
  filterSummary: string;
  items: readonly MailTargetListPdfItem[];
  totals: {
    count: number;
    mailEnabledCount: number;
  };
}

const MAIL_TARGET_COLUMNS: readonly TableColumnSpec[] = [
  { key: 'code', label: '取引先CD', width: 58, align: 'left' },
  { key: 'name', label: '取引先名', width: 150, align: 'left' },
  { key: 'enabled', label: '送信許可', width: 46, align: 'center' },
  { key: 'email', label: '代表Email', width: 120, align: 'left' },
  { key: 'estTo', label: '見積宛先To', width: 120, align: 'left' },
  { key: 'billTo', label: '請求宛先To', width: 120, align: 'left' },
  { key: 'doc', label: '最新帳票', width: 100, align: 'left' },
  { key: 'amount', label: '最新帳票金額', width: 71.89, align: 'right' },
];

/**
 * メール送付対象・宛先一覧PDFを生成する
 */
export async function renderMailTargetListPdf(
  input: MailTargetListPdfInput,
): Promise<Uint8Array> {
  const rows = input.items.map((item) => ({
    code: item.partnerCode,
    name: item.partnerName,
    enabled: item.sendMailEnabled ? '許可' : '無効',
    email: item.email,
    estTo: item.estimateMailTo,
    billTo: item.billMailTo,
    doc: item.latestDocNo !== '' ? `${item.latestDocTypeLabel} #${item.latestDocNo}` : '-',
    amount: item.latestDocNo !== '' ? formatYen(item.latestDocAmount) : '-',
  }));

  return renderLandscapeReportPdf({
    docTitle: '帳票メール送信対象・宛先一覧表',
    companyName: input.companyName,
    generatedDate: input.generatedDate,
    filterSummary: input.filterSummary,
    totalCount: input.totals.count,
    columns: MAIL_TARGET_COLUMNS,
    rows,
    summaryText: `取引先計 ${input.totals.count}件（メール送付許可: ${input.totals.mailEnabledCount}件）`,
  });
}
