-- PostgreSQL Schema for Vetto.in Decision Engine
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. BASE AUDITS TABLE
CREATE TABLE IF NOT EXISTS audits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_query VARCHAR(255) NOT NULL UNIQUE,
    resolved_product VARCHAR(255) NOT NULL,
    category VARCHAR(50) NOT NULL CHECK (category IN ('electronics', 'fashion', 'automotive')),
    recommendation VARCHAR(10) NOT NULL CHECK (recommendation IN ('BUY', 'SKIP', 'WAIT')),
    value_for_money_score INT NOT NULL CHECK (value_for_money_score BETWEEN 0 AND 100),
    brand_markup_inr NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
    hook_statement TEXT NOT NULL,
    reasoning_summary TEXT NOT NULL,
    extra_costs_to_watch TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. ELECTRONICS-SPECIFIC AUDITS
CREATE TABLE IF NOT EXISTS electronics_audits (
    audit_id UUID PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE,
    bottleneck_warning VARCHAR(255) NOT NULL,
    heat_slowdown_index INT NOT NULL CHECK (heat_slowdown_index BETWEEN 0 AND 100),
    longevity_rating_years INT NOT NULL CHECK (longevity_rating_years > 0)
);

-- 3. FASHION-SPECIFIC AUDITS
CREATE TABLE IF NOT EXISTS fashion_audits (
    audit_id UUID PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE,
    material_honesty_score INT NOT NULL CHECK (material_honesty_score BETWEEN 0 AND 100),
    fabric_thickness_gsm INT NOT NULL CHECK (fabric_thickness_gsm > 0),
    wash_durability VARCHAR(255) NOT NULL,
    sizing_alert VARCHAR(255) NOT NULL
);

-- 4. AUTOMOTIVE-SPECIFIC AUDITS
CREATE TABLE IF NOT EXISTS automotive_audits (
    audit_id UUID PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE,
    running_cost_5yr_inr NUMERIC(12, 2) NOT NULL CHECK (running_cost_5yr_inr >= 0),
    crash_safety_rating VARCHAR(100) NOT NULL
);

-- 5. RESALE RETENTION DATA (AUTOMOTIVE)
CREATE TABLE IF NOT EXISTS resale_retention_curves (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    year INT NOT NULL CHECK (year BETWEEN 1 AND 5),
    retention_percentage INT NOT NULL CHECK (retention_percentage BETWEEN 0 AND 100),
    UNIQUE (audit_id, year)
);

-- 6. LIVE PROCUREMENT DEALS (Allowed Domains Enforced)
CREATE TABLE IF NOT EXISTS procurement_deals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    platform VARCHAR(100) NOT NULL,
    price_inr NUMERIC(12, 2) NOT NULL,
    deal_url TEXT NOT NULL,
    stock_status VARCHAR(50) NOT NULL,
    is_best_deal BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 7. PRICE HISTORY (For Congruency Graph)
CREATE TABLE IF NOT EXISTS price_history_nodes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    month_name VARCHAR(20) NOT NULL,
    price_inr NUMERIC(12, 2) NOT NULL,
    node_order INT NOT NULL,
    UNIQUE (audit_id, node_order)
);

-- 8. MARKETING HYPED WORDS EXPOSED (Jargon Demystifier)
CREATE TABLE IF NOT EXISTS jargon_demystifier (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    audit_id UUID NOT NULL REFERENCES audits(id) ON DELETE CASCADE,
    buzzword VARCHAR(150) NOT NULL,
    honest_truth TEXT NOT NULL
);

-- 9. SOCIAL COMMUNITY GRIPIES (REDDIT, YOUTUBE, X)
CREATE TABLE IF NOT EXISTS community_sentiment (
    audit_id UUID PRIMARY KEY REFERENCES audits(id) ON DELETE CASCADE,
    reddit_consensus TEXT NOT NULL,
    reddit_sentiment_label VARCHAR(20) NOT NULL,
    youtube_consensus TEXT NOT NULL,
    youtube_sentiment_label VARCHAR(20) NOT NULL,
    x_consensus TEXT NOT NULL,
    x_sentiment_label VARCHAR(20) NOT NULL
);

-- INDEXES FOR LATENCY ACCELERATION
CREATE INDEX IF NOT EXISTS idx_audits_category ON audits(category);
CREATE INDEX IF NOT EXISTS idx_audits_user_query ON audits(user_query);
CREATE INDEX IF NOT EXISTS idx_procurement_deals_best ON procurement_deals(audit_id, is_best_deal);
CREATE INDEX IF NOT EXISTS idx_price_history_order ON price_history_nodes(audit_id, node_order);
