-- ============================================================================
-- 販売管理ヴェンダス（Vendas Web）認証セキュリティ強化マイグレーション (0003_auth_security.sql)
-- Phase 1-A: session_version 即時失効・初回パスワード強制変更・ブルートフォース対策・静的集計/パージ関数
-- ============================================================================

-- 1. employees テーブルへ認証セキュリティ列を追加
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

-- 2. IP・アカウント単位のサーバーレス対応ログインレート制限テーブル
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  scope_key         text PRIMARY KEY,
  attempt_count     integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_rate_limits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE auth_rate_limits FROM PUBLIC, vendas_app;

-- 3. authenticate_employee_lookup 更新（session_version / must_change_password / lock情報を返却）
DROP FUNCTION IF EXISTS authenticate_employee_lookup(text, text);

CREATE OR REPLACE FUNCTION authenticate_employee_lookup(p_tenant_slug text, p_syain_code text)
RETURNS TABLE (
  tenant_id            uuid,
  tenant_slug          text,
  tenant_is_active     boolean,
  employee_id          uuid,
  syain_code           text,
  syain_name           text,
  password_hash        text,
  is_admin             boolean,
  menu_type            integer,
  is_retired           boolean,
  retired_at           date,
  session_version      integer,
  must_change_password boolean,
  failed_login_count   integer,
  locked_until         timestamptz
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
    e.retired_at,
    e.session_version,
    e.must_change_password,
    e.failed_login_count,
    e.locked_until
  FROM tenants t
  INNER JOIN employees e ON e.tenant_id = t.id
  WHERE t.tenant_slug = p_tenant_slug
    AND e.syain_code = p_syain_code
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION authenticate_employee_lookup(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authenticate_employee_lookup(text, text) TO vendas_app;

-- 4. ログイン前レート制限・ロック確認（IP / アカウント単位）
CREATE OR REPLACE FUNCTION check_login_rate_limit(
  p_ip_key      text,
  p_account_key text,
  p_now         timestamptz DEFAULT now()
)
RETURNS TABLE (
  is_blocked    boolean,
  blocked_until timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    MAX(arl.locked_until) IS NOT NULL AS is_blocked,
    MAX(arl.locked_until) AS blocked_until
  FROM auth_rate_limits arl
  WHERE arl.scope_key IN (p_ip_key, p_account_key)
    AND arl.locked_until IS NOT NULL
    AND arl.locked_until > p_now;
$$;

REVOKE ALL ON FUNCTION check_login_rate_limit(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION check_login_rate_limit(text, text, timestamptz) TO vendas_app;

-- 5. ログイン失敗記録＆ロックアウト更新
CREATE OR REPLACE FUNCTION record_login_failure(
  p_ip_key               text,
  p_account_key          text,
  p_tenant_id            uuid,
  p_employee_id          uuid,
  p_now                  timestamptz,
  p_max_account_attempts integer,
  p_max_ip_attempts      integer,
  p_lock_minutes         integer
)
RETURNS TABLE (
  account_locked_until timestamptz,
  ip_locked_until      timestamptz,
  new_failed_count     integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ip_count       integer;
  v_ip_lock        timestamptz;
  v_acct_count     integer;
  v_acct_lock      timestamptz;
  v_emp_count      integer := 0;
  v_emp_lock       timestamptz := NULL;
  v_window_cutoff  timestamptz := p_now - make_interval(mins => p_lock_minutes);
BEGIN
  -- (A) IP スコープのカウント・ロック更新
  INSERT INTO auth_rate_limits (scope_key, attempt_count, window_started_at, locked_until, updated_at)
  VALUES (
    p_ip_key,
    1,
    p_now,
    CASE WHEN 1 >= p_max_ip_attempts THEN p_now + make_interval(mins => p_lock_minutes) ELSE NULL END,
    p_now
  )
  ON CONFLICT (scope_key) DO UPDATE SET
    attempt_count = CASE
      WHEN auth_rate_limits.window_started_at <= v_window_cutoff
        OR (auth_rate_limits.locked_until IS NOT NULL AND auth_rate_limits.locked_until <= p_now)
      THEN 1
      ELSE auth_rate_limits.attempt_count + 1
    END,
    window_started_at = CASE
      WHEN auth_rate_limits.window_started_at <= v_window_cutoff
        OR (auth_rate_limits.locked_until IS NOT NULL AND auth_rate_limits.locked_until <= p_now)
      THEN p_now
      ELSE auth_rate_limits.window_started_at
    END,
    locked_until = CASE
      WHEN (
        CASE
          WHEN auth_rate_limits.window_started_at <= v_window_cutoff
            OR (auth_rate_limits.locked_until IS NOT NULL AND auth_rate_limits.locked_until <= p_now)
          THEN 1
          ELSE auth_rate_limits.attempt_count + 1
        END
      ) >= p_max_ip_attempts
      THEN p_now + make_interval(mins => p_lock_minutes)
      ELSE NULL
    END,
    updated_at = p_now
  RETURNING auth_rate_limits.attempt_count, auth_rate_limits.locked_until
    INTO v_ip_count, v_ip_lock;

  -- (B) アカウントスコープのカウント・ロック更新（社員が存在しなくても列挙防止のため同一計数）
  INSERT INTO auth_rate_limits (scope_key, attempt_count, window_started_at, locked_until, updated_at)
  VALUES (
    p_account_key,
    1,
    p_now,
    CASE WHEN 1 >= p_max_account_attempts THEN p_now + make_interval(mins => p_lock_minutes) ELSE NULL END,
    p_now
  )
  ON CONFLICT (scope_key) DO UPDATE SET
    attempt_count = CASE
      WHEN auth_rate_limits.window_started_at <= v_window_cutoff
        OR (auth_rate_limits.locked_until IS NOT NULL AND auth_rate_limits.locked_until <= p_now)
      THEN 1
      ELSE auth_rate_limits.attempt_count + 1
    END,
    window_started_at = CASE
      WHEN auth_rate_limits.window_started_at <= v_window_cutoff
        OR (auth_rate_limits.locked_until IS NOT NULL AND auth_rate_limits.locked_until <= p_now)
      THEN p_now
      ELSE auth_rate_limits.window_started_at
    END,
    locked_until = CASE
      WHEN (
        CASE
          WHEN auth_rate_limits.window_started_at <= v_window_cutoff
            OR (auth_rate_limits.locked_until IS NOT NULL AND auth_rate_limits.locked_until <= p_now)
          THEN 1
          ELSE auth_rate_limits.attempt_count + 1
        END
      ) >= p_max_account_attempts
      THEN p_now + make_interval(mins => p_lock_minutes)
      ELSE NULL
    END,
    updated_at = p_now
  RETURNING auth_rate_limits.attempt_count, auth_rate_limits.locked_until
    INTO v_acct_count, v_acct_lock;

  -- (C) 実在社員レコード側のカウンタ・ロックも同期更新
  IF p_tenant_id IS NOT NULL AND p_employee_id IS NOT NULL THEN
    UPDATE employees
       SET failed_login_count = CASE
             WHEN locked_until IS NOT NULL AND locked_until <= p_now THEN 1
             ELSE failed_login_count + 1
           END,
           locked_until = CASE
             WHEN (
               CASE
                 WHEN locked_until IS NOT NULL AND locked_until <= p_now THEN 1
                 ELSE failed_login_count + 1
               END
             ) >= p_max_account_attempts
             THEN p_now + make_interval(mins => p_lock_minutes)
             ELSE NULL
           END
     WHERE tenant_id = p_tenant_id
       AND id = p_employee_id
     RETURNING employees.failed_login_count, employees.locked_until
       INTO v_emp_count, v_emp_lock;
  ELSE
    v_emp_count := v_acct_count;
    v_emp_lock := v_acct_lock;
  END IF;

  RETURN QUERY SELECT v_emp_lock, v_ip_lock, v_emp_count;
END;
$$;

REVOKE ALL ON FUNCTION record_login_failure(text, text, uuid, uuid, timestamptz, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_login_failure(text, text, uuid, uuid, timestamptz, integer, integer, integer) TO vendas_app;

-- 6. ログイン成功時のカウント・レート制限リセット
CREATE OR REPLACE FUNCTION record_login_success(
  p_ip_key      text,
  p_account_key text,
  p_tenant_id   uuid,
  p_employee_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_tenant_id IS NOT NULL AND p_employee_id IS NOT NULL THEN
    UPDATE employees
       SET failed_login_count = 0,
           locked_until = NULL
     WHERE tenant_id = p_tenant_id
       AND id = p_employee_id;
  END IF;

  DELETE FROM auth_rate_limits
   WHERE scope_key IN (p_account_key, p_ip_key);
END;
$$;

REVOKE ALL ON FUNCTION record_login_success(text, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_login_success(text, text, uuid, uuid) TO vendas_app;

-- 7. 管理者専用 テナント完全削除関数（ETL purge-tenant / ライブ検証クリーンアップ用・動的SQL撲滅）
CREATE OR REPLACE FUNCTION purge_tenant_cascade(p_tenant_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_tbl       text;
  v_cnt       integer;
  v_counts    jsonb := '{}'::jsonb;
  v_tables    text[] := ARRAY[
    'document_snapshots',
    'internal_chats',
    'attachments',
    'aplus_imports',
    'aplus_exports',
    'cash_receipts',
    'subscription_billings',
    'subscription_approval_flows',
    'subscription_contracts',
    'sales_lines',
    'sales_headers',
    'billing_headers',
    'supplier_payments',
    'payable_ledgers',
    'project_cost_lines',
    'project_cost_headers',
    'purchase_lines',
    'purchases',
    'purchase_order_lines',
    'purchase_orders',
    'quotation_lines',
    'quotations',
    'projects',
    'mail_templates',
    'input_intelligences',
    'products',
    'partner_advisory_profiles',
    'business_partners',
    'representatives',
    'code_masters',
    'payment_methods',
    'tax_codes',
    'units',
    'tax_offices',
    'bank_branches',
    'banks',
    'employees',
    'tenant_feature_authorities',
    'tenant_settings'
  ];
BEGIN
  IF current_user = 'vendas_app' THEN
    RAISE EXCEPTION 'vendas_app ロールからは purge_tenant_cascade を実行できません';
  END IF;

  PERFORM set_config('app.etl_bypass_cutoff', 'on', true);
  PERFORM set_config('app.allow_billing_transition', 'on', true);
  PERFORM set_config('app.allow_tenant_purge', 'on', true);

  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_tbl) USING p_tenant_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt > 0 THEN
      v_counts := jsonb_set(v_counts, ARRAY[v_tbl], to_jsonb(v_cnt), true);
    END IF;
  END LOOP;

  DELETE FROM tenants WHERE id = p_tenant_id;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  IF v_cnt > 0 THEN
    v_counts := jsonb_set(v_counts, ARRAY['tenants'], to_jsonb(v_cnt), true);
  END IF;

  RETURN v_counts;
END;
$$;

REVOKE ALL ON FUNCTION purge_tenant_cascade(uuid) FROM PUBLIC, vendas_app;

-- 8. 全40業務テーブル件数集計関数（purge-tenant / クリーン確認用・動的SQL撲滅）
CREATE OR REPLACE FUNCTION count_public_business_rows()
RETURNS TABLE (tablename text, row_count bigint)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_tbl    text;
  v_cnt    bigint;
  v_tables text[] := ARRAY[
    'aplus_exports',
    'aplus_imports',
    'attachments',
    'bank_branches',
    'banks',
    'billing_headers',
    'business_partners',
    'cash_receipts',
    'code_masters',
    'document_snapshots',
    'employees',
    'input_intelligences',
    'internal_chats',
    'mail_templates',
    'partner_advisory_profiles',
    'payable_ledgers',
    'payment_methods',
    'products',
    'project_cost_headers',
    'project_cost_lines',
    'projects',
    'purchase_lines',
    'purchase_order_lines',
    'purchase_orders',
    'purchases',
    'quotation_lines',
    'quotations',
    'representatives',
    'sales_headers',
    'sales_lines',
    'subscription_approval_flows',
    'subscription_billings',
    'subscription_contracts',
    'supplier_payments',
    'tax_codes',
    'tax_offices',
    'tenant_feature_authorities',
    'tenant_settings',
    'tenants',
    'units'
  ];
BEGIN
  FOREACH v_tbl IN ARRAY v_tables LOOP
    EXECUTE format('SELECT COUNT(*)::bigint FROM %I', v_tbl) INTO v_cnt;
    tablename := v_tbl;
    row_count := v_cnt;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION count_public_business_rows() FROM PUBLIC, vendas_app;
