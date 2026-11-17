import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { downloadAplusExports } from '@/lib/aplus/aplus-service';
import { requireEnv } from '@/lib/env';
import { MasterDataError } from '@/lib/masters/error-mapper';

export const GET = withApiHandler({ requiredFeature: 'aplus' }, async ({ req, user, tx }) => {
  const url = new URL(req.url);
  const transferDate = url.searchParams.get('transferDate') ?? '';
  const format = url.searchParams.get('format') ?? 'csv';

  if (transferDate.trim() === '') {
    throw new MasterDataError(400, 'TRANSFER_DATE_REQUIRED', '振替日 (transferDate) を指定してください。');
  }
  if (format !== 'csv' && format !== 'zengin') {
    throw new MasterDataError(400, 'INVALID_FORMAT', '出力形式は csv または zengin を指定してください。');
  }

  const encKeyHex = requireEnv('FIELD_ENCRYPTION_KEY_HEX');
  const result = await downloadAplusExports(tx, user.tenantId, {
    transferDate,
    format,
    encryptionKeyHex: encKeyHex,
  });

  if (format === 'zengin') {
    const filename = encodeURIComponent(`aplus_zengin_${result.transferDate}.txt`);
    return new NextResponse(result.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const filename = encodeURIComponent(`aplus_export_${result.transferDate}.csv`);
  return new NextResponse(result.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
