-- ============================================================================
-- 販売管理ヴェンダス（Vendas Web）アプリ専用ロール・強制RLSポリシー (0002_rls_policies.sql)
-- 是正1準拠: BYPASSRLS を持たない vendas_app ロール + 全40テーブル FORCE RLS
-- ============================================================================

-- 1. アプリ専用ロール作成（BYPASSRLS なし・ログイン権限あり）
DO $$
DECLARE
  v_rol RECORD;
BEGIN
  SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
    INTO v_rol
    FROM pg_roles
   WHERE rolname = 'vendas_app';

  IF NOT FOUND THEN
    CREATE ROLE vendas_app WITH LOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ELSE
    IF v_rol.rolsuper THEN
      RAISE EXCEPTION 'vendas_app ロールに SUPERUSER が付与されています';
    END IF;
    IF v_rol.rolbypassrls OR v_rol.rolcreaterole OR v_rol.rolcreatedb OR NOT v_rol.rolcanlogin THEN
      ALTER ROLE vendas_app WITH LOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END IF;
END
$$;

GRANT vendas_app TO current_user;

GRANT USAGE ON SCHEMA public TO vendas_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vendas_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vendas_app;

-- 2. ログイン認証用 SECURITY DEFINER ルックアップ関数
-- （認証前は app.current_tenant_id が未設定のため、必要最小限の列のみ安全に照会）
CREATE OR REPLACE FUNCTION authenticate_employee_lookup(p_tenant_slug text, p_syain_code text)
RETURNS TABLE (
  tenant_id uuid,
  tenant_slug text,
  tenant_is_active boolean,
  employee_id uuid,
  syain_code text,
  syain_name text,
  password_hash text,
  is_admin boolean,
  menu_type integer,
  is_retired boolean,
  retired_at date
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.id AS tenant_id,
    t.tenant_slug,
    t.is_active AS tenant_is_active,
    e.id AS employee_id,
    e.syain_code,
    e.syain_name,
    e.password_hash,
    e.is_admin,
    e.menu_type,
    e.is_retired,
    e.retired_at
  FROM tenants t
  INNER JOIN employees e ON e.tenant_id = t.id
  WHERE t.tenant_slug = p_tenant_slug
    AND e.syain_code = p_syain_code
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION authenticate_employee_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_employee_lookup(text, text) TO vendas_app;

-- 3. tenants テーブル RLS
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenants_isolation_policy ON tenants;
CREATE POLICY tenants_isolation_policy ON tenants
  FOR ALL
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 4. 全39業務・マスタ・スナップショットテーブルへ ENABLE + FORCE RLS 一括適用
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'tenant_settings',
    'tenant_feature_authorities',
    'employees',
    'banks',
    'bank_branches',
    'tax_offices',
    'units',
    'tax_codes',
    'payment_methods',
    'code_masters',
    'representatives',
    'business_partners',
    'partner_advisory_profiles',
    'products',
    'input_intelligences',
    'mail_templates',
    'projects',
    'quotations',
    'quotation_lines',
    'purchase_orders',
    'purchase_order_lines',
    'purchases',
    'purchase_lines',
    'project_cost_headers',
    'project_cost_lines',
    'payable_ledgers',
    'supplier_payments',
    'billing_headers',
    'sales_headers',
    'sales_lines',
    'subscription_contracts',
    'subscription_approval_flows',
    'subscription_billings',
    'cash_receipts',
    'aplus_exports',
    'aplus_imports',
    'attachments',
    'internal_chats',
    'document_snapshots'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON %I', v_table);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I FOR ALL ' ||
      'USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid) ' ||
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
      v_table
    );
  END LOOP;
END
$$;
