CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM ('active', 'trial', 'lost');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE health_band AS ENUM ('green', 'yellow', 'red');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE signal_type AS ENUM ('risk', 'win', 'blocker', 'goal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE touch_channel AS ENUM ('call', 'email', 'onsite', 'virtual', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE likelihood AS ENUM ('high', 'medium', 'low');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  segment TEXT,
  industry TEXT,
  tier TEXT,
  city TEXT,
  state TEXT,
  website TEXT,
  csm_owner TEXT,
  ae_owner TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  arr NUMERIC(12,2) NOT NULL DEFAULT 0,
  mrr NUMERIC(12,2) NOT NULL DEFAULT 0,
  start_date DATE,
  renewal_date DATE,
  term_months INT,
  seats INT,
  product_tier TEXT,
  status subscription_status NOT NULL DEFAULT 'active',
  auto_renew BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  score INT CHECK (score BETWEEN 0 AND 100),
  band health_band NOT NULL,
  usage_score INT,
  support_load INT,
  sentiment INT,
  executive_engagement INT,
  time_since_touch INT,
  open_risk_count INT,
  billing_flags BOOLEAN DEFAULT FALSE,
  explanations JSONB,
  is_override BOOLEAN NOT NULL DEFAULT FALSE,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type signal_type NOT NULL,
  tag TEXT,
  context TEXT,
  source TEXT,
  severity INT,
  status TEXT DEFAULT 'open',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS touchpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  channel touch_channel NOT NULL,
  summary TEXT,
  next_step TEXT,
  next_step_due DATE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS success_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  owner TEXT,
  target_date DATE,
  status TEXT DEFAULT 'in_progress',
  proof_of_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  renewal_likelihood likelihood,
  expansion_prob likelihood,
  downgrade_risk BOOLEAN DEFAULT FALSE,
  churn_risk BOOLEAN DEFAULT FALSE,
  notes TEXT,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_date DATE NOT NULL,
  feature TEXT,
  metric TEXT,
  value NUMERIC
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id TEXT,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  severity INT,
  status TEXT
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  responded_at TIMESTAMPTZ NOT NULL,
  type TEXT,
  score INT,
  comment TEXT
);

CREATE OR REPLACE VIEW account_current_health AS
SELECT DISTINCT ON (account_id)
  account_id, id as snapshot_id, score, band, usage_score, support_load, sentiment,
  executive_engagement, time_since_touch, open_risk_count, billing_flags, explanations,
  is_override, computed_at
FROM health_snapshots
ORDER BY account_id, is_override DESC, computed_at DESC;

CREATE INDEX IF NOT EXISTS idx_accounts_name ON accounts (name);
CREATE INDEX IF NOT EXISTS idx_subscriptions_renewal_date ON subscriptions (renewal_date);
CREATE INDEX IF NOT EXISTS idx_touchpoints_account_date ON touchpoints (account_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_health_account_computed ON health_snapshots (account_id, computed_at DESC);
