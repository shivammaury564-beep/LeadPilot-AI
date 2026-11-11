import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  ActivityRecord,
  FollowupRecord,
  LeadRecord,
  MessageRecord,
  UserProfile,
} from '../types/leadpilot';
import {
  calculateLeadScore,
  detectDuplicateLead,
  recalculateLeadRecord,
  safeParseHttpResponse,
} from '../utils/scoringAndCrm';
import {
  INITIAL_DEMO_ACTIVITIES,
  INITIAL_DEMO_FOLLOWUPS,
  INITIAL_DEMO_LEADS,
  INITIAL_DEMO_MESSAGES,
  INITIAL_DEMO_PROFILE,
} from '../utils/demoData';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim() || '';
const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim() || '';

export const isSupabaseBrowserConfigured =
  Boolean(supabaseUrl && supabaseAnonKey) &&
  !supabaseUrl.includes('your-project-ref') &&
  supabaseAnonKey !== 'your-supabase-anon-public-key' &&
  /^https?:\/\/.+/i.test(supabaseUrl);

export const supabase: SupabaseClient | null = isSupabaseBrowserConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  agencyName: string;
  accessToken: string;
  authProvider: 'supabase' | 'local_rls';
}

const SESSION_STORAGE_KEY = 'leadpilot_auth_session_v1';
const LOCAL_WORKSPACE_LEADS_KEY = 'leadpilot_local_leads_v1';

export function getStoredSession(): SessionUser | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionUser;
    if (parsed && parsed.id && parsed.accessToken) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function setStoredSession(session: SessionUser | null) {
  try {
    if (!session) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } else {
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // ignore storage errors in restricted contexts
  }
}

/**
 * Authenticated Fetch Wrapper — Automatically attaches Authorization: Bearer <token>
 * to every protected backend API call.
 */
export async function authenticatedFetch(
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const session = getStoredSession();
  const headers = new Headers(init.headers || {});
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (session?.accessToken) {
    headers.set('Authorization', `Bearer ${session.accessToken}`);
  }
  return fetch(input, {
    ...init,
    headers,
  });
}

export async function initializeAuthSession(): Promise<{
  user: SessionUser;
  profile: UserProfile;
} | null> {
  // 1. Check Supabase browser session if configured
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) {
      const u = data.session.user;
      const supaSession: SessionUser = {
        id: u.id,
        email: u.email || '',
        fullName: String(u.user_metadata?.full_name || 'Agency Founder'),
        agencyName: String(u.user_metadata?.agency_name || 'Northstar Web Studio'),
        accessToken: data.session.access_token,
        authProvider: 'supabase',
      };
      setStoredSession(supaSession);
    }
  }

  // 2. Verify existing stored token with backend safely (never blindly call .json())
  const existing = getStoredSession();
  if (existing) {
    try {
      const verifyRes = await authenticatedFetch('/api/auth/me');
      const parsed = await safeParseHttpResponse<Record<string, any>>(verifyRes, 'Auth Verify');
      if (parsed.ok && parsed.data?.user && parsed.data?.profile) {
        const refreshed: SessionUser = {
          ...existing,
          ...parsed.data.user,
          accessToken: existing.accessToken,
        };
        setStoredSession(refreshed);
        return { user: refreshed, profile: parsed.data.profile };
      }
      if (parsed.isNotFoundPage) {
        return {
          user: existing,
          profile: {
            ...INITIAL_DEMO_PROFILE,
            userId: existing.id,
            fullName: existing.fullName,
            agencyName: existing.agencyName,
          },
        };
      }
    } catch {
      // Fall through to bootstrap session
    }
  }

  // 3. Provision default authenticated founder workspace session so the app boots authenticated
  try {
    const bootstrapRes = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const parsedBootstrap = await safeParseHttpResponse<Record<string, any>>(
      bootstrapRes,
      'Auth Bootstrap'
    );
    if (parsedBootstrap.ok && parsedBootstrap.data?.user && parsedBootstrap.data?.profile) {
      setStoredSession(parsedBootstrap.data.user);
      return { user: parsedBootstrap.data.user, profile: parsedBootstrap.data.profile };
    }
  } catch {
    // Fallback if running in static preview without backend server
  }

  const fallbackUser: SessionUser = existing || {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'founder@northstarstudio.in',
    fullName: INITIAL_DEMO_PROFILE.fullName,
    agencyName: INITIAL_DEMO_PROFILE.agencyName,
    accessToken: 'local-rls-fallback-token',
    authProvider: 'local_rls',
  };
  setStoredSession(fallbackUser);
  return {
    user: fallbackUser,
    profile: { ...INITIAL_DEMO_PROFILE, userId: fallbackUser.id },
  };
}

export async function loginWithEmailPassword(
  email: string,
  password: string
): Promise<{ user: SessionUser; profile: UserProfile }> {
  if (supabase) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data.user && data.session) {
      const supaUser: SessionUser = {
        id: data.user.id,
        email: data.user.email || email,
        fullName: String(data.user.user_metadata?.full_name || 'Agency Founder'),
        agencyName: String(data.user.user_metadata?.agency_name || 'Northstar Web Studio'),
        accessToken: data.session.access_token,
        authProvider: 'supabase',
      };
      setStoredSession(supaUser);
      return {
        user: supaUser,
        profile: {
          ...INITIAL_DEMO_PROFILE,
          userId: supaUser.id,
          fullName: supaUser.fullName,
          agencyName: supaUser.agencyName,
        },
      };
    }
  }

  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const parsed = await safeParseHttpResponse<Record<string, any>>(res, 'Sign In');
  if (!parsed.ok || !parsed.data?.user) {
    throw new Error(parsed.errorMessage || 'Sign in failed.');
  }
  setStoredSession(parsed.data.user);
  return { user: parsed.data.user, profile: parsed.data.profile };
}

export async function registerWithEmailPassword(
  emailOrInput:
    | string
    | {
        email: string;
        password: string;
        fullName: string;
        agencyName: string;
      },
  password?: string,
  fullName?: string,
  agencyName?: string
): Promise<{ user: SessionUser; profile: UserProfile }> {
  const payload =
    typeof emailOrInput === 'string'
      ? {
          email: emailOrInput,
          password: password || '',
          fullName: fullName || 'Agency Founder',
          agencyName: agencyName || 'Northstar Web Studio',
        }
      : emailOrInput;

  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await safeParseHttpResponse<Record<string, any>>(res, 'Account Registration');
  if (!parsed.ok || !parsed.data?.user) {
    throw new Error(parsed.errorMessage || 'Account registration failed.');
  }
  setStoredSession(parsed.data.user);
  return { user: parsed.data.user, profile: parsed.data.profile };
}

export async function signOutSession(): Promise<void> {
  if (supabase) {
    await supabase.auth.signOut().catch(() => null);
  }
  setStoredSession(null);
}

export function getLocalFallbackLeads(userId: string): LeadRecord[] {
  try {
    const raw = localStorage.getItem(`${LOCAL_WORKSPACE_LEADS_KEY}_${userId}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((l) => recalculateLeadRecord(l));
      }
    }
  } catch {
    // ignore storage errors
  }
  return INITIAL_DEMO_LEADS.map((l) => recalculateLeadRecord({ ...l, userId }));
}

export function saveLocalFallbackLeads(userId: string, leads: LeadRecord[]): void {
  try {
    localStorage.setItem(`${LOCAL_WORKSPACE_LEADS_KEY}_${userId}`, JSON.stringify(leads));
  } catch {
    // ignore storage errors
  }
}

export async function saveLeadViaSupabaseClient(
  user: SessionUser,
  candidate: Partial<LeadRecord>,
  existingLeads: LeadRecord[],
  existingId?: string
): Promise<{ saved: boolean; lead?: LeadRecord; message: string }> {
  if (!user?.id) {
    return { saved: false, message: 'Authenticated user session is required to save leads.' };
  }

  const dup = detectDuplicateLead(candidate, existingLeads, existingId);
  if (!existingId && dup.isDuplicate) {
    return {
      saved: false,
      lead: dup.matchedLead,
      message: dup.reason || 'Duplicate lead detected in CRM.',
    };
  }

  const nowIso = new Date().toISOString();
  const existing = existingId ? existingLeads.find((l) => l.id === existingId) : undefined;
  const businessName = String(candidate.businessName ?? existing?.businessName ?? '').trim();
  if (!businessName) {
    return { saved: false, message: 'Business name is required.' };
  }

  const websiteStatus = (candidate.websiteStatus ??
    existing?.websiteStatus ??
    'unverified') as LeadRecord['websiteStatus'];
  const verificationStatus: LeadRecord['verificationStatus'] =
    candidate.verificationStatus ??
    existing?.verificationStatus ??
    (websiteStatus === 'unverified' ? 'unverified' : 'verified');

  const merged: Omit<LeadRecord, 'id' | 'leadScore'> = {
    userId: user.id,
    businessName: businessName.slice(0, 200),
    category: String(candidate.category ?? existing?.category ?? 'Premium salons').slice(0, 100),
    city: String(candidate.city ?? existing?.city ?? '').slice(0, 100),
    state: String(candidate.state ?? existing?.state ?? '').slice(0, 100),
    country: String(candidate.country ?? existing?.country ?? 'India').slice(0, 100),
    address: String(candidate.address ?? existing?.address ?? '').slice(0, 400),
    phone: String(candidate.phone ?? existing?.phone ?? '').slice(0, 60),
    websiteUrl: String(candidate.websiteUrl ?? existing?.websiteUrl ?? '').slice(0, 500),
    websiteStatus,
    hasOnlineBooking: Boolean(candidate.hasOnlineBooking ?? existing?.hasOnlineBooking ?? false),
    isPremiumService: Boolean(candidate.isPremiumService ?? existing?.isPremiumService ?? false),
    hasActivePublicProfile:
      candidate.hasActivePublicProfile ?? existing?.hasActivePublicProfile ?? true,
    instagramUrl: String(candidate.instagramUrl ?? existing?.instagramUrl ?? '').slice(0, 500),
    facebookUrl: String(candidate.facebookUrl ?? existing?.facebookUrl ?? '').slice(0, 500),
    googlePlaceId: String(candidate.googlePlaceId ?? existing?.googlePlaceId ?? '').slice(0, 200),
    googleMapsUrl: String(candidate.googleMapsUrl ?? existing?.googleMapsUrl ?? '').slice(0, 600),
    rating: Math.min(5, Math.max(0, Number(candidate.rating ?? existing?.rating ?? 0) || 0)),
    reviewCount: Math.max(
      0,
      Math.floor(Number(candidate.reviewCount ?? existing?.reviewCount ?? 0) || 0)
    ),
    source: (candidate.source ?? existing?.source ?? 'google_places') as LeadRecord['source'],
    verificationStatus,
    lastVerifiedAt: String(candidate.lastVerifiedAt ?? existing?.lastVerifiedAt ?? nowIso),
    status: (candidate.status ?? existing?.status ?? 'new') as LeadRecord['status'],
    notes: String(candidate.notes ?? existing?.notes ?? '').slice(0, 4000),
    tags: String(candidate.tags ?? existing?.tags ?? '').slice(0, 500),
    lastContactedAt: String(candidate.lastContactedAt ?? existing?.lastContactedAt ?? ''),
    nextFollowUpAt: String(candidate.nextFollowUpAt ?? existing?.nextFollowUpAt ?? ''),
    aiResearchJson: String(candidate.aiResearchJson ?? existing?.aiResearchJson ?? ''),
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    lat: candidate.lat ?? existing?.lat,
    lng: candidate.lng ?? existing?.lng,
  };

  const { totalScore } = calculateLeadScore(merged);
  const fullRecord: LeadRecord = {
    id: existingId || crypto.randomUUID(),
    ...merged,
    leadScore: totalScore,
  };

  if (supabase) {
    const dbRow = {
      id: fullRecord.id,
      user_id: fullRecord.userId,
      business_name: fullRecord.businessName,
      category: fullRecord.category,
      city: fullRecord.city,
      state: fullRecord.state,
      country: fullRecord.country,
      address: fullRecord.address,
      phone: fullRecord.phone,
      website_url: fullRecord.websiteUrl,
      website_status: fullRecord.websiteStatus,
      has_online_booking: fullRecord.hasOnlineBooking,
      is_premium_service: fullRecord.isPremiumService,
      has_active_public_profile: fullRecord.hasActivePublicProfile,
      instagram_url: fullRecord.instagramUrl,
      facebook_url: fullRecord.facebookUrl,
      google_place_id: fullRecord.googlePlaceId,
      google_maps_url: fullRecord.googleMapsUrl,
      rating: fullRecord.rating,
      review_count: fullRecord.reviewCount,
      lead_score: fullRecord.leadScore,
      source: fullRecord.source,
      verification_status: fullRecord.verificationStatus,
      last_verified_at: fullRecord.lastVerifiedAt || null,
      status: fullRecord.status,
      notes: fullRecord.notes,
      tags: fullRecord.tags,
      lat: typeof fullRecord.lat === 'number' ? fullRecord.lat : null,
      lng: typeof fullRecord.lng === 'number' ? fullRecord.lng : null,
      created_at: fullRecord.createdAt,
      updated_at: fullRecord.updatedAt,
    };

    const { error } = await supabase.from('leads').upsert(dbRow);
    if (error) {
      return {
        saved: false,
        message: `Supabase RLS database error: ${error.message}`,
      };
    }
  }

  return {
    saved: true,
    lead: fullRecord,
    message: `Saved "${fullRecord.businessName}" (Score: ${fullRecord.leadScore}/100).`,
  };
}

export async function fetchWorkspaceData(): Promise<{
  profile: UserProfile;
  leads: LeadRecord[];
  messages: MessageRecord[];
  activities: ActivityRecord[];
  followups: FollowupRecord[];
}> {
  const res = await authenticatedFetch('/api/crm/workspace');
  const parsed = await safeParseHttpResponse<Record<string, any>>(res, 'CRM Workspace');
  if (parsed.ok && parsed.data) {
    return parsed.data as {
      profile: UserProfile;
      leads: LeadRecord[];
      messages: MessageRecord[];
      activities: ActivityRecord[];
      followups: FollowupRecord[];
    };
  }

  if (parsed.isNotFoundPage) {
    const session = getStoredSession();
    const uid = session?.id || '00000000-0000-4000-8000-000000000001';
    return {
      profile: { ...INITIAL_DEMO_PROFILE, userId: uid },
      leads: getLocalFallbackLeads(uid),
      messages: INITIAL_DEMO_MESSAGES.map((m) => ({ ...m, userId: uid })),
      activities: INITIAL_DEMO_ACTIVITIES.map((a) => ({ ...a, userId: uid })),
      followups: INITIAL_DEMO_FOLLOWUPS.map((f) => ({ ...f, userId: uid })),
    };
  }

  throw new Error(parsed.errorMessage || 'Failed to load CRM workspace data.');
}
