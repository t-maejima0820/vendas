import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import {
  exportQuotationsCsv,
  exportQuotationsListPdf,
  type QuotationListFilter,
} from '@/lib/estimates/estimates-service';
import type { QuotationStatus } from '@/lib/estimates/types';
import { MasterDataError } from '@/lib/masters/error-mapper';

function parseExportFilter(url: URL): QuotationListFilter {
  const statusParam = url.searchParams.get('status');
  const status: QuotationStatus | null =
    statusParam === 'Q1' || statusParam === 'Q2' || statusParam === 'Q3' ? statusParam : null;
  const projectLinkParam = url.searchParams.get('projectLink');
  const projectLink =
    projectLinkParam === 'LINKED' || projectLinkParam === 'UNLINKED' ? projectLinkParam : 'ALL';
  const selectedParam = url.searchParams.get('selected');
  const selectedFilter =
    selectedParam === 'SELECTED' || selectedParam === 'UNSELECTED' ? selectedParam : 'ALL';

  return {
    keyword: url.searchParams.get('q'),
    status,
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    projectLink,
    selectedFilter,
  };
}

export const GET = withApiHandler({ requiredFeature: 'estimate' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const format = url.searchParams.get('format') ?? 'csv';
  const filter = parseExportFilter(url);

  if (format === 'pdf') {
    const pdfBytes = await exportQuotationsListPdf(tx, user.tenantId, filter);
    const filename = encodeURIComponent(`見積一覧_${new Date().toISOString().slice(0, 10)}.pdf`);
    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  if (format === 'csv') {
    const csvText = await exportQuotationsCsv(tx, filter);
    const filename = encodeURIComponent(`見積一覧_${new Date().toISOString().slice(0, 10)}.csv`);
    return new NextResponse(csvText, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または pdf を指定してください。');
});
