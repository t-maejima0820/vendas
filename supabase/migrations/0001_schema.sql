-- ============================================================================
-- 販売管理ヴェンダス（Vendas Web）PostgreSQL 単一正本スキーマ定義 (0001_schema.sql)
-- Gate 0-B / Gate 0-C 設計準拠（40テーブル・複合外部キー・不変/基準日トリガー）
-- ※ 実行要件: PostgreSQL 14+（組み込み gen_random_uuid() 使用）
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. ENUM 型定義
-- ----------------------------------------------------------------------------
CREATE TYPE rounding_mode AS ENUM ('FLOOR', 'ROUND', 'CEIL');
CREATE TYPE tax_calc_policy AS ENUM ('SLIP_BY_RATE', 'INVOICE_BY_RATE', 'LEGACY_LINE_SUM');
CREATE TYPE cost_tax_display_mode AS ENUM ('TAX_EXCLUDED', 'TAX_INCLUDED');

-- 業務ステータス ENUM（旧 ti_Kanri 24種を6ドメインへ分割）
CREATE TYPE quotation_status  AS ENUM ('Q1', 'Q2', 'Q3');                  -- Q1:見積済, Q2:注文確定, Q3:-
CREATE TYPE project_status    AS ENUM ('C1', 'C2', 'C3');                  -- C1:新規, C2:仕掛中, C3:完了済
CREATE TYPE order_status      AS ENUM ('O1', 'O2', 'O3');                  -- O1:新規, O2:発注待ち, O3:発注済
CREATE TYPE purchase_status   AS ENUM ('P1', 'P2', 'P3');                  -- P1:新規, P2:仕入待ち, P3:仕入済
CREATE TYPE sales_status      AS ENUM ('K1', 'K2', 'K3', 'K4', 'K5', 'K6');-- K1:新規..K4:請求済み, K5:再発行, K6:売上修正
CREATE TYPE receivable_status AS ENUM ('N1', 'N2', 'N3', 'N4');            -- N1:未入金, N2:入金済, N3:入金不足, N4:過入金
CREATE TYPE payable_status    AS ENUM ('A1', 'A2');                        -- A1:未払, A2:支払済

-- 区分 ENUM
CREATE TYPE cost_category    AS ENUM ('EXPENSE', 'LABOR', 'MATERIAL', 'OUTSOURCING', 'TEMPORARY', 'INDIRECT');
CREATE TYPE sales_entry_type AS ENUM ('SALE', 'ADVANCE');
CREATE TYPE document_type    AS ENUM (
  'ESTIMATE', 'ESTIMATE_SUMMARY_COVER', 'ESTIMATE_SUMMARY_DETAIL',
  'PURCHASE_ORDER', 'DELIVERY_NOTE', 'DELIVERY_RECEIPT',
  'INVOICE', 'INVOICE_STANDALONE', 'INVOICE_COVER', 'INVOICE_COVER_MEMO_SUM', 'INVOICE_COVER_DETAIL',
  'FIXED_INVOICE', 'RECEIPT'
);

-- ----------------------------------------------------------------------------
-- 2. 共通ユーティリティ・トリガー関数
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. テナント・設定・権限・認証系（4テーブル）
-- ----------------------------------------------------------------------------
CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_slug  text NOT NULL UNIQUE CHECK (tenant_slug ~ '^[a-z0-9-]+$'),
  tenant_name  text NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- 旧 ReleaseInfo(20列) + T_Maintenance(4列) + tm10_Zisya(25列) + カットオーバー基準日
CREATE TABLE tenant_settings (
  id                               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                        uuid NOT NULL UNIQUE REFERENCES tenants(id),
  company_code                     text NOT NULL DEFAULT '9999',
  company_name                     text NOT NULL,
  invoice_registration_no          text CHECK (invoice_registration_no IS NULL OR invoice_registration_no ~ '^T[0-9]{13}$'),
  corporate_no                     text CHECK (corporate_no IS NULL OR corporate_no ~ '^[0-9]{13}$'),
  postal_code                      text,
  address1                         text,
  address2                         text,
  tel                              text,
  fax                              text,
  email                            text,
  representative_title             text,
  representative_name              text,
  fiscal_closing_month             integer NOT NULL DEFAULT 0 CHECK (fiscal_closing_month BETWEEN 0 AND 12),
  billing_memo                     text,
  -- 自社口座1/2（※口座番号は AES-256-GCM "enc:v1:..." アプリ層暗号化）
  bank_code_1                      text,
  branch_code_1                    text,
  bank_account_type_1              text CHECK (bank_account_type_1 IS NULL OR bank_account_type_1 IN ('B1', 'B2')),
  bank_account_no_1_enc            text,
  bank_account_holder_1            text,
  bank_code_2                      text,
  branch_code_2                    text,
  bank_account_type_2              text CHECK (bank_account_type_2 IS NULL OR bank_account_type_2 IN ('B1', 'B2')),
  bank_account_no_2_enc            text,
  bank_account_holder_2            text,
  -- 運用・承認・税・帳票ポリシー
  approval_flow_enabled            boolean NOT NULL DEFAULT true,
  allow_billing_date_warning_skip  boolean NOT NULL DEFAULT true,
  default_approval_billing_date    smallint NOT NULL DEFAULT 0 CHECK (default_approval_billing_date IN (0, 1, 2)),
  default_ar_list_date_mode        smallint NOT NULL DEFAULT 0 CHECK (default_ar_list_date_mode IN (0, 1)),
  quotation_template_rows          smallint NOT NULL DEFAULT 10 CHECK (quotation_template_rows IN (10, 20)),
  show_invoice_carryover           boolean NOT NULL DEFAULT true,
  cost_tax_mode                    cost_tax_display_mode NOT NULL DEFAULT 'TAX_EXCLUDED',
  tax_calc_policy                  tax_calc_policy NOT NULL DEFAULT 'SLIP_BY_RATE',
  default_rounding_mode            rounding_mode NOT NULL DEFAULT 'FLOOR',
  -- カットオーバー基準日・メンテナンス
  opening_balance_date             date NOT NULL,
  release_version                  text NOT NULL DEFAULT '2.0.0.0',
  release_notice                   text,
  show_release_notice              boolean NOT NULL DEFAULT false,
  maintenance_mode                 boolean NOT NULL DEFAULT false,
  maintenance_memo                 text,
  created_at                       timestamptz NOT NULL DEFAULT now(),
  updated_at                       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- 旧 M_FunctionAuthority (29機能)
CREATE TABLE tenant_feature_authorities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  feature_code  text NOT NULL,
  feature_name  text NOT NULL,
  is_enabled    boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 100,
  is_fixed      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, feature_code)
);

-- 旧 tm09_Syain (Argon2idハッシュ, 全角誤字列 tｍ09_Retirement を is_retired へ是正)
CREATE TABLE employees (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  syain_code       text NOT NULL,
  syain_name       text NOT NULL,
  kana_name        text,
  password_hash    text NOT NULL,
  is_admin         boolean NOT NULL DEFAULT false,
  menu_type        integer NOT NULL DEFAULT 3,
  email            text,
  joined_at        date,
  birth_date       date,
  retired_at       date,
  is_retired       boolean NOT NULL DEFAULT false,
  gender_code      text CHECK (gender_code IS NULL OR gender_code IN ('S1', 'S2')),
  postal_code      text,
  address1         text,
  address2         text,
  steady_job_note  text,
  work_experience  text,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, syain_code)
);

-- ----------------------------------------------------------------------------
-- 4. 基礎マスタ系（13テーブル）
-- ----------------------------------------------------------------------------
CREATE TABLE banks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  bank_code  text NOT NULL,
  bank_name  text NOT NULL,
  furigana   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bank_code)
);

CREATE TABLE bank_branches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  bank_id      uuid NOT NULL,
  bank_code    text NOT NULL,
  branch_code  text NOT NULL,
  branch_name  text NOT NULL,
  furigana     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, bank_code, branch_code),
  FOREIGN KEY (tenant_id, bank_id) REFERENCES banks(tenant_id, id)
);

CREATE TABLE tax_offices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  tax_office_code  text NOT NULL,
  tax_office_name  text NOT NULL,
  tax_office_no    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, tax_office_code)
);

CREATE TABLE units (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  unit_code        text NOT NULL,
  unit_name        text NOT NULL,
  conversion_name  text,
  conversion_ratio numeric(15,4) NOT NULL DEFAULT 1,
  display_order    integer NOT NULL DEFAULT 99999,
  is_deleted       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, unit_code)
);

CREATE TABLE tax_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  tax_code    text NOT NULL CHECK (tax_code IN ('A', 'B', 'C', 'D', 'E')),
  tax_name    text NOT NULL,
  tax_rate    numeric(5,4) NOT NULL CHECK (tax_rate >= 0 AND tax_rate <= 1),
  mark_symbol text NOT NULL,
  is_internal boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, tax_code)
);

CREATE TABLE payment_methods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  method_code  text NOT NULL,
  method_name  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, method_code)
);

-- 旧 ti_* 区分マスタ16表統合
CREATE TABLE code_masters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  domain_key    text NOT NULL,
  code          text NOT NULL,
  name          text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, domain_key, code)
);

-- 旧 tm02_Daihyou（※tm02_MyNumber 完全廃止）
CREATE TABLE representatives (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  representative_code integer NOT NULL,
  representative_name text NOT NULL,
  furigana            text,
  postal_code         text,
  address1            text,
  address2            text,
  tel                 text,
  mobile              text,
  birth_date          date,
  gender_code         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, representative_code)
);

-- 旧 tm01_Kokyakubunrui（販売・購買・請求・期首残高・暗号化口座）
CREATE TABLE business_partners (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  partner_code              text NOT NULL,
  category_code             text,
  state_code                text,
  partner_name              text NOT NULL,
  furigana                  text,
  representative_id         uuid,
  is_individual_honorific   boolean NOT NULL DEFAULT false,
  postal_code               text,
  address1                  text,
  address2                  text,
  tel                       text,
  is_client                 boolean NOT NULL DEFAULT true,
  is_supplier               boolean NOT NULL DEFAULT false,
  is_aplus_enabled          boolean NOT NULL DEFAULT false,
  send_mail_enabled         boolean NOT NULL DEFAULT false,
  email                     text,
  estimate_mail_to          text,
  estimate_mail_cc          text,
  bill_mail_to              text,
  bill_mail_cc              text,
  invoice_no                text,
  billing_destination_name  text,
  closing_day_code          text,
  collection_day_code       text,
  receipt_method_code       text,
  payment_method_code       text,
  assigned_employee_id      uuid,
  opening_ar_balance        numeric(15,0) NOT NULL DEFAULT 0,
  opening_ap_balance        numeric(15,0) NOT NULL DEFAULT 0,
  bank_code                 text,
  branch_code               text,
  bank_account_type         text CHECK (bank_account_type IS NULL OR bank_account_type IN ('B1', 'B2')),
  bank_account_no_enc       text, -- [ENCRYPTED: AES-256-GCM]
  bank_account_holder       text,
  is_deleted                boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, partner_code),
  FOREIGN KEY (tenant_id, representative_id) REFERENCES representatives(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_employee_id) REFERENCES employees(tenant_id, id)
);

-- 旧 tm01_Kokyakubunrui 税務・労務顧問プロファイル分離（20列）
CREATE TABLE partner_advisory_profiles (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  partner_id               uuid NOT NULL,
  corporate_no             text,
  established_at_text      text,
  business_description     text,
  capital_text             text,
  fiscal_closing_month     integer,
  advisory_fee             numeric(15,0) NOT NULL DEFAULT 0,
  settlement_fee           numeric(15,0) NOT NULL DEFAULT 0,
  payroll_closing_code     text,
  payroll_pay_code         text,
  labor_insurance_code     text,
  social_insurance_code    text,
  labor_insurance_no       text,
  employment_ins_office_no text,
  pension_office_no        text,
  pension_serial_no        text,
  tax_office_id            uuid,
  tax_office_serial_no     text,
  income_tax_code          text,
  consumption_tax_code     text,
  resident_tax_code        text,
  tax_transfer_info_enc    text, -- [ENCRYPTED: AES-256-GCM]
  labor_bank_account_enc   text, -- [ENCRYPTED: AES-256-GCM]
  social_bank_account_enc  text, -- [ENCRYPTED: AES-256-GCM]
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, partner_id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, tax_office_id) REFERENCES tax_offices(tenant_id, id)
);

-- 旧 tm03_Shohin
CREATE TABLE products (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  product_code            text NOT NULL,
  product_name            text NOT NULL,
  product_name_sub        text,
  month_flag_code         text,
  capacity                numeric(15,4) NOT NULL DEFAULT 0,
  unit_id                 uuid,
  standard_unit_price     numeric(15,0) NOT NULL DEFAULT 0,
  standard_purchase_price numeric(15,0) NOT NULL DEFAULT 0,
  standard_cost_price     numeric(15,0) NOT NULL DEFAULT 0,
  default_tax_code        text NOT NULL DEFAULT 'A' CHECK (default_tax_code IN ('A','B','C','D','E')),
  item_category_code      text,
  kubun                   text,
  is_stock_managed        boolean NOT NULL DEFAULT false,
  stock_quantity          numeric(15,4) NOT NULL DEFAULT 0,
  is_subscription_target  boolean NOT NULL DEFAULT false,
  is_heading              boolean NOT NULL DEFAULT false,
  is_deleted              boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, product_code),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES units(tenant_id, id)
);

CREATE TABLE input_intelligences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  item_name   text NOT NULL,
  unit_name   text,
  unit_price  numeric(15,0) NOT NULL DEFAULT 0,
  cost_price  numeric(15,0) NOT NULL DEFAULT 0,
  tax_code    text NOT NULL DEFAULT 'A' CHECK (tax_code IN ('A','B','C','D','E')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE mail_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  template_no   integer NOT NULL,
  template_name text NOT NULL,
  subject       text NOT NULL,
  body_intro    text,
  body_main     text,
  body_footer   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, template_no)
);

-- ----------------------------------------------------------------------------
-- 5. 案件・見積・原価6費目・購買トランザクション系（11テーブル）
-- ----------------------------------------------------------------------------
-- 旧 tm25_Construction（画像60列を attachments へ分離）
CREATE TABLE projects (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  project_no          bigint NOT NULL,
  project_name        text NOT NULL,
  project_date        date NOT NULL,
  site_place          text,
  partner_id          uuid NOT NULL,
  partner_name_snap   text NOT NULL,
  order_kind_code     text,
  sub_status_code     text,
  status              project_status NOT NULL DEFAULT 'C1',
  period_start_date   date,
  period_end_date     date,
  actual_start_date   date,
  temp_finish_date    date,
  finish_date         date,
  sales_employee_id   uuid,
  site_employee_id    uuid,
  unit_name           text NOT NULL DEFAULT '式',
  contract_unit_price numeric(15,0) NOT NULL DEFAULT 0,
  contract_quantity   numeric(15,4) NOT NULL DEFAULT 1,
  contract_subtotal   numeric(15,0) NOT NULL DEFAULT 0,
  contract_tax        numeric(15,0) NOT NULL DEFAULT 0,
  contract_total      numeric(15,0) NOT NULL DEFAULT 0,
  tax_code            text NOT NULL DEFAULT 'A' CHECK (tax_code IN ('A','B','C','D','E')),
  rounding_mode       rounding_mode NOT NULL DEFAULT 'FLOOR',
  budget_expense      numeric(15,0) NOT NULL DEFAULT 0,
  budget_labor        numeric(15,0) NOT NULL DEFAULT 0,
  budget_material     numeric(15,0) NOT NULL DEFAULT 0,
  budget_outsourcing  numeric(15,0) NOT NULL DEFAULT 0,
  budget_temporary    numeric(15,0) NOT NULL DEFAULT 0,
  budget_indirect     numeric(15,0) NOT NULL DEFAULT 0,
  source_quotation_no bigint,
  bill_no             bigint,
  bill_date           date,
  remarks             text,
  created_by          uuid,
  updated_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_no),
  FOREIGN KEY (tenant_id, partner_id)        REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, sales_employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, site_employee_id)  REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)        REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by)        REFERENCES employees(tenant_id, id)
);

-- 旧 trx_Quotation（画像60列分離）
CREATE TABLE quotations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  quotation_no    bigint NOT NULL,
  quotation_name  text NOT NULL,
  quotation_date  date NOT NULL,
  partner_id      uuid NOT NULL,
  project_id      uuid,
  honorific       text NOT NULL DEFAULT '御中',
  validity_period text,
  delivery_date   text,
  status          quotation_status NOT NULL DEFAULT 'Q1',
  is_advance_type boolean NOT NULL DEFAULT false,
  is_selected     boolean NOT NULL DEFAULT false,
  rounding_mode   rounding_mode NOT NULL DEFAULT 'FLOOR',
  tax_calc_policy tax_calc_policy NOT NULL DEFAULT 'SLIP_BY_RATE',
  subtotal_amount numeric(15,0) NOT NULL DEFAULT 0,
  tax_total       numeric(15,0) NOT NULL DEFAULT 0,
  total_amount    numeric(15,0) NOT NULL DEFAULT 0,
  remarks         text,
  created_by      uuid,
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, quotation_no),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- 旧 trx_QuotationList + trx_QuotationCostList 統合
CREATE TABLE quotation_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  quotation_id        uuid NOT NULL,
  line_no             integer NOT NULL CHECK (line_no >= 1),
  product_id          uuid,
  item_code           text,
  item_name           text NOT NULL,
  unit_name           text,
  is_heading          boolean NOT NULL DEFAULT false,
  quantity            numeric(15,4) NOT NULL DEFAULT 0,
  tax_code            text NOT NULL DEFAULT 'A' CHECK (tax_code IN ('A','B','C','D','E')),
  cost_category       cost_category,
  master_unit_price   numeric(15,0),
  applied_unit_price  numeric(15,0) NOT NULL DEFAULT 0,
  line_amount         numeric(15,0) NOT NULL DEFAULT 0,
  line_tax            numeric(15,0) NOT NULL DEFAULT 0,
  line_total          numeric(15,0) NOT NULL DEFAULT 0,
  master_cost_price   numeric(15,0),
  applied_cost_price  numeric(15,0) NOT NULL DEFAULT 0,
  cost_amount         numeric(15,0) NOT NULL DEFAULT 0,
  cost_tax            numeric(15,0) NOT NULL DEFAULT 0,
  cost_total          numeric(15,0) NOT NULL DEFAULT 0,
  remarks             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, quotation_id, line_no),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES quotations(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)   REFERENCES products(tenant_id, id)
);

-- 発注 (旧 trx_Order / OrderList / OrderCostList)
CREATE TABLE purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  order_no        bigint NOT NULL,
  order_name      text NOT NULL,
  order_date      date NOT NULL,
  supplier_id     uuid NOT NULL,
  project_id      uuid,
  honorific       text NOT NULL DEFAULT '御中',
  delivery_date   text,
  status          order_status NOT NULL DEFAULT 'O1',
  rounding_mode   rounding_mode NOT NULL DEFAULT 'FLOOR',
  subtotal_amount numeric(15,0) NOT NULL DEFAULT 0,
  tax_total       numeric(15,0) NOT NULL DEFAULT 0,
  total_amount    numeric(15,0) NOT NULL DEFAULT 0,
  remarks         text,
  created_by      uuid,
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_no),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id)  REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by)  REFERENCES employees(tenant_id, id)
);

CREATE TABLE purchase_order_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  order_id            uuid NOT NULL,
  line_no             integer NOT NULL CHECK (line_no >= 1),
  product_id          uuid,
  item_code           text,
  item_name           text NOT NULL,
  unit_name           text,
  quantity            numeric(15,4) NOT NULL DEFAULT 0,
  tax_code            text NOT NULL DEFAULT 'A' CHECK (tax_code IN ('A','B','C','D','E')),
  master_unit_price   numeric(15,0),
  applied_unit_price  numeric(15,0) NOT NULL DEFAULT 0,
  line_amount         numeric(15,0) NOT NULL DEFAULT 0,
  line_tax            numeric(15,0) NOT NULL DEFAULT 0,
  line_total          numeric(15,0) NOT NULL DEFAULT 0,
  master_cost_price   numeric(15,0),
  applied_cost_price  numeric(15,0) NOT NULL DEFAULT 0,
  cost_amount         numeric(15,0) NOT NULL DEFAULT 0,
  cost_tax            numeric(15,0) NOT NULL DEFAULT 0,
  cost_total          numeric(15,0) NOT NULL DEFAULT 0,
  remarks             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_id, line_no),
  FOREIGN KEY (tenant_id, order_id)   REFERENCES purchase_orders(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

-- 仕入 (旧 trx_Purchase / PurchaseList / PurchaseCostList)
CREATE TABLE purchases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  purchase_no       bigint NOT NULL,
  purchase_name     text NOT NULL,
  purchase_date     date NOT NULL,
  supplier_id       uuid NOT NULL,
  purchase_order_id uuid,
  honorific         text NOT NULL DEFAULT '御中',
  status            purchase_status NOT NULL DEFAULT 'P1',
  rounding_mode     rounding_mode NOT NULL DEFAULT 'FLOOR',
  subtotal_amount   numeric(15,0) NOT NULL DEFAULT 0,
  tax_total         numeric(15,0) NOT NULL DEFAULT 0,
  total_amount      numeric(15,0) NOT NULL DEFAULT 0,
  remarks           text,
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, purchase_no),
  FOREIGN KEY (tenant_id, supplier_id)       REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES purchase_orders(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)        REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by)        REFERENCES employees(tenant_id, id)
);

CREATE TABLE purchase_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  purchase_id         uuid NOT NULL,
  line_no             integer NOT NULL CHECK (line_no >= 1),
  project_id          uuid,
  product_id          uuid,
  item_code           text,
  item_name           text NOT NULL,
  unit_name           text,
  quantity            numeric(15,4) NOT NULL DEFAULT 0,
  tax_code            text NOT NULL DEFAULT 'A' CHECK (tax_code IN ('A','B','C','D','E')),
  master_unit_price   numeric(15,0),
  applied_unit_price  numeric(15,0) NOT NULL DEFAULT 0,
  line_amount         numeric(15,0) NOT NULL DEFAULT 0,
  line_tax            numeric(15,0) NOT NULL DEFAULT 0,
  line_total          numeric(15,0) NOT NULL DEFAULT 0,
  master_cost_price   numeric(15,0),
  applied_cost_price  numeric(15,0) NOT NULL DEFAULT 0,
  cost_amount         numeric(15,0) NOT NULL DEFAULT 0,
  cost_tax            numeric(15,0) NOT NULL DEFAULT 0,
  cost_total          numeric(15,0) NOT NULL DEFAULT 0,
  remarks             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, purchase_id, line_no),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id)  REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)  REFERENCES products(tenant_id, id)
);

-- 旧 tm26〜tm31 本体6表 + *Cost 6表 (=計12表) を親子2表へ統合
CREATE TABLE project_cost_headers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  project_id       uuid NOT NULL,
  cost_category    cost_category NOT NULL,
  slip_title       text NOT NULL,
  entry_date       date NOT NULL,
  status           project_status NOT NULL DEFAULT 'C2',
  rounding_mode    rounding_mode NOT NULL DEFAULT 'FLOOR',
  subtotal_amount  numeric(15,0) NOT NULL DEFAULT 0,
  tax_total        numeric(15,0) NOT NULL DEFAULT 0,
  total_amount     numeric(15,0) NOT NULL DEFAULT 0,
  cost_subtotal    numeric(15,0) NOT NULL DEFAULT 0,
  cost_tax_total   numeric(15,0) NOT NULL DEFAULT 0,
  cost_total       numeric(15,0) NOT NULL DEFAULT 0,
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

CREATE TABLE project_cost_lines (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  cost_header_id          uuid NOT NULL,
  line_no                 integer NOT NULL CHECK (line_no >= 1),
  product_id              uuid,
  item_code               text,
  item_name               text NOT NULL,
  unit_name               text,
  quantity                numeric(15,4) NOT NULL DEFAULT 0,
  tax_code                text NOT NULL DEFAULT 'A' CHECK (tax_code IN ('A','B','C','D','E')),
  master_unit_price       numeric(15,0),
  applied_unit_price      numeric(15,0) NOT NULL DEFAULT 0,
  line_amount             numeric(15,0) NOT NULL DEFAULT 0,
  line_tax                numeric(15,0) NOT NULL DEFAULT 0,
  line_total              numeric(15,0) NOT NULL DEFAULT 0,
  master_cost_price       numeric(15,0),
  applied_cost_price      numeric(15,0) NOT NULL DEFAULT 0,
  cost_amount             numeric(15,0) NOT NULL DEFAULT 0,
  cost_tax                numeric(15,0) NOT NULL DEFAULT 0,
  cost_total              numeric(15,0) NOT NULL DEFAULT 0,
  source_purchase_line_id uuid,
  remarks                 text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, cost_header_id, line_no),
  FOREIGN KEY (tenant_id, cost_header_id)          REFERENCES project_cost_headers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)              REFERENCES products(tenant_id, id),
  FOREIGN KEY (tenant_id, source_purchase_line_id) REFERENCES purchase_lines(tenant_id, id)
);

-- 買掛台帳 (旧 tm23_Kaikakekin) & 支払 (旧 tm24_PaymentList)
CREATE TABLE payable_ledgers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  supplier_id       uuid NOT NULL,
  purchase_id       uuid NOT NULL,
  purchase_date     date NOT NULL,
  payable_amount    numeric(15,0) NOT NULL,
  amount_10_excl    numeric(15,0) NOT NULL DEFAULT 0,
  amount_8_excl     numeric(15,0) NOT NULL DEFAULT 0,
  amount_0_non_tax  numeric(15,0) NOT NULL DEFAULT 0,
  tax_total         numeric(15,0) NOT NULL DEFAULT 0,
  status            payable_status NOT NULL DEFAULT 'A1',
  scheduled_pay_at  date,
  ordered_at        date,
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, purchase_id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, purchase_id) REFERENCES purchases(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by)  REFERENCES employees(tenant_id, id)
);

CREATE TABLE supplier_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  payment_no        bigint NOT NULL,
  payment_date      date NOT NULL,
  supplier_id       uuid NOT NULL,
  method_code_1     text,
  amount_1          numeric(15,0) NOT NULL DEFAULT 0,
  method_code_2     text,
  amount_2          numeric(15,0) NOT NULL DEFAULT 0,
  method_code_3     text,
  amount_3          numeric(15,0) NOT NULL DEFAULT 0,
  deduction_code_1  text,
  deduction_amt_1   numeric(15,0) NOT NULL DEFAULT 0,
  deduction_code_2  text,
  deduction_amt_2   numeric(15,0) NOT NULL DEFAULT 0,
  deduction_code_3  text,
  deduction_amt_3   numeric(15,0) NOT NULL DEFAULT 0,
  subtotal_10_excl  numeric(15,0) NOT NULL DEFAULT 0,
  subtotal_8_excl   numeric(15,0) NOT NULL DEFAULT 0,
  subtotal_0        numeric(15,0) NOT NULL DEFAULT 0,
  summary_note      text,
  bill_no           text,
  bill_due_date     date,
  remarks           text,
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, payment_no),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by)  REFERENCES employees(tenant_id, id)
);

-- ----------------------------------------------------------------------------
-- 6. 販売・請求・回収・サブスク・アプラス・添付・スナップショット系（12テーブル）
-- ----------------------------------------------------------------------------
-- 請求書・売掛台帳 (旧 tm19_Urikakekin + 鏡確定数値)
CREATE TABLE billing_headers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  billing_no               bigint NOT NULL,
  partner_id               uuid NOT NULL,
  billing_date             date NOT NULL,
  target_period_start      date,
  target_period_end        date,
  payment_due_date         date,
  is_subscription_bill     boolean NOT NULL DEFAULT false,
  tax_calc_policy          tax_calc_policy NOT NULL DEFAULT 'SLIP_BY_RATE',
  rounding_mode            rounding_mode NOT NULL DEFAULT 'FLOOR',
  amount_10_excl           numeric(15,0) NOT NULL DEFAULT 0,
  amount_8_excl            numeric(15,0) NOT NULL DEFAULT 0,
  amount_0_non_tax         numeric(15,0) NOT NULL DEFAULT 0,
  tax_10_amount            numeric(15,0) NOT NULL DEFAULT 0,
  tax_8_amount             numeric(15,0) NOT NULL DEFAULT 0,
  tax_adjustment_amount    numeric(15,0) NOT NULL DEFAULT 0,
  tax_total                numeric(15,0) NOT NULL DEFAULT 0,
  billing_amount           numeric(15,0) NOT NULL DEFAULT 0,
  prev_carried_balance     numeric(15,0) NOT NULL DEFAULT 0,
  period_receipt_amount    numeric(15,0) NOT NULL DEFAULT 0,
  net_carried_balance      numeric(15,0) NOT NULL DEFAULT 0,
  closing_ar_balance       numeric(15,0) NOT NULL DEFAULT 0,
  status                   receivable_status NOT NULL DEFAULT 'N1',
  payment_method_code      text,
  received_at              date,
  created_by               uuid,
  updated_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, billing_no),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- 売上・立替金ヘッダ (旧 tm05_Uriage + tm21_AdvancesPaid ヘッダ分離統合)
CREATE TABLE sales_headers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  entry_type        sales_entry_type NOT NULL,
  slip_no           bigint NOT NULL,
  slip_name         text NOT NULL,
  slip_date         date NOT NULL,
  partner_id        uuid NOT NULL,
  project_id        uuid,
  honorific         text NOT NULL DEFAULT '御中',
  status            sales_status NOT NULL DEFAULT 'K1',
  approval_status   smallint NOT NULL DEFAULT 0 CHECK (approval_status IN (0, 1, 2)),
  approval_remarks  text,
  sales_kubun       text,
  billing_id        uuid,
  billing_date      date,
  rounding_mode     rounding_mode NOT NULL DEFAULT 'FLOOR',
  subtotal_amount   numeric(15,0) NOT NULL DEFAULT 0,
  tax_total         numeric(15,0) NOT NULL DEFAULT 0,
  total_amount      numeric(15,0) NOT NULL DEFAULT 0,
  created_by        uuid,
  updated_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entry_type, slip_no),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, billing_id) REFERENCES billing_headers(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- 売上・立替金明細
CREATE TABLE sales_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  sales_header_id    uuid NOT NULL,
  line_no            integer NOT NULL CHECK (line_no >= 1),
  product_id         uuid,
  item_code          text,
  item_name          text NOT NULL,
  unit_name          text,
  target_month_label text,
  is_heading         boolean NOT NULL DEFAULT false,
  quantity           numeric(15,4) NOT NULL DEFAULT 0,
  master_unit_price  numeric(15,0),
  applied_unit_price numeric(15,0) NOT NULL DEFAULT 0,
  tax_code           text NOT NULL DEFAULT 'A' CHECK (tax_code IN ('A','B','C','D','E')),
  line_amount        numeric(15,0) NOT NULL DEFAULT 0,
  line_tax           numeric(15,0) NOT NULL DEFAULT 0,
  row_total          numeric(15,0) NOT NULL DEFAULT 0,
  remarks            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sales_header_id, line_no),
  FOREIGN KEY (tenant_id, sales_header_id) REFERENCES sales_headers(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)      REFERENCES products(tenant_id, id)
);

-- 定額サブスク
CREATE TABLE subscription_contracts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  partner_id         uuid NOT NULL,
  entry_type         sales_entry_type NOT NULL DEFAULT 'SALE',
  subsc_seq_no       integer NOT NULL,
  product_id         uuid,
  item_name          text NOT NULL,
  month_label        text,
  unit_name          text,
  quantity           numeric(15,4) NOT NULL DEFAULT 1,
  master_unit_price  numeric(15,0),
  applied_unit_price numeric(15,0) NOT NULL DEFAULT 0,
  tax_code           text NOT NULL DEFAULT 'A' CHECK (tax_code IN ('A','B','C','D','E')),
  rounding_mode      rounding_mode NOT NULL DEFAULT 'FLOOR',
  line_amount        numeric(15,0) NOT NULL DEFAULT 0,
  line_tax           numeric(15,0) NOT NULL DEFAULT 0,
  output_type        text NOT NULL DEFAULT '印刷' CHECK (output_type IN ('印刷','メール','PDF')),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, partner_id, entry_type, subsc_seq_no),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id)
);

CREATE TABLE subscription_approval_flows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  partner_id      uuid NOT NULL,
  entry_type      sales_entry_type NOT NULL DEFAULT 'SALE',
  target_month    char(6) NOT NULL CHECK (target_month ~ '^[0-9]{6}$'),
  flow_status     smallint NOT NULL DEFAULT 0 CHECK (flow_status IN (0, 1, 2)),
  remarks         text,
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, partner_id, entry_type, target_month),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

CREATE TABLE subscription_billings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  partner_id     uuid NOT NULL,
  entry_type     sales_entry_type NOT NULL DEFAULT 'SALE',
  target_month   char(6) NOT NULL CHECK (target_month ~ '^[0-9]{6}$'),
  billing_id     uuid,
  billing_date   date NOT NULL,
  billed_amount  numeric(15,0) NOT NULL DEFAULT 0,
  output_type    text NOT NULL,
  result_message text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, partner_id, entry_type, target_month),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, billing_id) REFERENCES billing_headers(tenant_id, id)
);

-- 入金 (旧 tm18_CashRecipts)
CREATE TABLE cash_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  receipt_no       bigint NOT NULL,
  receipt_date     date NOT NULL,
  partner_id       uuid NOT NULL,
  project_id       uuid,
  method_code_1    text,
  deposit_1        numeric(15,0) NOT NULL DEFAULT 0,
  method_code_2    text,
  deposit_2        numeric(15,0) NOT NULL DEFAULT 0,
  method_code_3    text,
  deposit_3        numeric(15,0) NOT NULL DEFAULT 0,
  total_deposit    numeric(15,0) GENERATED ALWAYS AS (deposit_1 + deposit_2 + deposit_3) STORED,
  subtotal_10_excl numeric(15,0) NOT NULL DEFAULT 0,
  subtotal_8_excl  numeric(15,0) NOT NULL DEFAULT 0,
  subtotal_0       numeric(15,0) NOT NULL DEFAULT 0,
  tadashi          text,
  bill_no          text,
  bill_due_date    date,
  remarks          text,
  source_kind      text NOT NULL DEFAULT 'MANUAL' CHECK (source_kind IN ('MANUAL', 'APLUS')),
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, receipt_no),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES employees(tenant_id, id)
);

-- アプラス連携
CREATE TABLE aplus_exports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  partner_id          uuid NOT NULL,
  consignor_code      text NOT NULL,
  customer_no         text NOT NULL,
  breakdown_no        text NOT NULL DEFAULT '10',
  transfer_date       date NOT NULL,
  variable_amount     numeric(15,0) NOT NULL DEFAULT 0,
  fixed_sales_total   numeric(15,0) NOT NULL DEFAULT 0,
  fixed_advance_total numeric(15,0) NOT NULL DEFAULT 0,
  sales_total         numeric(15,0) NOT NULL DEFAULT 0,
  advance_total       numeric(15,0) NOT NULL DEFAULT 0,
  uncollected_total   numeric(15,0) NOT NULL DEFAULT 0,
  prev_billed_amount  numeric(15,0) NOT NULL DEFAULT 0,
  is_exported         boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, partner_id) REFERENCES business_partners(tenant_id, id)
);

CREATE TABLE aplus_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  created_date    date NOT NULL,
  transfer_date   date NOT NULL,
  customer_no     text NOT NULL,
  contractor_name text,
  contract_amount numeric(15,0) NOT NULL DEFAULT 0,
  billed_amount   numeric(15,0) NOT NULL DEFAULT 0,
  settled_amount  numeric(15,0) NOT NULL DEFAULT 0,
  unpaid_amount   numeric(15,0) NOT NULL DEFAULT 0,
  result_code     text NOT NULL,
  result_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

-- 添付画像（旧30枠×2＝60列の1:N正規化）
CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  entity_type   text NOT NULL CHECK (entity_type IN ('PROJECT', 'QUOTATION')),
  entity_id     uuid NOT NULL,
  sort_order    integer NOT NULL DEFAULT 1,
  storage_key   text NOT NULL,
  original_name text NOT NULL,
  mime_type     text NOT NULL,
  file_size     bigint NOT NULL CHECK (file_size > 0),
  comment       text,
  uploaded_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_type, entity_id, sort_order),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES employees(tenant_id, id)
);

-- 社内チャット (旧 T_チャット)
CREATE TABLE internal_chats (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  employee_id  uuid,
  staff_code   text,
  staff_name   text NOT NULL,
  question     text NOT NULL,
  asked_at     timestamptz NOT NULL DEFAULT now(),
  answer       text,
  answered_at  timestamptz,
  is_resolved  boolean NOT NULL DEFAULT false,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);

-- イミュータブル帳票スナップショット (旧 M_SharePoint 完全代替)
CREATE TABLE document_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  document_type      document_type NOT NULL,
  source_entity_type text NOT NULL CHECK (
    source_entity_type IN ('QUOTATION', 'PURCHASE_ORDER', 'SALES_HEADER', 'BILLING_HEADER', 'CASH_RECEIPT')
  ),
  source_entity_id   uuid NOT NULL,
  document_no        text NOT NULL,
  version_no         integer NOT NULL CHECK (version_no >= 1),
  is_reissue         boolean NOT NULL DEFAULT false,
  reissue_label      text,
  template_variant   text NOT NULL DEFAULT 'STANDARD',
  issued_at          timestamptz NOT NULL DEFAULT now(),
  issued_by          uuid,
  payload_json       jsonb NOT NULL,
  payload_sha256     char(64) NOT NULL,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, document_type, source_entity_id, version_no),
  FOREIGN KEY (tenant_id, issued_by) REFERENCES employees(tenant_id, id)
);

CREATE INDEX idx_doc_snapshots_lookup
  ON document_snapshots (tenant_id, document_type, source_entity_id, version_no DESC);

-- ----------------------------------------------------------------------------
-- 7. 整合性・不変・基準日ロック トリガー定義
-- ----------------------------------------------------------------------------

-- (A) document_snapshots の UPDATE 完全禁止・通常運用時 DELETE 禁止（特権パージ除く）
CREATE OR REPLACE FUNCTION prevent_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_user <> 'vendas_app'
     AND current_setting('app.allow_tenant_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'document_snapshots は不変テーブルのため UPDATE / DELETE できません';
END;
$$;

CREATE TRIGGER trg_document_snapshots_immutable
  BEFORE UPDATE OR DELETE ON document_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_snapshot_mutation();

-- (B) 期首残高基準日以前の確定取引変更禁止トリガー（是正4：purchases の P1/P2 仕掛対応）
CREATE OR REPLACE FUNCTION prevent_mutation_on_or_before_cutoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_cutoff   date;
  v_tenant   uuid;
  v_old_date date;
  v_new_date date;
BEGIN
  IF current_setting('app.etl_bypass_cutoff', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);
  SELECT opening_balance_date INTO v_cutoff
    FROM tenant_settings
   WHERE tenant_id = v_tenant;

  IF v_cutoff IS NULL THEN
    RAISE EXCEPTION 'tenant_settings が未登録のため基準日チェックを実行できません (tenant_id=%)', v_tenant;
  END IF;

  IF TG_TABLE_NAME = 'purchases' THEN
    -- 仕入テーブルは「status = P3（仕入済）かつ purchase_date <= v_cutoff」のみ禁止。
    -- P1/P2 の仕掛データ編集および purchase_date > v_cutoff への P3 確定は許可する。
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      IF OLD.status = 'P3' AND OLD.purchase_date <= v_cutoff THEN
        RAISE EXCEPTION '期首残高基準日(%)以前の確定済仕入(P3, %)は変更・削除できません', v_cutoff, OLD.purchase_date;
      END IF;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      IF NEW.status = 'P3' AND NEW.purchase_date <= v_cutoff THEN
        RAISE EXCEPTION '期首残高基準日(%)以前の日付(%)で仕入済(P3)の登録・確定はできません', v_cutoff, NEW.purchase_date;
      END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- billing_headers / cash_receipts / payable_ledgers / supplier_payments
  CASE TG_TABLE_NAME
    WHEN 'billing_headers' THEN
      v_old_date := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD.billing_date ELSE NULL END;
      v_new_date := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.billing_date ELSE NULL END;
    WHEN 'cash_receipts' THEN
      v_old_date := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD.receipt_date ELSE NULL END;
      v_new_date := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.receipt_date ELSE NULL END;
    WHEN 'payable_ledgers' THEN
      v_old_date := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD.purchase_date ELSE NULL END;
      v_new_date := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.purchase_date ELSE NULL END;
    WHEN 'supplier_payments' THEN
      v_old_date := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN OLD.payment_date ELSE NULL END;
      v_new_date := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN NEW.payment_date ELSE NULL END;
  END CASE;

  IF v_old_date IS NOT NULL AND v_old_date <= v_cutoff THEN
    RAISE EXCEPTION '期首残高基準日(%)以前のデータ(%)は変更・削除できません (%)', v_cutoff, v_old_date, TG_TABLE_NAME;
  END IF;
  IF v_new_date IS NOT NULL AND v_new_date <= v_cutoff THEN
    RAISE EXCEPTION '期首残高基準日(%)以前の日付(%)での登録・変更はできません (%)', v_cutoff, v_new_date, TG_TABLE_NAME;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_cutoff_billing_headers
  BEFORE INSERT OR UPDATE OR DELETE ON billing_headers
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation_on_or_before_cutoff();

CREATE TRIGGER trg_cutoff_cash_receipts
  BEFORE INSERT OR UPDATE OR DELETE ON cash_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation_on_or_before_cutoff();

CREATE TRIGGER trg_cutoff_payable_ledgers
  BEFORE INSERT OR UPDATE OR DELETE ON payable_ledgers
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation_on_or_before_cutoff();

CREATE TRIGGER trg_cutoff_supplier_payments
  BEFORE INSERT OR UPDATE OR DELETE ON supplier_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation_on_or_before_cutoff();

CREATE TRIGGER trg_cutoff_purchases
  BEFORE INSERT OR UPDATE OR DELETE ON purchases
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation_on_or_before_cutoff();

-- (C) 請求済売上 (K4/K5) の改変ロック（明示的請求取消・再発行トランザクション以外禁止）
CREATE OR REPLACE FUNCTION prevent_billed_sales_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status sales_status;
BEGIN
  IF current_setting('app.allow_billing_transition', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_TABLE_NAME = 'sales_headers' THEN
    IF OLD.status IN ('K4', 'K5') THEN
      RAISE EXCEPTION '請求済み(K4/K5)の売上・立替データは修正・削除できません';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- sales_lines の場合
  SELECT status INTO v_status
    FROM sales_headers
   WHERE id = COALESCE(NEW.sales_header_id, OLD.sales_header_id);
  IF v_status IN ('K4', 'K5') THEN
    RAISE EXCEPTION '請求済み(K4/K5)に紐づく明細行は追加・変更・削除できません';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_lock_billed_sales_headers
  BEFORE UPDATE OR DELETE ON sales_headers
  FOR EACH ROW EXECUTE FUNCTION prevent_billed_sales_mutation();

CREATE TRIGGER trg_lock_billed_sales_lines
  BEFORE INSERT OR UPDATE OR DELETE ON sales_lines
  FOR EACH ROW EXECUTE FUNCTION prevent_billed_sales_mutation();

-- (D) updated_at 自動更新トリガー
CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tenant_settings_updated_at BEFORE UPDATE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tenant_feature_authorities_updated_at BEFORE UPDATE ON tenant_feature_authorities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_banks_updated_at BEFORE UPDATE ON banks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_bank_branches_updated_at BEFORE UPDATE ON bank_branches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tax_offices_updated_at BEFORE UPDATE ON tax_offices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_units_updated_at BEFORE UPDATE ON units FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tax_codes_updated_at BEFORE UPDATE ON tax_codes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payment_methods_updated_at BEFORE UPDATE ON payment_methods FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_code_masters_updated_at BEFORE UPDATE ON code_masters FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_representatives_updated_at BEFORE UPDATE ON representatives FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_business_partners_updated_at BEFORE UPDATE ON business_partners FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_partner_advisory_profiles_updated_at BEFORE UPDATE ON partner_advisory_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_input_intelligences_updated_at BEFORE UPDATE ON input_intelligences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_mail_templates_updated_at BEFORE UPDATE ON mail_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_quotations_updated_at BEFORE UPDATE ON quotations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_quotation_lines_updated_at BEFORE UPDATE ON quotation_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_purchase_orders_updated_at BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_purchase_order_lines_updated_at BEFORE UPDATE ON purchase_order_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_purchases_updated_at BEFORE UPDATE ON purchases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_purchase_lines_updated_at BEFORE UPDATE ON purchase_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_project_cost_headers_updated_at BEFORE UPDATE ON project_cost_headers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_project_cost_lines_updated_at BEFORE UPDATE ON project_cost_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_payable_ledgers_updated_at BEFORE UPDATE ON payable_ledgers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_supplier_payments_updated_at BEFORE UPDATE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_billing_headers_updated_at BEFORE UPDATE ON billing_headers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sales_headers_updated_at BEFORE UPDATE ON sales_headers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sales_lines_updated_at BEFORE UPDATE ON sales_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subscription_contracts_updated_at BEFORE UPDATE ON subscription_contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_subscription_approval_flows_updated_at BEFORE UPDATE ON subscription_approval_flows FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_cash_receipts_updated_at BEFORE UPDATE ON cash_receipts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
