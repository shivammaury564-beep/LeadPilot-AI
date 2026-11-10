-- =============================================================================
-- LeadPilot AI — Production Supabase PostgreSQL Migration & RLS Security Schema
-- =============================================================================
-- Run this migration in the Supabase SQL Editor or via `supabase db push`.
-- Enforces strict tenant isolation (auth.uid()), normalized duplicate indexes,
-- automatic profile provisioning, and database-level Opt-Out compliance locks.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. PROFILES TABLE (1:1 with auth.users)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT 'Agency Founder' CHECK (char_length(btrim(full_name)) BETWEEN 1 AND 120),
  agency_name TEXT NOT NULL DEFAULT 'Northstar Web Studio' CHECK (char_length(agency_name) <= 160),
  daily_target INTEGER NOT NULL DEFAULT 60 CHECK (daily_target BETWEEN 1 AND 500),
  default_city TEXT NOT NULL DEFAULT 'Mumbai' CHECK (char_length(default_city) <= 100),
  default_category TEXT NOT NULL DEFAULT 'Premium salons' CHECK (char_length(default_category) <= 100),
  research_priority TEXT NOT NULL DEFAULT 'missing_website'
    CHECK (research_priority IN ('missing_website', 'outdated_website', 'all')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 2. LEADS TABLE (User-owned business prospects)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL CHECK (char_length(btrim(business_name)) BETWEEN 1 AND 200),
  category TEXT NOT NULL DEFAULT 'Premium salons' CHECK (char_length(btrim(category)) BETWEEN 1 AND 100),
  city TEXT NOT NULL DEFAULT '' CHECK (char_length(city) <= 100),
  state TEXT NOT NULL DEFAULT '' CHECK (char_length(state) <= 100),
  country TEXT NOT NULL DEFAULT '' CHECK (char_length(country) <= 100),
  address TEXT NOT NULL DEFAULT '' CHECK (char_length(address) <= 400),
  phone TEXT NOT NULL DEFAULT '' CHECK (char_length(phone) <= 60),
  website_url TEXT NOT NULL DEFAULT '' CHECK (char_length(website_url) <= 500),
  website_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (website_status IN ('missing_verified', 'outdated_verified', 'modern_verified', 'unverified')),
  has_online_booking BOOLEAN NOT NULL DEFAULT FALSE,
  is_premium_service BOOLEAN NOT NULL DEFAULT FALSE,
  has_active_public_profile BOOLEAN NOT NULL DEFAULT TRUE,
  instagram_url TEXT NOT NULL DEFAULT '' CHECK (char_length(instagram_url) <= 500),
  facebook_url TEXT NOT NULL DEFAULT '' CHECK (char_length(facebook_url) <= 500),
  google_place_id TEXT NOT NULL DEFAULT '' CHECK (char_length(google_place_id) <= 200),
  google_maps_url TEXT NOT NULL DEFAULT '' CHECK (char_length(google_maps_url) <= 600),
  rating NUMERIC(3, 2) NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5.0),
  review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  lead_score INTEGER NOT NULL DEFAULT 0 CHECK (lead_score BETWEEN 0 AND 100),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('google_places', 'instagram', 'facebook', 'manual', 'chrome_extension')),
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('verified', 'unverified', 'needs_review')),
  last_verified_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN (
      'new', 'researching', 'qualified', 'draft_ready', 'approved',
      'contacted', 'replied', 'interested', 'demo_sent', 'negotiation',
      'converted', 'not_interested', 'opted_out'
    )),
  notes TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
  tags TEXT NOT NULL DEFAULT '' CHECK (char_length(tags) <= 500),
  last_contacted_at TIMESTAMPTZ,
  next_follow_up_at TIMESTAMPTZ,
  ai_research_json JSONB,
  lat DOUBLE PRECISION CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  lng DOUBLE PRECISION CHECK (lng IS NULL OR (lng >= -180 AND lng <= 180)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 3. MESSAGES TABLE (Human-in-the-loop outreach drafts & logs)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  lead_business_name TEXT NOT NULL DEFAULT '' CHECK (char_length(lead_business_name) <= 200),
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook', 'whatsapp', 'email')),
  message_body TEXT NOT NULL CHECK (char_length(btrim(message_body)) BETWEEN 1 AND 4000),
  language TEXT NOT NULL DEFAULT 'English' CHECK (language IN ('English', 'Hindi', 'Hinglish')),
  tone TEXT NOT NULL DEFAULT 'Friendly'
    CHECK (tone IN ('Friendly', 'Professional', 'Premium', 'Short and natural')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'sent', 'replied', 'opted_out')),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  reply_notes TEXT NOT NULL DEFAULT '' CHECK (char_length(reply_notes) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 4. ACTIVITIES TABLE (Immutable CRM audit trail per lead)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL CHECK (char_length(btrim(activity_type)) BETWEEN 1 AND 80),
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 5. FOLLOWUPS TABLE (Scheduled prospect touchpoints)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  lead_business_name TEXT NOT NULL DEFAULT '' CHECK (char_length(lead_business_name) <= 200),
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'cancelled')),
  notes TEXT NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 6. INTEGRATIONS TABLE (Per-user integration status tracking)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL
    CHECK (provider IN ('google_places', 'gemini_ai', 'supabase_db', 'meta_instagram', 'meta_facebook', 'chrome_extension')),
  connection_status TEXT NOT NULL DEFAULT 'connected'
    CHECK (connection_status IN ('connected', 'manual_mode', 'action_required', 'disconnected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- -----------------------------------------------------------------------------
-- INDEXES & DUPLICATE PREVENTION CONSTRAINTS
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_leads_user_id_status ON public.leads(user_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_user_id_score ON public.leads(user_id, lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_user_id_city ON public.leads(user_id, city);
CREATE INDEX IF NOT EXISTS idx_leads_user_id_created ON public.leads(user_id, created_at DESC);

-- Prevent duplicate Google Place IDs per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique_place_per_user
  ON public.leads(user_id, btrim(google_place_id))
  WHERE google_place_id IS NOT NULL AND btrim(google_place_id) <> '';

-- Prevent duplicate normalized Instagram URLs per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique_instagram_per_user
  ON public.leads(user_id, lower(btrim(instagram_url)))
  WHERE instagram_url IS NOT NULL AND btrim(instagram_url) <> '';

-- Prevent duplicate normalized Facebook URLs per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_unique_facebook_per_user
  ON public.leads(user_id, lower(btrim(facebook_url)))
  WHERE facebook_url IS NOT NULL AND btrim(facebook_url) <> '';

CREATE INDEX IF NOT EXISTS idx_messages_user_lead ON public.messages(user_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_user_lead ON public.activities(user_id, lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_followups_user_scheduled ON public.followups(user_id, status, scheduled_at ASC);

-- -----------------------------------------------------------------------------
-- TRIGGERS: TIMESTAMPS, OPT-OUT COMPLIANCE LOCKS & PROFILE PROVISIONING
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Strict Opt-Out Compliance Guard on public.leads:
-- Once a lead is marked 'opted_out', it can NEVER transition to any other status.
CREATE OR REPLACE FUNCTION public.prevent_opted_out_reentry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'opted_out' AND NEW.status <> 'opted_out' THEN
    RAISE EXCEPTION 'Compliance Lock: Opted-out leads cannot re-enter outreach workflows or change status.';
  END IF;
  RETURN NEW;
END;
$$;

-- Strict Opt-Out Compliance Guard on public.messages:
-- Blocks creating or updating outreach messages (draft/approved/sent) for opted-out leads.
CREATE OR REPLACE FUNCTION public.prevent_messages_for_opted_out_lead()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_status TEXT;
BEGIN
  SELECT status INTO v_lead_status
  FROM public.leads
  WHERE id = NEW.lead_id AND user_id = NEW.user_id;

  IF v_lead_status = 'opted_out' AND NEW.status <> 'opted_out' THEN
    RAISE EXCEPTION 'Compliance Lock: Cannot draft, approve, or send outreach messages for an opted-out lead.';
  END IF;
  RETURN NEW;
END;
$$;

-- Automatic Profile Provisioning on Supabase Auth Signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, agency_name, daily_target, default_city, default_category)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(btrim(NEW.raw_user_meta_data->>'full_name'), ''), 'Agency Founder'),
    COALESCE(NULLIF(btrim(NEW.raw_user_meta_data->>'agency_name'), ''), 'Northstar Web Studio'),
    60,
    'Mumbai',
    'Premium salons'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_leads_updated_at ON public.leads;
CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_leads_opt_out_guard ON public.leads;
CREATE TRIGGER trg_leads_opt_out_guard BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.prevent_opted_out_reentry();

DROP TRIGGER IF EXISTS trg_messages_updated_at ON public.messages;
CREATE TRIGGER trg_messages_updated_at BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_messages_opt_out_guard ON public.messages;
CREATE TRIGGER trg_messages_opt_out_guard BEFORE INSERT OR UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.prevent_messages_for_opted_out_lead();

DROP TRIGGER IF EXISTS trg_followups_updated_at ON public.followups;
CREATE TRIGGER trg_followups_updated_at BEFORE UPDATE ON public.followups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_integrations_updated_at ON public.integrations;
CREATE TRIGGER trg_integrations_updated_at BEFORE UPDATE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- ROW LEVEL SECURITY (RLS) POLICIES — STRICT PER-USER ISOLATION
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owners
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.leads FORCE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.activities FORCE ROW LEVEL SECURITY;
ALTER TABLE public.followups FORCE ROW LEVEL SECURITY;
ALTER TABLE public.integrations FORCE ROW LEVEL SECURITY;

-- 1. Profiles Policies
DROP POLICY IF EXISTS "Users manage own profile" ON public.profiles;
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles;

CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_delete_own" ON public.profiles
  FOR DELETE TO authenticated USING (auth.uid() = id);

-- 2. Leads Policies
DROP POLICY IF EXISTS "Users manage own leads" ON public.leads;
DROP POLICY IF EXISTS "leads_select_own" ON public.leads;
DROP POLICY IF EXISTS "leads_insert_own" ON public.leads;
DROP POLICY IF EXISTS "leads_update_own" ON public.leads;
DROP POLICY IF EXISTS "leads_delete_own" ON public.leads;

CREATE POLICY "leads_select_own" ON public.leads
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "leads_insert_own" ON public.leads
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "leads_update_own" ON public.leads
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "leads_delete_own" ON public.leads
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 3. Messages Policies
DROP POLICY IF EXISTS "Users manage own messages" ON public.messages;
DROP POLICY IF EXISTS "messages_select_own" ON public.messages;
DROP POLICY IF EXISTS "messages_insert_own" ON public.messages;
DROP POLICY IF EXISTS "messages_update_own" ON public.messages;
DROP POLICY IF EXISTS "messages_delete_own" ON public.messages;

CREATE POLICY "messages_select_own" ON public.messages
  FOR SELECT TO authenticated USING (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id AND l.user_id = auth.uid())
  );
CREATE POLICY "messages_insert_own" ON public.messages
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id AND l.user_id = auth.uid())
  );
CREATE POLICY "messages_update_own" ON public.messages
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id AND l.user_id = auth.uid())
  );
CREATE POLICY "messages_delete_own" ON public.messages
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 4. Activities Policies
DROP POLICY IF EXISTS "Users manage own activities" ON public.activities;
DROP POLICY IF EXISTS "activities_select_own" ON public.activities;
DROP POLICY IF EXISTS "activities_insert_own" ON public.activities;
DROP POLICY IF EXISTS "activities_delete_own" ON public.activities;

CREATE POLICY "activities_select_own" ON public.activities
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "activities_insert_own" ON public.activities
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id AND l.user_id = auth.uid())
  );
CREATE POLICY "activities_delete_own" ON public.activities
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 5. Followups Policies
DROP POLICY IF EXISTS "Users manage own followups" ON public.followups;
DROP POLICY IF EXISTS "followups_select_own" ON public.followups;
DROP POLICY IF EXISTS "followups_insert_own" ON public.followups;
DROP POLICY IF EXISTS "followups_update_own" ON public.followups;
DROP POLICY IF EXISTS "followups_delete_own" ON public.followups;

CREATE POLICY "followups_select_own" ON public.followups
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "followups_insert_own" ON public.followups
  FOR INSERT TO authenticated WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (SELECT 1 FROM public.leads l WHERE l.id = lead_id AND l.user_id = auth.uid())
  );
CREATE POLICY "followups_update_own" ON public.followups
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "followups_delete_own" ON public.followups
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- 6. Integrations Policies
DROP POLICY IF EXISTS "Users manage own integrations" ON public.integrations;
DROP POLICY IF EXISTS "integrations_select_own" ON public.integrations;
DROP POLICY IF EXISTS "integrations_insert_own" ON public.integrations;
DROP POLICY IF EXISTS "integrations_update_own" ON public.integrations;
DROP POLICY IF EXISTS "integrations_delete_own" ON public.integrations;

CREATE POLICY "integrations_select_own" ON public.integrations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "integrations_insert_own" ON public.integrations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "integrations_update_own" ON public.integrations
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "integrations_delete_own" ON public.integrations
  FOR DELETE TO authenticated USING (auth.uid() = user_id);
