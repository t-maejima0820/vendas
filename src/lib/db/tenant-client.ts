import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { SessionContext } from '@/lib/auth/session';
import { requireEnv } from '@/lib/env';

export function createPgPoolConfig(connectionString: string): PoolConfig {
  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  return {
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30_000,
  };
}

export interface DbExecutor {
  readonly supportsMultiStatementSimpleQuery?: boolean;
  query<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

export class DatabaseExecutionError extends Error {
  constructor(message: string, readonly causeError?: unknown) {
    super(message);
    this.name = 'DatabaseExecutionError';
  }
}

let cachedPool: Pool | null = null;

function getPgPool(): Pool {
  if (cachedPool === null) {
    cachedPool = new Pool(createPgPoolConfig(requireEnv('DATABASE_URL')));
  }
  return cachedPool;
}

/**
 * 外部注入済みトランザクション／テスト用クライアント（PG / PGlite 互換）で
 * テナントコンテキストを強制設定しつつ単一ACIDトランザクションを実行する
 */
export async function withExecutorTenantContext<T>(
  executor: DbExecutor,
  context: { tenantId: string; employeeId?: string | null; role?: 'vendas_app' | 'postgres' },
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  const roleName = context.role === undefined ? 'vendas_app' : context.role;
  if (roleName !== 'vendas_app' && roleName !== 'postgres') {
    throw new DatabaseExecutionError(`未許可のDBロール指定です: ${String(roleName)}`);
  }

  if (executor.supportsMultiStatementSimpleQuery === true) {
    if (roleName === 'vendas_app') {
      await executor.query('BEGIN; SET LOCAL ROLE vendas_app');
    } else {
      await executor.query('BEGIN; SET LOCAL ROLE postgres');
    }
  } else {
    await executor.query('BEGIN');
  }

  try {
    if (executor.supportsMultiStatementSimpleQuery !== true) {
      if (roleName === 'vendas_app') {
        await executor.query('SET LOCAL ROLE vendas_app');
      } else {
        await executor.query('SET LOCAL ROLE postgres');
      }
    }
    const empIdParam =
      context.employeeId !== undefined && context.employeeId !== null ? context.employeeId : null;
    await executor.query(
      "SELECT set_config('app.current_tenant_id', $1, true), CASE WHEN $2::text IS NOT NULL THEN set_config('app.current_employee_id', $2, true) ELSE NULL END",
      [context.tenantId, empIdParam],
    );
    const client = executor;
    const tx: DbExecutor = {
      query<R extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<R[]> {
        return client.query<R>(sql, params);
      },
    };
    const result = await fn(tx);
    await executor.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await executor.query('ROLLBACK');
    } catch (rollbackErr) {
      throw new AggregateError([err, rollbackErr], 'ロールバック処理中に追加エラーが発生しました');
    }
    throw err;
  }
}

function wrapPoolClient(client: PoolClient): DbExecutor {
  let queue: Promise<void> = Promise.resolve();
  return {
    supportsMultiStatementSimpleQuery: true,
    async query<T extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
      const prev = queue;
      let release: () => void = () => undefined;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prev;
      try {
        const res = await client.query<T>(sql, params === undefined ? undefined : [...params]);
        if (Array.isArray(res)) {
          return [];
        }
        return res.rows;
      } finally {
        release();
      }
    },
  };
}

/**
 * サーバーサイド業務処理向け標準トランザクションラッパー（是正1準拠）
 * - PostgREST (.from) を使用せず、PG直接接続 + BYPASSRLSなしの vendas_app ロールで実行
 * - BEGIN -> SET LOCAL ROLE vendas_app -> set_config('app.current_tenant_id', ..., true) -> fn -> COMMIT / ROLLBACK
 */
export async function withTenantContext<T>(
  session: Pick<SessionContext, 'tenantId' | 'employeeId'>,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    const exec = wrapPoolClient(client);
    return await withExecutorTenantContext(
      exec,
      { tenantId: session.tenantId, employeeId: session.employeeId, role: 'vendas_app' },
      fn,
    );
  } finally {
    client.release();
  }
}

/**
 * 請求確定・再発行 (K4 <-> K5)・請求取消時のみ trg_lock_billed_sales_* を明示許可するトランザクション内ヘルパ
 */
export async function withBillingTransition<T>(
  tx: DbExecutor,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.query("SELECT set_config('app.allow_billing_transition', 'on', true)");
  try {
    return await fn();
  } finally {
    await tx.query("SELECT set_config('app.allow_billing_transition', 'off', true)");
  }
}

/**
 * ETL実行時用トランザクションラッパー（cutoffトリガーのみセッション限定バイパス）
 */
export async function withEtlTenantTransaction<T>(
  tenantId: string,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    const exec = wrapPoolClient(client);
    return await withExecutorTenantContext(exec, { tenantId, role: 'vendas_app' }, async (tx) => {
      await tx.query("SELECT set_config('app.etl_bypass_cutoff', 'on', true)");
      return fn(tx);
    });
  } finally {
    client.release();
  }
}

/**
 * 注入済み executor 上での認証前コンテキスト実行ヘルパ（失敗時のみ COMMIT してカウンタ永続化）
 */
export async function withExecutorAnonymousAuthContext<T>(
  executor: DbExecutor,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  if (executor.supportsMultiStatementSimpleQuery === true) {
    await executor.query('BEGIN; SET LOCAL ROLE vendas_app');
  } else {
    await executor.query('BEGIN');
  }
  try {
    if (executor.supportsMultiStatementSimpleQuery !== true) {
      await executor.query('SET LOCAL ROLE vendas_app');
    }
    await executor.query("SELECT set_config('app.current_tenant_id', '', true)");
    const result = await fn(executor);
    await executor.query('COMMIT');
    return result;
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'InvalidCredentialsError' || err.name === 'AccountLockedError')
    ) {
      await executor.query('COMMIT');
      throw err;
    }
    try {
      await executor.query('ROLLBACK');
    } catch (rollbackErr) {
      throw new AggregateError([err, rollbackErr], '認証ロールバック処理中に追加エラーが発生しました');
    }
    throw err;
  }
}

/**
 * 認証前コンテキスト専用ラッパー（app.current_tenant_id = '' のFail-Closed状態 + vendas_app）
 * ※ InvalidCredentialsError / AccountLockedError のみ失敗回数記録を永続化するため COMMIT 後再throw
 */
export async function withAnonymousAuthContext<T>(
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  const pool = getPgPool();
  const client = await pool.connect();
  try {
    return await withExecutorAnonymousAuthContext(wrapPoolClient(client), fn);
  } finally {
    client.release();
  }
}

export async function closePgPool(): Promise<void> {
  if (cachedPool !== null) {
    const p = cachedPool;
    cachedPool = null;
    await p.end();
  }
}
