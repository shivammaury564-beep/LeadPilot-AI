import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  ActivityRecord,
  FollowupRecord,
  LeadRecord,
  MessageRecord,
  UserProfile,
} from '../types/leadpilot';

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

  // 2. Verify existing stored token with backend
  const existing = getStoredSession();
  if (existing) {
    const verifyRes = await authenticatedFetch('/api/auth/me');
    if (verifyRes.ok) {
      const data = await verifyRes.json();
      if (data?.user && data?.profile) {
        const refreshed: SessionUser = {
          ...existing,
          ...data.user,
          accessToken: existing.accessToken,
        };
        setStoredSession(refreshed);
        return { user: refreshed, profile: data.profile };
      }
    }
  }

  // 3. Provision default authenticated founder workspace session so the app boots authenticated
  const bootstrapRes = await fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (bootstrapRes.ok) {
    const data = await bootstrapRes.json();
    if (data?.user && data?.profile) {
      setStoredSession(data.user);
      return { user: data.user, profile: data.profile };
    }
  }

  return null;
}

export async function loginWithEmailPassword(
  email: string,
  password: string
): Promise<{ user: SessionUser; profile: UserProfile }> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || 'Sign in failed.');
  }
  setStoredSession(data.user);
  return { user: data.user, profile: data.profile };
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
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || 'Account registration failed.');
  }
  setStoredSession(data.user);
  return { user: data.user, profile: data.profile };
}

export async function signOutSession(): Promise<void> {
  if (supabase) {
    await supabase.auth.signOut().catch(() => null);
  }
  setStoredSession(null);
}

export async function fetchWorkspaceData(): Promise<{
  profile: UserProfile;
  leads: LeadRecord[];
  messages: MessageRecord[];
  activities: ActivityRecord[];
  followups: FollowupRecord[];
}> {
  const res = await authenticatedFetch('/api/crm/workspace');
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || 'Failed to load CRM workspace data.');
  }
  return data;
}
