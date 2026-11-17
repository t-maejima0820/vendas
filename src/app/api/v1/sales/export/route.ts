import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  exportSalesListPdf,
  exportSalesProductSummaryPdf,
} from '@/lib/domain/pdf-exports';
import { MasterDataError } from '@/lib/masters/error-mapper';
import {
  exportSalesCsv,
  exportSalesProductSummaryCsv,
} from '@/lib/sales/sales-service';
import type { ApprovalStatus, SalesEntryType, SalesStatus } from '@/lib/sales/types';

export const GET = withApiHandler({}, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') ?? 'SALE';
  const format = url.searchParams.get('format') ?? 'csv';
  const today = new Date().toISOString().slice(0, 10);

  if (format !== 'csv' && format !== 'pdf') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
  }

  if (kind === 'PRODUCT_SUMMARY') {
    const rawEntry = url.searchParams.get('entryTypeFilter');
    const entryTypeFilter: 'ALL' | SalesEntryType =
      rawEntry === 'SALE' || rawEntry === 'ADVANCE' ? rawEntry : 'ALL';
    const filter = {
      entryTypeFilter,
      partnerId: url.searchParams.get('partnerId'),
      dateFrom: url.searchParams.get('dateFrom'),
      dateTo: url.searchParams.get('dateTo'),
      keyword: url.searchParams.get('q'),
    };

    if (format === 'pdf') {
      const pdfBytes = await exportSalesProductSummaryPdf(tx, user.tenantId, filter);
      const filename = encodeURIComponent(`商品別売上立替集計_${today}.pdf`);
      return new NextResponse(Buffer.from(pdfBytes), {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const csv = await exportSalesProductSummaryCsv(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`商品別売上立替集計_${today}.csv`);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const entryType: SalesEntryType = kind === 'ADVANCE' ? 'ADVANCE' : 'SALE';
  const statusParam = url.searchParams.get('status');
  const status: SalesStatus | null =
    statusParam === 'K1' ||
    statusParam === 'K2' ||
    statusParam === 'K3' ||
    statusParam === 'K4' ||
    statusParam === 'K5' ||
    statusParam === 'K6'
      ? statusParam
      : null;
  const approvalParam = url.searchParams.get('approvalStatus');
  const approvalStatus: ApprovalStatus | null =
    approvalParam === '0' ? 0 : approvalParam === '1' ? 1 : approvalParam === '2' ? 2 : null;
  const projectLinkParam = url.searchParams.get('projectLink');
  const projectLink =
    projectLinkParam === 'LINKED' || projectLinkParam === 'UNLINKED' ? projectLinkParam : 'ALL';

  const filter = {
    entryType,
    keyword: url.searchParams.get('q'),
    status,
    approvalStatus,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    projectLink,
  } as const;

  const prefix = entryType === 'ADVANCE' ? '立替金一覧' : '売上一覧';

  if (format === 'pdf') {
    const pdfBytes = await exportSalesListPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`${prefix}_${today}.pdf`);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const csv = await exportSalesCsv(tx, user.tenantId, filter);
  const filename = encodeURIComponent(`${prefix}_${today}.csv`);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
