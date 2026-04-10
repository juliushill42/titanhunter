-- ============================================================
-- Hunter Real Estate System — Database Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for fuzzy address search

-- ── Crawl Jobs ───────────────────────────────────────────────
CREATE TABLE crawl_jobs (
  job_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  adapter_id    TEXT NOT NULL,
  market        TEXT NOT NULL,
  region        TEXT NOT NULL,
  params        JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'QUEUED',
  lead_count    INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  error_log     TEXT[] NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_crawl_jobs_status ON crawl_jobs(status);
CREATE INDEX idx_crawl_jobs_market ON crawl_jobs(market, created_at DESC);

-- ── Raw Leads ────────────────────────────────────────────────
CREATE TABLE raw_leads (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source          TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  raw_html        TEXT,
  raw_text        TEXT,
  crawled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  adapter_version TEXT NOT NULL,
  market_region   TEXT NOT NULL,
  batch_id        UUID NOT NULL REFERENCES crawl_jobs(job_id)
);
CREATE INDEX idx_raw_leads_batch ON raw_leads(batch_id);
CREATE INDEX idx_raw_leads_source ON raw_leads(source, crawled_at DESC);

-- ── Extracted Leads ──────────────────────────────────────────
CREATE TABLE extracted_leads (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  raw_lead_id          UUID NOT NULL REFERENCES raw_leads(id),
  property             JSONB NOT NULL DEFAULT '{}',
  contact              JSONB NOT NULL DEFAULT '{}',
  extracted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  extraction_model     TEXT NOT NULL,
  extraction_confidence DECIMAL(4,3) NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'EXTRACTED'
);
CREATE INDEX idx_extracted_status ON extracted_leads(status);
CREATE INDEX idx_extracted_property ON extracted_leads USING GIN(property);
CREATE INDEX idx_extracted_address ON extracted_leads USING GIN((property->>'address') gin_trgm_ops);

-- ── Ranked Leads ─────────────────────────────────────────────
CREATE TABLE ranked_leads (
  id              UUID PRIMARY KEY REFERENCES extracted_leads(id),
  total_score     INTEGER NOT NULL,
  tier            CHAR(1) NOT NULL,
  score_breakdown JSONB NOT NULL DEFAULT '{}',
  estimated_roi   DECIMAL(8,2),
  estimated_coc   DECIMAL(8,2),
  flags           TEXT[] NOT NULL DEFAULT '{}',
  ranked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ranked_score ON ranked_leads(total_score DESC);
CREATE INDEX idx_ranked_tier ON ranked_leads(tier, total_score DESC);
CREATE INDEX idx_ranked_flags ON ranked_leads USING GIN(flags);

-- ── Titan Wallets ────────────────────────────────────────────
CREATE TABLE titan_wallets (
  wallet_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            TEXT NOT NULL UNIQUE,
  balance            DECIMAL(14,2) NOT NULL DEFAULT 0.00,
  currency           CHAR(3) NOT NULL DEFAULT 'USD',
  stripe_customer_id TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT balance_non_negative CHECK (balance >= 0)
);
CREATE INDEX idx_wallets_user ON titan_wallets(user_id);

-- ── Wallet Transactions ──────────────────────────────────────
CREATE TABLE wallet_transactions (
  tx_id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_id                UUID NOT NULL REFERENCES titan_wallets(wallet_id),
  type                     TEXT NOT NULL,
  amount                   DECIMAL(14,2) NOT NULL,
  balance_before           DECIMAL(14,2) NOT NULL,
  balance_after            DECIMAL(14,2) NOT NULL,
  related_escrow_id        UUID,
  stripe_payment_intent_id TEXT,
  description              TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_txns_wallet ON wallet_transactions(wallet_id, created_at DESC);
CREATE INDEX idx_txns_escrow ON wallet_transactions(related_escrow_id);

-- ── Escrow Agreements ────────────────────────────────────────
CREATE TABLE escrow_agreements (
  escrow_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deal_id           TEXT NOT NULL,
  buyer_wallet_id   UUID NOT NULL REFERENCES titan_wallets(wallet_id),
  seller_wallet_id  UUID NOT NULL REFERENCES titan_wallets(wallet_id),
  amount            DECIMAL(14,2) NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'USD',
  conditions        JSONB NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'PENDING',
  multi_sig_tokens  JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disbursed_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_escrow_status ON escrow_agreements(status);
CREATE INDEX idx_escrow_deal ON escrow_agreements(deal_id);
CREATE INDEX idx_escrow_buyer ON escrow_agreements(buyer_wallet_id);

-- ── Export Jobs ──────────────────────────────────────────────
CREATE TABLE export_jobs (
  job_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  format        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'QUEUED',
  lead_ids      UUID[] NOT NULL DEFAULT '{}',
  output_url    TEXT,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_export_status ON export_jobs(status, created_at DESC);

-- ── Find-to-Close Tracker ─────────────────────────────────────
CREATE TABLE find_to_close (
  lead_id             UUID PRIMARY KEY REFERENCES extracted_leads(id),
  deal_id             TEXT,
  found_at            TIMESTAMPTZ NOT NULL,
  extracted_at        TIMESTAMPTZ,
  ranked_at           TIMESTAMPTZ,
  exported_at         TIMESTAMPTZ,
  escrow_created_at   TIMESTAMPTZ,
  escrow_funded_at    TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  current_status      TEXT NOT NULL DEFAULT 'FOUND',
  total_elapsed_hours DECIMAL(10,2)
);
CREATE INDEX idx_f2c_status ON find_to_close(current_status);
CREATE INDEX idx_f2c_found ON find_to_close(found_at DESC);
