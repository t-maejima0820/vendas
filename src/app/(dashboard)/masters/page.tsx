import Link from 'next/link';
import { runWithPageSession } from '@/lib/auth/page-session';
import { getMasterLookups } from '@/lib/masters/lookups-service';
import { CODE_MASTER_DOMAINS } from '@/lib/masters/types';

type CountRow = { cnt: number };

export default async function MastersHubPage() {
  const {
    isAdmin,
    partnerCount,
    repCount,
    productCount,
    empCount,
    mailTemplateCount,
    intelligenceCount,
    codeMasterTotal,
    lookups,
  } = await runWithPageSession(async ({ user, tx }) => {
    const [partners, reps, products, employees, mailTemplates, intelligences, codeMasters, lookups] =
      await Promise.all([
        tx.query<CountRow>('SELECT COUNT(*)::int AS cnt FROM business_partners WHERE is_deleted = false', []),
        tx.query<CountRow>('SELECT COUNT(*)::int AS cnt FROM representatives', []),
        tx.query<CountRow>('SELECT COUNT(*)::int AS cnt FROM products WHERE is_deleted = false', []),
        tx.query<CountRow>('SELECT COUNT(*)::int AS cnt FROM employees WHERE is_retired = false', []),
        tx.query<CountRow>('SELECT COUNT(*)::int AS cnt FROM mail_templates', []),
        tx.query<CountRow>('SELECT COUNT(*)::int AS cnt FROM input_intelligences', []),
        tx.query<CountRow>('SELECT COUNT(*)::int AS cnt FROM code_masters', []),
        getMasterLookups(tx),
      ]);
    return {
      isAdmin: user.isAdmin,
      partnerCount: Number(partners[0]?.cnt),
      repCount: Number(reps[0]?.cnt),
      productCount: Number(products[0]?.cnt),
      empCount: Number(employees[0]?.cnt),
      mailTemplateCount: Number(mailTemplates[0]?.cnt),
      intelligenceCount: Number(intelligences[0]?.cnt),
      codeMasterTotal: Number(codeMasters[0]?.cnt),
      lookups,
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900">マスタ管理ハブ（Phase 1 基幹・補助全13テーブル稼働中）</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          基幹4マスタおよび補助・区分マスタ全16ドメインを一元的に登録・保守できます。
        </p>
      </div>

      <div>
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
          基幹マスタ（Phase 1-B）
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Link
            href="/masters/partners"
            className="rounded-xl border border-slate-200 bg-white p-5 hover:border-blue-400 transition-colors shadow-xs"
          >
            <div className="text-xs font-semibold text-blue-700">基幹マスタ 01</div>
            <div className="text-base font-bold text-slate-900 mt-1">取引先マスタ</div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-3">{partnerCount} 件</div>
            <p className="text-xs text-slate-500 mt-2">
              顧客・仕入先・期首残高・暗号化口座・顧問プロファイル
            </p>
          </Link>

          <Link
            href="/masters/representatives"
            className="rounded-xl border border-slate-200 bg-white p-5 hover:border-blue-400 transition-colors shadow-xs"
          >
            <div className="text-xs font-semibold text-blue-700">基幹マスタ 02</div>
            <div className="text-base font-bold text-slate-900 mt-1">代表者マスタ</div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-3">{repCount} 件</div>
            <p className="text-xs text-slate-500 mt-2">
              法人代表者情報・取引先紐付管理（参照中削除防止付き）
            </p>
          </Link>

          <Link
            href="/masters/products"
            className="rounded-xl border border-slate-200 bg-white p-5 hover:border-blue-400 transition-colors shadow-xs"
          >
            <div className="text-xs font-semibold text-blue-700">基幹マスタ 03</div>
            <div className="text-base font-bold text-slate-900 mt-1">商品・工事項目マスタ</div>
            <div className="text-2xl font-bold font-mono text-slate-900 mt-3">{productCount} 件</div>
            <p className="text-xs text-slate-500 mt-2">
              販売/仕入/原価 3単価・税区分・単位・見出し/定額対象
            </p>
          </Link>

          {isAdmin ? (
            <Link
              href="/masters/employees"
              className="rounded-xl border border-slate-200 bg-white p-5 hover:border-blue-400 transition-colors shadow-xs"
            >
              <div className="text-xs font-semibold text-purple-700">基幹マスタ 04（管理者専用）</div>
              <div className="text-base font-bold text-slate-900 mt-1">社員マスタ</div>
              <div className="text-2xl font-bold font-mono text-slate-900 mt-3">{empCount} 名</div>
              <p className="text-xs text-slate-500 mt-2">
                アカウント発行・権限/退職即時失効・PW初期化・ロック解除
              </p>
            </Link>
          ) : (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
              <div className="text-xs font-semibold text-slate-400">基幹マスタ 04（管理者専用）</div>
              <div className="text-base font-bold text-slate-600 mt-1">社員マスタ</div>
              <p className="text-xs text-slate-500 mt-3">
                社員アカウントおよび権限の管理は管理者権限を持つユーザーのみアクセス可能です。
              </p>
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
          補助・区分マスタ（Phase 1-C）
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link
            href="/masters/banks"
            className="rounded-xl border border-slate-200 bg-white p-5 hover:border-blue-400 transition-colors shadow-xs"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-emerald-700">稼働中</span>
              <span className="font-mono text-xs text-slate-500">banks / bank_branches</span>
            </div>
            <div className="text-base font-bold text-slate-900 mt-1">金融機関・支店マスタ</div>
            <div className="text-xl font-bold font-mono text-slate-900 mt-3">
              {lookups.banks.length} 行 / {lookups.bankBranches.length.toLocaleString('ja-JP')} 支店
            </div>
            <p className="text-xs text-slate-500 mt-2">
              銀行登録・配下支店のページネーション検索・子支店あり削除保護
            </p>
          </Link>

          <Link
            href="/masters/codes"
            className="rounded-xl border border-slate-200 bg-white p-5 hover:border-blue-400 transition-colors shadow-xs"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-emerald-700">稼働中</span>
              <span className="font-mono text-xs text-slate-500">units / tax / payment / codes</span>
            </div>
            <div className="text-base font-bold text-slate-900 mt-1">区分・単位・税・支払方法</div>
            <div className="text-xl font-bold font-mono text-slate-900 mt-3">
              {CODE_MASTER_DOMAINS.length} ドメイン / {codeMasterTotal} 件
            </div>
            <p className="text-xs text-slate-500 mt-2">
              汎用区分16種・単位({lookups.units.length})・支払方法({lookups.paymentMethods.length})・税区分({lookups.taxCodes.length})
            </p>
          </Link>

          <Link
            href="/masters/auxiliary"
            className="rounded-xl border border-slate-200 bg-white p-5 hover:border-blue-400 transition-colors shadow-xs"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-emerald-700">稼働中</span>
              <span className="font-mono text-xs text-slate-500">mail / intelligence / tax_offices</span>
            </div>
            <div className="text-base font-bold text-slate-900 mt-1">補助業務マスタ</div>
            <div className="text-xl font-bold font-mono text-slate-900 mt-3">
              定型文 {mailTemplateCount} / 候補 {intelligenceCount} / 税務署 {lookups.taxOffices.length}
            </div>
            <p className="text-xs text-slate-500 mt-2">
              メール定型文プレビュー・明細サジェスト候補・所轄税務署管理
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}
