import AplusClient from '@/app/(dashboard)/aplus/AplusClient';
import { listAplusExports, listAplusImports } from '@/lib/aplus/aplus-service';
import { runWithPageSession } from '@/lib/auth/page-session';
import { FeatureDisabledError, requireFeature } from '@/lib/feature-flags/gate';

function defaultPeriodDates(openingBalanceDate: string): {
  transferDate: string;
  periodStart: string;
  periodEnd: string;
} {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const ym = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
  const today = now.toISOString().slice(0, 10);
  const startCandidate = `${ym}-01`;
  let periodStart = startCandidate;
  if (periodStart <= openingBalanceDate) {
    const parts = openingBalanceDate.split('-');
    const next = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + 1));
    periodStart = next.toISOString().slice(0, 10);
  }
  return {
    transferDate: today > openingBalanceDate ? today : `${ym}-${String(lastDay).padStart(2, '0')}`,
    periodStart,
    periodEnd: `${ym}-${String(lastDay).padStart(2, '0')}`,
  };
}

export default async function AplusPage() {
  const result = await runWithPageSession(async ({ user, tx }) => {
    try {
      await requireFeature(tx, user.tenantId, 'aplus');
      const tsRows = await tx.query<{ company_code: string; opening_balance_date: string }>(
        `SELECT company_code, opening_balance_date::text AS opening_balance_date
           FROM tenant_settings
          WHERE tenant_id = $1::uuid
          LIMIT 1`,
        [user.tenantId],
      );
      const companyCode = tsRows[0] !== undefined ? tsRows[0].company_code : '0000';
      const openingBalanceDate =
        tsRows[0] !== undefined ? tsRows[0].opening_balance_date.slice(0, 10) : '2026-01-01';

      const [initialExports, initialImports] = await Promise.all([
        listAplusExports(tx, user.tenantId, {}),
        listAplusImports(tx, user.tenantId, {}),
      ]);

      return {
        allowed: true as const,
        companyCode,
        openingBalanceDate,
        defaults: defaultPeriodDates(openingBalanceDate),
        initialExports,
        initialImports,
      };
    } catch (err) {
      if (err instanceof FeatureDisabledError) {
        return { allowed: false as const, message: err.message };
      }
      throw err;
    }
  });

  if (!result.allowed) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        <h1 className="text-lg font-bold mb-1">アクセス権限がありません</h1>
        <p>{result.message}</p>
      </div>
    );
  }

  return (
    <AplusClient
      defaultConsignorCode={result.companyCode.padStart(10, '0')}
      openingBalanceDate={result.openingBalanceDate}
      defaultTransferDate={result.defaults.transferDate}
      defaultPeriodStart={result.defaults.periodStart}
      defaultPeriodEnd={result.defaults.periodEnd}
      initialExports={result.initialExports}
      initialImports={result.initialImports}
    />
  );
}
