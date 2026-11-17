import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { createPgPoolConfig } from '../../src/lib/db/tenant-client';
import { requireEnv } from '../../src/lib/env';
import { ensureAttachmentBucket } from '../../src/lib/storage/storage-client';

function extractFunctionDefinitions(sqlText: string): string[] {
  const matches = sqlText.match(/CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/g);
  if (matches === null || matches.length === 0) {
    throw new Error('0001_schema.sql から CREATE OR REPLACE FUNCTION 定義を抽出できませんでした');
  }
  return matches;
}

function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function main(): Promise<void> {
  const directUrl = requireEnv('DIRECT_DATABASE_URL');
  const rootDir = process.cwd();
  const migrationsDir = path.join(rootDir, 'supabase', 'migrations');
  const seedPath = path.join(rootDir, 'supabase', 'seed', 'default_codes.sql');

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error('supabase/migrations 配下にマイグレーションSQLが見つかりません');
  }

  const seedSql = fs.readFileSync(seedPath, 'utf8');
  const pool = new Pool(createPgPoolConfig(directUrl));
  const client = await pool.connect();

  const appliedNow: Array<{ version: string; filename: string; mode: string }> = [];
  const skippedExisting: string[] = [];

  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version         text PRIMARY KEY,
        filename        text NOT NULL,
        checksum_sha256 char(64) NOT NULL,
        applied_at      timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY');
    await client.query('ALTER TABLE public.schema_migrations FORCE ROW LEVEL SECURITY');
    await client.query('REVOKE ALL ON TABLE public.schema_migrations FROM PUBLIC, vendas_app');

    const recordedRes = await client.query<{ version: string; checksum_sha256: string }>(
      'SELECT version, checksum_sha256 FROM public.schema_migrations',
    );
    const recordedMap = new Map(recordedRes.rows.map((r) => [r.version, r.checksum_sha256]));

    const tenantsExistsRes = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'tenants'
       ) AS exists`,
    );
    const bootstrapAlreadyInitialized = tenantsExistsRes.rows[0]?.exists === true;

    for (const filename of migrationFiles) {
      const version = filename.slice(0, 4);
      const sqlText = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
      const checksum = computeSha256(sqlText);
      const existingChecksum = recordedMap.get(version);

      if (existingChecksum !== undefined) {
        if (existingChecksum !== checksum) {
          throw new Error(
            `適用済みマイグレーション ${filename} のチェックサムが改変されています (recorded=${existingChecksum}, current=${checksum})`,
          );
        }
        skippedExisting.push(filename);
        continue;
      }

      let mode = 'full';
      if (version === '0001' && bootstrapAlreadyInitialized) {
        const fnDefs = extractFunctionDefinitions(sqlText);
        for (const fnSql of fnDefs) {
          await client.query(fnSql);
        }
        mode = 'bootstrap_functions_only';
      } else {
        await client.query(sqlText);
      }

      await client.query(
        `INSERT INTO public.schema_migrations (version, filename, checksum_sha256)
         VALUES ($1, $2, $3)`,
        [version, filename, checksum],
      );
      appliedNow.push({ version, filename, mode });
    }

    await client.query(seedSql);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      throw new AggregateError([err, rbErr], 'マイグレーション中のロールバックに失敗しました');
    }
    throw err;
  } finally {
    client.release();
  }

  let totalPublicTables = 0;
  let rlsEnabledCount = 0;
  let rlsForcedCount = 0;
  let vendasAppRole: { rolname: string; rolbypassrls: boolean; rolsuper: boolean } | null = null;
  let migrationCount = 0;

  try {
    const tblRes = await pool.query<{
      tablename: string;
      rowsecurity: boolean;
      forcerowsecurity: boolean;
    }>(
      `SELECT t.tablename, c.relrowsecurity AS rowsecurity, c.relforcerowsecurity AS forcerowsecurity
         FROM pg_tables t
         JOIN pg_class c ON c.relname = t.tablename
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
        WHERE t.schemaname = 'public'
        ORDER BY t.tablename`,
    );
    totalPublicTables = tblRes.rows.length;
    rlsEnabledCount = tblRes.rows.filter((r) => r.rowsecurity).length;
    rlsForcedCount = tblRes.rows.filter((r) => r.forcerowsecurity).length;

    const roleRes = await pool.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'vendas_app'`,
    );
    const firstRole = roleRes.rows[0];
    if (firstRole !== undefined) {
      vendasAppRole = firstRole;
    }

    const migRes = await pool.query<{ cnt: string }>(
      'SELECT COUNT(*)::text AS cnt FROM public.schema_migrations',
    );
    migrationCount = Number(migRes.rows[0]?.cnt);
  } finally {
    await pool.end();
  }

  const bucketStatus = await ensureAttachmentBucket('vendas-attachments');

  console.log('[db:migrate] Migration Summary:', {
    appliedNow,
    skippedExisting,
    recordedMigrationsTotal: migrationCount,
    totalPublicTables,
    rlsEnabledCount,
    rlsForcedCount,
    vendasAppRole,
    storageBucket: { ...bucketStatus, public: false },
  });
}

main().catch((err) => {
  console.error('[db:migrate ERROR]', err);
  process.exit(1);
});
