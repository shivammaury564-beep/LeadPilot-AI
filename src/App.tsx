import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Compass,
  Database,
  FileSpreadsheet,
  Globe,
  LogIn,
  LogOut,
  Menu,
  MessageSquare,
  RefreshCw,
  Settings,
  Share2,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  authenticatedFetch,
  fetchWorkspaceData,
  initializeAuthSession,
  loginWithEmailPassword,
  registerWithEmailPassword,
  SessionUser,
  signOutSession,
} from './lib/supabase';
import {
  ActivityRecord,
  FollowupRecord,
  LeadRecord,
  MessageRecord,
  UserProfile,
} from './types/leadpilot';
import {
  canTransitionLeadStatus,
  detectDuplicateLead,
} from './utils/scoringAndCrm';
import { DashboardView } from './components/DashboardView';
import { LeadFinderView } from './components/LeadFinderView';
import { SocialResearchView } from './components/SocialResearchView';
import { AiDmGeneratorView } from './components/AiDmGeneratorView';
import { CrmTableView } from './components/CrmTableView';
import { ExportAndSettingsView } from './components/ExportAndSettingsView';

const FOUNDER_AVATAR_URL = '/src/assets/images/avatar_agency_founder_1794191537481.jpg';

const DEFAULT_EMPTY_PROFILE: UserProfile = {
  userId: '',
  fullName: 'Agency Founder',
  agencyName: 'Northstar Web Studio',
  dailyTarget: 100,
  defaultCity: 'Mumbai',
  defaultCategory: 'Premium salons',
  researchPriority: 'missing_website',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

type NavTab =
  | 'dashboard'
  | 'finder'
  | 'instagram'
  | 'facebook'
  | 'ai_research'
  | 'dm_generator'
  | 'crm'
  | 'export'
  | 'settings';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [avatarError, setAvatarError] = useState<boolean>(false);

  // Google Maps Platform Quota Exceeded state (Section 8 Case A)
  const [gmpQuotaExceeded, setGmpQuotaExceeded] = useState<boolean>(false);
  const [mapsBrowserKey] = useState<string>(
    (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string) || ''
  );
  const [placesConfigured, setPlacesConfigured] = useState<boolean>(false);
  const [metaGraphConfigured, setMetaGraphConfigured] = useState<boolean>(false);
  const [supabaseEngineLabel, setSupabaseEngineLabel] = useState<string>(
    'Supabase PostgreSQL RLS Engine'
  );

  // Auth & Workspace State (Supabase Auth + JWT Bearer Session)
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState<boolean>(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  // Auth Modal State
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState<string>('aarav@northstarweb.studio');
  const [authPassword, setAuthPassword] = useState<string>('LeadPilotDemo!2026');
  const [authFullName, setAuthFullName] = useState<string>('Aarav Mehta');
  const [authAgencyName, setAuthAgencyName] = useState<string>('Northstar Web Studio');
  const [authSubmitting, setAuthSubmitting] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Database Records (Loaded strictly from authenticated backend / Supabase PostgreSQL)
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_EMPTY_PROFILE);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [followups, setFollowups] = useState<FollowupRecord[]>([]);
  const [selectedLead, setSelectedLead] = useState<LeadRecord | null>(null);

  // Listen to global Google Maps quota exceeded event
  useEffect(() => {
    const onQuotaExceeded = () => setGmpQuotaExceeded(true);
    window.addEventListener('gmp-quota-exceeded', onQuotaExceeded);
    return () => window.removeEventListener('gmp-quota-exceeded', onQuotaExceeded);
  }, []);

  // Load server integration config (without exposing any raw API keys)
  useEffect(() => {
    fetch('/api/integrations/status')
      .then((r) => r.json())
      .then((data) => {
        setPlacesConfigured(Boolean(data?.googlePlaces?.configured));
        setMetaGraphConfigured(Boolean(data?.metaGraph?.configured));
        if (data?.database?.engine) {
          setSupabaseEngineLabel(data.database.engine);
        }
      })
      .catch(() => null);
  }, []);

  const loadWorkspaceRecords = useCallback(async () => {
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    try {
      const data = await fetchWorkspaceData();
      if (data.profile) setProfile(data.profile);
      const loadedLeads: LeadRecord[] = Array.isArray(data.leads) ? data.leads : [];
      setLeads(loadedLeads);
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setActivities(Array.isArray(data.activities) ? data.activities : []);
      setFollowups(Array.isArray(data.followups) ? data.followups : []);
      setSelectedLead((prev) => {
        if (prev) {
          const updated = loadedLeads.find((l) => l.id === prev.id);
          if (updated) return updated;
        }
        return loadedLeads[0] || null;
      });
    } catch (err: any) {
      setWorkspaceError(err.message || 'Unable to load workspace records from database.');
    } finally {
      setWorkspaceLoading(false);
    }
  }, []);

  // Initialize Supabase / JWT session and load real database records
  useEffect(() => {
    let mounted = true;
    initializeAuthSession()
      .then(async (session) => {
        if (!mounted) return;
        setCurrentUser(session?.user || null);
        await loadWorkspaceRecords();
      })
      .catch((err) => {
        if (!mounted) return;
        setWorkspaceError(err.message || 'Authentication session initialization failed.');
        setWorkspaceLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [loadWorkspaceRecords]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthSubmitting(true);
    try {
      const session =
        authMode === 'login'
          ? await loginWithEmailPassword(authEmail, authPassword)
          : await registerWithEmailPassword(
              authEmail,
              authPassword,
              authFullName,
              authAgencyName
            );
      setCurrentUser(session.user);
      setAuthModalOpen(false);
      await loadWorkspaceRecords();
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed.');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await signOutSession();
    setCurrentUser(null);
    setLeads([]);
    setMessages([]);
    setActivities([]);
    setFollowups([]);
    setSelectedLead(null);
    setAuthModalOpen(true);
  };

  const handleSaveOrUpdateLead = async (
    candidate: Partial<LeadRecord>,
    existingId?: string
  ): Promise<{ saved: boolean; lead?: LeadRecord; message: string }> => {
    const existing = existingId ? leads.find((l) => l.id === existingId) : undefined;

    if (existing && candidate.status) {
      const guard = canTransitionLeadStatus(existing.status, candidate.status);
      if (!guard.allowed) {
        return { saved: false, message: guard.error! };
      }
    }

    const dup = detectDuplicateLead(candidate, leads, existingId);
    if (!existingId && dup.isDuplicate) {
      return {
        saved: false,
        lead: dup.matchedLead,
        message: dup.reason || 'Duplicate lead detected in CRM.',
      };
    }

    try {
      const endpoint = existingId
        ? `/api/crm/leads/${encodeURIComponent(existingId)}`
        : '/api/crm/leads';
      const method = existingId ? 'PUT' : 'POST';

      const res = await authenticatedFetch(endpoint, {
        method,
        body: JSON.stringify(candidate),
      });
      const data = await res.json();

      if (!res.ok) {
        return {
          saved: false,
          lead: data?.matchedLead,
          message: data?.error || 'Failed to save lead to database.',
        };
      }

      const savedLead: LeadRecord = data.lead;
      setLeads((prev) =>
        existingId
          ? prev.map((l) => (l.id === existingId ? savedLead : l))
          : [savedLead, ...prev]
      );
      setSelectedLead(savedLead);

      return {
        saved: true,
        lead: savedLead,
        message:
          data.message ||
          `Saved "${savedLead.businessName}" (Score: ${savedLead.leadScore}/100).`,
      };
    } catch (err: any) {
      return {
        saved: false,
        message: err.message || 'Network error while saving lead.',
      };
    }
  };

  const handleDeleteLead = async (id: string) => {
    try {
      const res = await authenticatedFetch(`/api/crm/leads/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setLeads((prev) => prev.filter((l) => l.id !== id));
        setMessages((prev) => prev.filter((m) => m.leadId !== id));
        setFollowups((prev) => prev.filter((f) => f.leadId !== id));
        if (selectedLead?.id === id) {
          setSelectedLead(null);
        }
      }
    } catch (err: any) {
      setWorkspaceError(err.message || 'Failed to delete lead.');
    }
  };

  const handleBulkAddTag = async (ids: string[], tag: string) => {
    for (const id of ids) {
      const target = leads.find((l) => l.id === id);
      if (!target) continue;
      const existingTags = target.tags
        ? target.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [];
      if (!existingTags.includes(tag)) {
        existingTags.push(tag);
      }
      await handleSaveOrUpdateLead({ ...target, tags: existingTags.join(', ') }, id);
    }
  };

  const handleSaveMessage = async (
    msgInput: Omit<MessageRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
  ) => {
    const res = await authenticatedFetch('/api/crm/messages', {
      method: 'POST',
      body: JSON.stringify(msgInput),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to save outreach message.');
    }

    if (data.message) {
      setMessages((prev) => [data.message as MessageRecord, ...prev]);
    }
    await loadWorkspaceRecords();
  };

  const handleMarkLeadOptedOut = async (leadId: string) => {
    const target = leads.find((l) => l.id === leadId);
    if (!target) return;
    await handleSaveOrUpdateLead({ ...target, status: 'opted_out' }, leadId);
  };

  const handleScheduleFollowup = async (
    leadId: string,
    leadBusinessName: string,
    scheduledAt: string,
    notes: string
  ) => {
    const res = await authenticatedFetch('/api/crm/followups', {
      method: 'POST',
      body: JSON.stringify({
        leadId,
        leadBusinessName,
        scheduledAt,
        notes,
      }),
    });
    const data = await res.json();
    if (res.ok && data.followup) {
      setFollowups((prev) => [data.followup as FollowupRecord, ...prev]);
      await loadWorkspaceRecords();
    }
  };

  const handleCompleteFollowup = async (followupId: string) => {
    const res = await authenticatedFetch(
      `/api/crm/followups/${encodeURIComponent(followupId)}/complete`,
      { method: 'PATCH' }
    );
    const data = await res.json();
    if (res.ok && data.followup) {
      setFollowups((prev) =>
        prev.map((item) => (item.id === followupId ? (data.followup as FollowupRecord) : item))
      );
    }
  };

  const handleUpdateProfile = async (updated: Partial<UserProfile>) => {
    const res = await authenticatedFetch('/api/crm/profile', {
      method: 'PUT',
      body: JSON.stringify(updated),
    });
    const data = await res.json();
    if (res.ok && data.profile) {
      setProfile(data.profile as UserProfile);
    }
  };

  const navItems: Array<{ id: NavTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
    { id: 'finder', label: 'Lead Finder', icon: Compass },
    { id: 'instagram', label: 'Instagram Research', icon: Share2 },
    { id: 'facebook', label: 'Facebook Research', icon: Globe },
    { id: 'ai_research', label: 'AI Business Research', icon: Sparkles },
    { id: 'dm_generator', label: 'AI DM Generator', icon: MessageSquare },
    { id: 'crm', label: 'CRM Pipeline', icon: Users },
    { id: 'export', label: 'CSV & Extension', icon: FileSpreadsheet },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-100 flex flex-col">
      {/* Required Google Maps Platform Demo Quota Banner (Section 8 Case A) */}
      {gmpQuotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Top Navigation Header (Strict 3-Zone Contract) */}
      <header className="sticky top-0 z-40 flex items-center justify-between gap-8 border-b border-slate-800/90 bg-[#0B0F19]/95 px-6 py-3.5 backdrop-blur">
        {/* Zone 1: Single text element wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Toggle navigation menu"
            className="lg:hidden rounded-lg p-1.5 text-slate-300 hover:bg-slate-800"
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <a
            href="#dashboard"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('dashboard');
            }}
            className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            LeadPilot AI
          </a>
        </div>

        {/* Zone 2: 5 concise single-line navigation links */}
        <nav aria-label="Primary Workspace Navigation" className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setActiveTab('dashboard')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'dashboard' ? 'text-white underline underline-offset-8 decoration-blue-500' : ''
            }`}
          >
            Dashboard
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('finder')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'finder' ? 'text-white underline underline-offset-8 decoration-blue-500' : ''
            }`}
          >
            Lead Finder
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('ai_research')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'ai_research' ? 'text-white underline underline-offset-8 decoration-blue-500' : ''
            }`}
          >
            AI Research
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('dm_generator')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'dm_generator' ? 'text-white underline underline-offset-8 decoration-blue-500' : ''
            }`}
          >
            DM Generator
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('crm')}
            className={`hover:text-white transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'crm' ? 'text-white underline underline-offset-8 decoration-blue-500' : ''
            }`}
          >
            CRM Pipeline
          </button>
        </nav>

        {/* Zone 3: Primary Action & Profile */}
        <div className="flex items-center gap-3 shrink-0">
          {currentUser ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setAuthModalOpen(true)}
                className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 whitespace-nowrap"
              >
                Switch Account
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign Out
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAuthModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 transition-colors whitespace-nowrap shrink-0"
            >
              <LogIn className="h-3.5 w-3.5" />
              Sign In / Register
            </button>
          )}
        </div>
      </header>

      {/* Supabase Auth Account Modal */}
      {authModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-800 bg-[#111827] p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-white">
                  {authMode === 'login'
                    ? 'Sign In to LeadPilot AI Workspace'
                    : 'Create Isolated Agency Account'}
                </h2>
                <p className="text-xs text-slate-400">
                  Protected by Supabase Auth & Row-Level Security (RLS)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAuthModalOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-900 p-1 border border-slate-800 text-xs">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setAuthError(null);
                }}
                className={`rounded-md py-1.5 font-medium ${
                  authMode === 'login' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('register');
                  setAuthError(null);
                }}
                className={`rounded-md py-1.5 font-medium ${
                  authMode === 'register'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Create Account
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-3 text-xs">
              {authMode === 'register' && (
                <>
                  <div>
                    <label htmlFor="auth-fullname" className="block font-medium text-slate-300 mb-1">
                      Full Name
                    </label>
                    <input
                      id="auth-fullname"
                      type="text"
                      required
                      value={authFullName}
                      onChange={(e) => setAuthFullName(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label htmlFor="auth-agency" className="block font-medium text-slate-300 mb-1">
                      Agency Name
                    </label>
                    <input
                      id="auth-agency"
                      type="text"
                      required
                      value={authAgencyName}
                      onChange={(e) => setAuthAgencyName(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                    />
                  </div>
                </>
              )}

              <div>
                <label htmlFor="auth-email" className="block font-medium text-slate-300 mb-1">
                  Work Email
                </label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                />
              </div>

              <div>
                <label htmlFor="auth-password" className="block font-medium text-slate-300 mb-1">
                  Password (min 8 chars)
                </label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={8}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                />
              </div>

              {authError && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-2.5 text-red-200">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={authSubmitting}
                className="w-full rounded-lg bg-blue-600 py-2.5 font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {authSubmitting
                  ? 'Authenticating...'
                  : authMode === 'login'
                  ? 'Sign In to Workspace'
                  : 'Create Account & Initialize RLS Workspace'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Main Workspace Container */}
      <div className="flex flex-1">
        {/* Collapsible Left Sidebar */}
        <aside
          aria-label="Sidebar Navigation"
          className={`${
            mobileMenuOpen ? 'fixed inset-y-0 left-0 z-40 block w-64 pt-16' : 'hidden'
          } lg:static lg:block ${
            sidebarCollapsed ? 'lg:w-20' : 'lg:w-64'
          } shrink-0 border-r border-slate-800/80 bg-[#0E1422] transition-all flex flex-col justify-between`}
        >
          <div className="p-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-blue-600/15 text-blue-400 border border-blue-500/30'
                      : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`}
                  title={item.label}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                </button>
              );
            })}
          </div>

          {/* Sidebar Footer: User Profile Card & Collapse Button */}
          <div className="border-t border-slate-800/80 p-3 space-y-3">
            {!sidebarCollapsed && (
              <div className="flex items-center gap-3 rounded-lg bg-slate-900/70 p-2.5 border border-slate-800/80">
                {!avatarError ? (
                  <img
                    src={FOUNDER_AVATAR_URL}
                    alt={profile.fullName}
                    referrerPolicy="no-referrer"
                    onError={() => setAvatarError(true)}
                    className="h-9 w-9 rounded-full object-cover shrink-0 border border-slate-700"
                  />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600/30 font-mono text-xs font-bold text-blue-300 shrink-0">
                    {profile.fullName.slice(0, 2).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-white">
                    {currentUser?.fullName || profile.fullName}
                  </p>
                  <p className="truncate text-[11px] text-slate-400">
                    {currentUser ? currentUser.email : 'Unauthenticated'}
                  </p>
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setSidebarCollapsed((c) => !c)}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden lg:flex w-full items-center justify-center gap-2 rounded-lg border border-slate-800 bg-slate-900/50 py-1.5 text-xs text-slate-400 hover:text-white"
            >
              {sidebarCollapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <>
                  <ChevronLeft className="h-4 w-4" />
                  <span>Collapse Sidebar</span>
                </>
              )}
            </button>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 min-w-0 p-5 lg:p-7 max-w-[1440px] mx-auto w-full space-y-5">
          {/* Workspace Context Strip */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <Database className="h-3.5 w-3.5 text-blue-400" />
              <span>
                {currentUser
                  ? `${supabaseEngineLabel} · Authenticated Tenant (${currentUser.email}) · RLS Active`
                  : 'Not signed in — Sign in to access your isolated CRM workspace'}
              </span>
            </div>

            <button
              type="button"
              onClick={loadWorkspaceRecords}
              disabled={workspaceLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/70 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-3 w-3 ${workspaceLoading ? 'animate-spin' : ''}`} />
              Sync Database
            </button>
          </div>

          {workspaceError && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{workspaceError}</span>
              </div>
              <button
                type="button"
                onClick={() => setWorkspaceError(null)}
                className="underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {workspaceLoading ? (
            <div className="space-y-4 py-8">
              <div className="h-24 w-full animate-pulse rounded-xl bg-slate-900/80 border border-slate-800" />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                {[1, 2, 3, 4].map((n) => (
                  <div
                    key={n}
                    className="h-28 animate-pulse rounded-xl bg-slate-900/80 border border-slate-800"
                  />
                ))}
              </div>
              <div className="h-64 w-full animate-pulse rounded-xl bg-slate-900/80 border border-slate-800" />
            </div>
          ) : (
            <>
              {activeTab === 'dashboard' && (
                <DashboardView
                  leads={leads}
                  messages={messages}
                  followups={followups}
                  profile={profile}
                  onNavigate={(t) => setActiveTab(t as NavTab)}
                  onSelectLeadForResearch={(lead) => {
                    setSelectedLead(lead);
                    setActiveTab('ai_research');
                  }}
                  onSelectLeadForDm={(lead) => {
                    setSelectedLead(lead);
                    setActiveTab('dm_generator');
                  }}
                  onUpdateDailyTarget={(target) => handleUpdateProfile({ dailyTarget: target })}
                  onCompleteFollowup={handleCompleteFollowup}
                />
              )}

              {activeTab === 'finder' && (
                <LeadFinderView
                  existingLeads={leads}
                  mapsBrowserKey={mapsBrowserKey}
                  placesConfigured={placesConfigured}
                  onSaveLead={handleSaveOrUpdateLead}
                  onSelectLeadForResearch={(lead) => {
                    setSelectedLead(lead);
                    setActiveTab('ai_research');
                  }}
                />
              )}

              {(activeTab === 'instagram' ||
                activeTab === 'facebook' ||
                activeTab === 'ai_research') && (
                <SocialResearchView
                  mode={activeTab}
                  leads={leads}
                  selectedLead={selectedLead}
                  metaGraphConfigured={metaGraphConfigured}
                  onSaveOrUpdateLead={handleSaveOrUpdateLead}
                  onOpenInDmGenerator={(lead) => {
                    setSelectedLead(lead);
                    setActiveTab('dm_generator');
                  }}
                />
              )}

              {activeTab === 'dm_generator' && (
                <AiDmGeneratorView
                  leads={leads}
                  messages={messages}
                  selectedLead={selectedLead}
                  agencyName={profile.agencyName}
                  onSaveMessage={handleSaveMessage}
                  onMarkLeadOptedOut={handleMarkLeadOptedOut}
                />
              )}

              {activeTab === 'crm' && (
                <CrmTableView
                  leads={leads}
                  activities={activities}
                  followups={followups}
                  onSaveOrUpdateLead={handleSaveOrUpdateLead}
                  onDeleteLead={handleDeleteLead}
                  onBulkAddTag={handleBulkAddTag}
                  onScheduleFollowup={handleScheduleFollowup}
                  onSelectLeadForResearch={(lead) => {
                    setSelectedLead(lead);
                    setActiveTab('ai_research');
                  }}
                  onSelectLeadForDm={(lead) => {
                    setSelectedLead(lead);
                    setActiveTab('dm_generator');
                  }}
                />
              )}

              {(activeTab === 'export' || activeTab === 'settings') && (
                <ExportAndSettingsView
                  activeSection={activeTab}
                  leads={leads}
                  profile={profile}
                  onUpdateProfile={handleUpdateProfile}
                  onSaveExtensionLead={handleSaveOrUpdateLead}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
