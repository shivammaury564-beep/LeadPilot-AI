import React, { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Copy,
  Database,
  Download,
  FileSpreadsheet,
  Puzzle,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import {
  BUSINESS_CATEGORIES,
  LEAD_STATUS_LABELS,
  LeadRecord,
  LeadStatus,
  UserProfile,
} from '../types/leadpilot';
import { generateCsvContent } from '../utils/scoringAndCrm';
import { authenticatedFetch } from '../lib/supabase';

interface ExportAndSettingsViewProps {
  activeSection: 'export' | 'settings';
  leads: LeadRecord[];
  profile: UserProfile;
  onUpdateProfile: (updated: Partial<UserProfile>) => Promise<void>;
  onSaveExtensionLead: (
    lead: Partial<LeadRecord>,
    existingId?: string
  ) => Promise<{ saved: boolean; message: string }>;
}

export const ExportAndSettingsView: React.FC<ExportAndSettingsViewProps> = ({
  activeSection,
  leads,
  profile,
  onUpdateProfile,
  onSaveExtensionLead,
}) => {
  // Export Filters
  const [exportScope, setExportScope] = useState<
    'all' | 'high_priority' | 'by_city' | 'by_category' | 'by_status'
  >('all');
  const [exportCity, setExportCity] = useState<string>('Mumbai');
  const [exportCategory, setExportCategory] = useState<string>('Premium salons');
  const [exportStatus, setExportStatus] = useState<LeadStatus>('qualified');
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);

  // Settings & Integration Status
  const [fullName, setFullName] = useState(profile.fullName);
  const [agencyName, setAgencyName] = useState(profile.agencyName);
  const [dailyTarget, setDailyTarget] = useState(profile.dailyTarget);
  const [defaultCity, setDefaultCity] = useState(profile.defaultCity);
  const [defaultCategory, setDefaultCategory] = useState(profile.defaultCategory);
  const [profileSaved, setProfileSaved] = useState(false);

  const [integrationStatus, setIntegrationStatus] = useState<Record<string, any> | null>(null);
  const [extensionManifest, setExtensionManifest] = useState<Record<string, any> | null>(null);
  const [extSimName, setExtSimName] = useState('Aura Skin & Laser Clinic');
  const [extSimCity, setExtSimCity] = useState('Mumbai');
  const [extSimFeedback, setExtSimFeedback] = useState<string | null>(null);
  const [copiedSql, setCopiedSql] = useState(false);

  useEffect(() => {
    setFullName(profile.fullName);
    setAgencyName(profile.agencyName);
    setDailyTarget(profile.dailyTarget);
    setDefaultCity(profile.defaultCity);
    setDefaultCategory(profile.defaultCategory);
  }, [profile]);

  useEffect(() => {
    authenticatedFetch('/api/integrations/status')
      .then((r) => r.json())
      .then((d) => setIntegrationStatus(d))
      .catch(() => null);

    authenticatedFetch('/api/extension/manifest')
      .then((r) => r.json())
      .then((d) => setExtensionManifest(d))
      .catch(() => null);
  }, []);

  const permittedLeads = leads.filter((l) => l.status !== 'opted_out');

  const getScopedLeads = (): LeadRecord[] => {
    if (exportScope === 'high_priority') {
      return permittedLeads.filter((l) => l.leadScore >= 80);
    }
    if (exportScope === 'by_city') {
      return permittedLeads.filter(
        (l) => l.city.toLowerCase() === exportCity.trim().toLowerCase()
      );
    }
    if (exportScope === 'by_category') {
      return permittedLeads.filter((l) => l.category === exportCategory);
    }
    if (exportScope === 'by_status') {
      return permittedLeads.filter((l) => l.status === exportStatus);
    }
    return permittedLeads;
  };

  const scopedLeads = getScopedLeads();

  const handleDownloadCsv = () => {
    const csvContent = generateCsvContent(scopedLeads);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `leadpilot-export-${exportScope}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setExportSuccess(
      `Exported ${scopedLeads.length} permitted leads to UTF-8 CSV (opted-out records & secrets excluded).`
    );
  };

  const handleSaveProfileSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await onUpdateProfile({
      fullName: fullName.trim() || 'Agency Founder',
      agencyName: agencyName.trim() || 'Northstar Web Studio',
      dailyTarget: Number(dailyTarget) || 60,
      defaultCity: defaultCity.trim() || 'Mumbai',
      defaultCategory,
    });
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  };

  const handleSimulateExtensionCapture = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!extSimName.trim()) return;
    const res = await authenticatedFetch('/api/extension/capture', {
      method: 'POST',
      body: JSON.stringify({
        businessName: extSimName.trim(),
        category: 'Beauty studios',
        city: extSimCity.trim(),
        websiteStatus: 'missing_verified',
        notes: 'Captured via Chrome Extension Manifest V3 Side Panel API',
      }),
    });
    const data = await res.json();
    if (res.ok && data?.lead) {
      await onSaveExtensionLead(data.lead, data.lead.id);
      setExtSimFeedback(
        `${data.message || 'Captured lead'} (Scored ${data.lead.leadScore}/100 via /api/extension/capture)`
      );
    } else if (data?.error) {
      setExtSimFeedback(data.error);
    }
  };

  const sampleMigrationSqlSnippet = `-- LeadPilot AI PostgreSQL / Supabase Migration (Excerpt — full SQL in /supabase_migrations.sql)
CREATE TABLE IF NOT EXISTS public.leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  category TEXT NOT NULL,
  city TEXT DEFAULT '',
  website_url TEXT DEFAULT '',
  website_status TEXT NOT NULL DEFAULT 'unverified',
  lead_score INTEGER NOT NULL DEFAULT 0 CHECK (lead_score BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own leads" ON public.leads
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`;

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(sampleMigrationSqlSnippet);
      setCopiedSql(true);
      setTimeout(() => setCopiedSql(false), 2000);
    } catch {
      // ignore
    }
  };

  if (activeSection === 'export') {
    return (
      <div className="space-y-6">
        {/* CSV Export Workspace */}
        <section className="rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">
                RFC-4180 UTF-8 CSV Export Center
              </h2>
              <p className="text-xs text-slate-400">
                Export permitted CRM leads by priority, city, category, or outreach status. Opted-out leads and API secrets are never exported.
              </p>
            </div>
            <FileSpreadsheet className="h-5 w-5 text-emerald-400" />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label htmlFor="export-scope" className="block text-xs font-medium text-slate-300 mb-1">
                Export Scope
              </label>
              <select
                id="export-scope"
                value={exportScope}
                onChange={(e) => setExportScope(e.target.value as any)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white"
              >
                <option value="all">All Permitted Leads ({permittedLeads.length})</option>
                <option value="high_priority">High-Priority Leads (Score 80–100)</option>
                <option value="by_city">Filter by City</option>
                <option value="by_category">Filter by Business Category</option>
                <option value="by_status">Filter by Outreach Status</option>
              </select>
            </div>

            {exportScope === 'by_city' && (
              <div>
                <label htmlFor="export-city" className="block text-xs font-medium text-slate-300 mb-1">
                  Target City
                </label>
                <input
                  id="export-city"
                  type="text"
                  value={exportCity}
                  onChange={(e) => setExportCity(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white"
                />
              </div>
            )}

            {exportScope === 'by_category' && (
              <div>
                <label htmlFor="export-cat" className="block text-xs font-medium text-slate-300 mb-1">
                  Target Category
                </label>
                <select
                  id="export-cat"
                  value={exportCategory}
                  onChange={(e) => setExportCategory(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white"
                >
                  {BUSINESS_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {exportScope === 'by_status' && (
              <div>
                <label htmlFor="export-status" className="block text-xs font-medium text-slate-300 mb-1">
                  Outreach Status
                </label>
                <select
                  id="export-status"
                  value={exportStatus}
                  onChange={(e) => setExportStatus(e.target.value as LeadStatus)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white"
                >
                  {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[])
                    .filter((s) => s !== 'opted_out')
                    .map((st) => (
                      <option key={st} value={st}>
                        {LEAD_STATUS_LABELS[st]}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div className="flex items-end">
              <button
                type="button"
                onClick={handleDownloadCsv}
                disabled={scopedLeads.length === 0}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                Download CSV ({scopedLeads.length} rows)
              </button>
            </div>
          </div>

          {exportSuccess && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-200">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{exportSuccess}</span>
            </div>
          )}

          {/* Live CSV Preview */}
          <div className="space-y-1.5 pt-2">
            <div className="text-xs font-medium text-slate-300">
              UTF-8 CSV Output Preview (First 4 Rows)
            </div>
            <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3.5 font-mono text-[11px] text-slate-300">
              {generateCsvContent(scopedLeads.slice(0, 3))}
            </pre>
          </div>
        </section>

        {/* Chrome Extension Manifest V3 Future Architecture Hub */}
        <section className="rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-white">
                Chrome Extension (Manifest V3) Companion Architecture
              </h3>
              <p className="text-xs text-slate-400">
                Pre-wired backend API endpoints allowing a Manifest V3 Side Panel extension to authenticate, score prospects, and sync to CRM without scraping
              </p>
            </div>
            <Puzzle className="h-5 w-5 text-violet-400" />
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <span className="text-xs font-medium text-slate-300">
                Manifest V3 Configuration (<code className="font-mono">GET /api/extension/manifest</code>)
              </span>
              <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3.5 font-mono text-[11px] text-slate-300 max-h-60">
                {JSON.stringify(
                  extensionManifest?.manifestJson || {
                    manifest_version: 3,
                    name: 'LeadPilot AI — Agency Companion',
                    permissions: ['sidePanel', 'storage', 'activeTab'],
                  },
                  null,
                  2
                )}
              </pre>
            </div>

            <form
              onSubmit={handleSimulateExtensionCapture}
              className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 space-y-3 text-xs"
            >
              <div className="font-semibold text-white">
                Test Authenticated Extension Endpoint (<code className="font-mono">POST /api/extension/capture</code>)
              </div>
              <p className="text-slate-400">
                Simulate saving an eligible public business from the Chrome Extension Side Panel directly into your CRM pipeline:
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="ext-bname" className="block text-slate-300 mb-1">
                    Business Name
                  </label>
                  <input
                    id="ext-bname"
                    type="text"
                    value={extSimName}
                    onChange={(e) => setExtSimName(e.target.value)}
                    className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label htmlFor="ext-city" className="block text-slate-300 mb-1">
                    City
                  </label>
                  <input
                    id="ext-city"
                    type="text"
                    value={extSimCity}
                    onChange={(e) => setExtSimCity(e.target.value)}
                    className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-white"
                  />
                </div>
              </div>
              <button
                type="submit"
                className="rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold text-white hover:bg-violet-500"
              >
                Send to CRM via Extension API
              </button>
              {extSimFeedback && (
                <p className="text-emerald-300 font-medium pt-1">{extSimFeedback}</p>
              )}
            </form>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Profile & Daily Workflow Target Configuration */}
        <section className="lg:col-span-5 rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-blue-400" />
            <h2 className="text-base font-semibold text-white">
              Agency Profile & Daily Research Workflow
            </h2>
          </div>

          <form onSubmit={handleSaveProfileSettings} className="space-y-3.5 text-xs">
            <div>
              <label htmlFor="set-fullname" className="block font-medium text-slate-300 mb-1">
                Your Full Name
              </label>
              <input
                id="set-fullname"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
              />
            </div>

            <div>
              <label htmlFor="set-agency" className="block font-medium text-slate-300 mb-1">
                Web Development Agency / Studio Brand Name
              </label>
              <input
                id="set-agency"
                type="text"
                value={agencyName}
                onChange={(e) => setAgencyName(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="set-target" className="block font-medium text-slate-300 mb-1">
                  Daily Lead Target (50–100)
                </label>
                <input
                  id="set-target"
                  type="number"
                  min={10}
                  max={200}
                  value={dailyTarget}
                  onChange={(e) => setDailyTarget(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-white"
                />
              </div>

              <div>
                <label htmlFor="set-city" className="block font-medium text-slate-300 mb-1">
                  Default Target City
                </label>
                <input
                  id="set-city"
                  type="text"
                  value={defaultCity}
                  onChange={(e) => setDefaultCity(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                />
              </div>
            </div>

            <div>
              <label htmlFor="set-category" className="block font-medium text-slate-300 mb-1">
                Default Business Category
              </label>
              <select
                id="set-category"
                value={defaultCategory}
                onChange={(e) => setDefaultCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
              >
                {BUSINESS_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="submit"
              className="w-full rounded-lg bg-blue-600 py-2 text-xs font-semibold text-white hover:bg-blue-500"
            >
              Save Agency & Workflow Settings
            </button>

            {profileSaved && (
              <p className="text-emerald-400 font-medium text-center">
                Settings saved and synced!
              </p>
            )}
          </form>
        </section>

        {/* Right Column: Live API Integration Status & Database Schema */}
        <section className="lg:col-span-7 space-y-5">
          <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Server-Side API Integration & Security Status
                </h3>
                <p className="text-xs text-slate-400">
                  All API keys are managed strictly on the server via environment secrets
                </p>
              </div>
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">Google Places API (New)</span>
                  <span className="font-mono text-[11px] text-emerald-400">
                    {integrationStatus?.googlePlaces?.configured ? 'Connected' : 'Demo Ready'}
                  </span>
                </div>
                <p className="text-slate-400 text-[11px]">
                  Server-side proxy for Text Search, Nearby Search, and Place Details with field masking.
                </p>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">Gemini AI SDK (@google/genai)</span>
                  <span className="font-mono text-[11px] text-emerald-400">
                    {integrationStatus?.geminiAi?.configured ? 'Connected' : 'Fallback Ready'}
                  </span>
                </div>
                <p className="text-slate-400 text-[11px]">
                  Model: <code className="font-mono">gemini-3.8-flash</code> with structured JSON schema validation.
                </p>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">Database & Row-Level Isolation</span>
                  <span className="font-mono text-[11px] text-emerald-400">Active</span>
                </div>
                <p className="text-slate-400 text-[11px]">
                  Per-user tenant isolation (<code className="font-mono">userId == request.auth.uid</code>) + SQL migration in <code className="font-mono">/supabase_migrations.sql</code>.
                </p>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">Meta Graph API (IG / FB)</span>
                  <span className="font-mono text-[11px] text-blue-400">
                    {integrationStatus?.metaGraph?.configured ? 'Graph Connected' : 'Manual Mode'}
                  </span>
                </div>
                <p className="text-slate-400 text-[11px]">
                  Compliant manual public business research workflow active; zero automated scraping.
                </p>
              </div>
            </div>

            {integrationStatus?.usage && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-2.5 text-xs text-slate-300">
                <span>
                  Today's API Requests — Places API:{' '}
                  <strong className="font-mono text-white tabular-nums">
                    {integrationStatus.usage.placesRequestsToday}
                  </strong>{' '}
                  · Gemini AI:{' '}
                  <strong className="font-mono text-white tabular-nums">
                    {integrationStatus.usage.geminiRequestsToday}
                  </strong>
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  Rate Limiter: 90 req/min active
                </span>
              </div>
            )}
          </div>

          {/* Database Migration SQL Reference */}
          <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-violet-400" />
                <h3 className="text-sm font-semibold text-white">
                  PostgreSQL / Supabase Migration SQL (<code className="font-mono">/supabase_migrations.sql</code>)
                </h3>
              </div>
              <button
                type="button"
                onClick={handleCopySql}
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
              >
                {copiedSql ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedSql ? 'Copied' : 'Copy SQL'}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-3.5 font-mono text-[11px] text-slate-300 max-h-48">
              {sampleMigrationSqlSnippet}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
};
