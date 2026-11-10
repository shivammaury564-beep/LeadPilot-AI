import React from 'react';
import {
  ArrowUpRight,
  Compass,
  MessageSquare,
  Plus,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import {
  FollowupRecord,
  LEAD_STATUS_LABELS,
  LeadRecord,
  MessageRecord,
  UserProfile,
} from '../types/leadpilot';
import { computeDashboardMetrics } from '../utils/scoringAndCrm';

interface DashboardViewProps {
  leads: LeadRecord[];
  messages: MessageRecord[];
  followups: FollowupRecord[];
  profile: UserProfile;
  onNavigate: (tab: string) => void;
  onSelectLeadForResearch: (lead: LeadRecord) => void;
  onSelectLeadForDm: (lead: LeadRecord) => void;
  onUpdateDailyTarget: (target: number) => void;
  onCompleteFollowup: (followupId: string) => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  leads,
  messages,
  followups,
  profile,
  onNavigate,
  onSelectLeadForResearch,
  onSelectLeadForDm,
  onUpdateDailyTarget,
  onCompleteFollowup,
}) => {
  const metrics = computeDashboardMetrics(leads, messages);
  const dailyTarget = profile.dailyTarget || 60;
  const dailyProgressPct = Math.min(100, Math.round((metrics.totalDiscovered / dailyTarget) * 100));

  const maxDayCount = Math.max(1, ...metrics.byDay.map((d) => d.count));
  const maxSourceCount = Math.max(1, ...metrics.bySource.map((s) => s.count));
  const maxStatusCount = Math.max(1, ...metrics.byOutreachStatus.map((s) => s.count));

  const kpiCards = [
    {
      label: 'Total Discovered Leads',
      value: metrics.totalDiscovered,
      subtext: `Target: ${dailyTarget}/day`,
      accent: 'text-white',
    },
    {
      label: 'Qualified Leads',
      value: metrics.qualifiedLeads,
      subtext: `${metrics.highPriorityCount} high-priority (80+ score)`,
      accent: 'text-blue-400',
    },
    {
      label: 'Leads Without Websites',
      value: metrics.leadsWithoutWebsites,
      subtext: 'Verified missing website (+30 pts)',
      accent: 'text-emerald-400',
    },
    {
      label: 'Outdated Websites',
      value: metrics.leadsWithOutdatedWebsites,
      subtext: 'Verified upgrade opportunity (+20 pts)',
      accent: 'text-amber-400',
    },
    {
      label: 'Messages Drafted',
      value: metrics.messagesDrafted,
      subtext: 'AI personalized variations',
      accent: 'text-violet-400',
    },
    {
      label: 'Messages Sent',
      value: metrics.messagesSent,
      subtext: 'Manually approved & sent',
      accent: 'text-sky-400',
    },
    {
      label: 'Interested Prospects',
      value: metrics.interestedProspects,
      subtext: 'Positive replies & inquiries',
      accent: 'text-indigo-400',
    },
    {
      label: 'Demos Shared',
      value: metrics.demosShared,
      subtext: 'Custom website previews sent',
      accent: 'text-cyan-400',
    },
    {
      label: 'Clients Converted',
      value: metrics.clientsConverted,
      subtext: 'Signed web development retainers',
      accent: 'text-emerald-400',
    },
  ];

  const topLeads = [...leads]
    .filter((l) => l.status !== 'opted_out')
    .sort((a, b) => b.leadScore - a.leadScore)
    .slice(0, 5);

  const pendingFollowups = followups.filter((f) => f.status === 'pending');

  return (
    <div className="space-y-6">
      {/* Daily Research Target & Quick Workflow Header */}
      <section className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>Daily Agency Workflow</span>
              <span aria-hidden="true">·</span>
              <span>Focus City: {profile.defaultCity || 'Mumbai'}</span>
              <span aria-hidden="true">·</span>
              <span>Focus Vertical: {profile.defaultCategory || 'Premium salons'}</span>
            </div>
            <h2 className="text-lg font-semibold text-white">
              Daily Research Quota & Pipeline Velocity
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <label htmlFor="daily-target-select" className="text-slate-400">
                Daily Target:
              </label>
              <select
                id="daily-target-select"
                value={dailyTarget}
                onChange={(e) => onUpdateDailyTarget(Number(e.target.value))}
                className="rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
              >
                <option value={50}>50 leads / day</option>
                <option value={60}>60 leads / day</option>
                <option value={75}>75 leads / day</option>
                <option value={100}>100 leads / day</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => onNavigate('finder')}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 whitespace-nowrap shrink-0"
            >
              <Compass className="h-3.5 w-3.5" />
              Discover Local Businesses
            </button>

            <button
              type="button"
              onClick={() => onNavigate('crm')}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/70 px-4 py-2 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Manage CRM Pipeline
            </button>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-slate-400 mb-1.5">
            <span>
              Pipeline Progress:{' '}
              <strong className="font-mono text-white tabular-nums">
                {metrics.totalDiscovered}
              </strong>{' '}
              of{' '}
              <strong className="font-mono text-white tabular-nums">{dailyTarget}</strong> target leads
            </span>
            <span className="font-mono text-blue-400 tabular-nums">{dailyProgressPct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-600 to-violet-500 transition-all duration-300"
              style={{ width: `${dailyProgressPct}%` }}
            />
          </div>
        </div>
      </section>

      {/* 9 Live Database KPI Cards */}
      <section aria-label="Pipeline Key Performance Indicators" className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
        {kpiCards.map((kpi) => (
          <div
            key={kpi.label}
            className="rounded-xl border border-slate-800/80 bg-[#111827] p-4 transition-colors hover:border-slate-700"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-slate-400">{kpi.label}</span>
              <span className={`font-mono text-2xl font-semibold tabular-nums ${kpi.accent}`}>
                {kpi.value.toLocaleString()}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">{kpi.subtext}</p>
          </div>
        ))}
      </section>

      {/* 4 Analytical Charts Grid */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Chart 1: Leads Discovered by Day */}
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Leads Discovered by Day</h3>
              <p className="text-xs text-slate-400">7-day discovery velocity from database records</p>
            </div>
            <TrendingUp className="h-4 w-4 text-blue-400" />
          </div>
          <div className="flex h-44 items-end gap-3 pt-4 border-b border-slate-800/80 pb-2">
            {metrics.byDay.map((d) => {
              const heightPct = Math.max(8, Math.round((d.count / maxDayCount) * 100));
              return (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-1.5 h-full justify-end">
                  <span className="font-mono text-[11px] text-slate-300 tabular-nums">
                    {d.count}
                  </span>
                  <div
                    className="w-full max-w-[36px] rounded-t-md bg-gradient-to-t from-blue-600/80 to-violet-500/90 transition-all"
                    style={{ height: `${heightPct}%` }}
                    title={`${d.date}: ${d.count} leads`}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between gap-3">
            {metrics.byDay.map((d) => (
              <span
                key={d.date}
                className="flex-1 text-center font-mono text-[11px] text-slate-400 tabular-nums"
              >
                {d.date}
              </span>
            ))}
          </div>
        </div>

        {/* Chart 2: Lead Sources Breakdown */}
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Lead Sources Distribution</h3>
              <p className="text-xs text-slate-400">Discovery channels feeding your CRM</p>
            </div>
            <Target className="h-4 w-4 text-violet-400" />
          </div>
          <div className="space-y-3">
            {metrics.bySource.map((item) => {
              const widthPct = Math.round((item.count / maxSourceCount) * 100);
              return (
                <div key={item.source} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-300">{item.label}</span>
                    <span className="font-mono text-slate-200 tabular-nums">
                      {item.count} {item.count === 1 ? 'lead' : 'leads'}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/90">
                    <div
                      className="h-full rounded-full bg-blue-500 transition-all"
                      style={{ width: `${item.count > 0 ? Math.max(6, widthPct) : 0}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart 3: Outreach Status Pipeline */}
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-white">Outreach Status Breakdown</h3>
            <p className="text-xs text-slate-400">Active distribution across CRM stages</p>
          </div>
          <div className="space-y-2.5">
            {metrics.byOutreachStatus.map((item) => {
              const widthPct = Math.round((item.count / maxStatusCount) * 100);
              return (
                <div key={item.status} className="grid grid-cols-12 items-center gap-2 text-xs">
                  <span className="col-span-5 truncate text-slate-300">{item.label}</span>
                  <div className="col-span-5 h-2 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-violet-500"
                      style={{ width: `${item.count > 0 ? Math.max(8, widthPct) : 0}%` }}
                    />
                  </div>
                  <span className="col-span-2 text-right font-mono text-slate-200 tabular-nums">
                    {item.count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Chart 4: Agency Conversion Funnel */}
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-white">Client Conversion Funnel</h3>
            <p className="text-xs text-slate-400">From initial discovery to signed web retainer</p>
          </div>
          <div className="space-y-2.5">
            {metrics.conversionFunnel.map((stage, idx) => (
              <div key={stage.stage} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300">
                    0{idx + 1}. {stage.stage}
                  </span>
                  <span className="font-mono text-slate-200 tabular-nums">
                    {stage.count} ({stage.percentage}%)
                  </span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-md bg-slate-800/90">
                  <div
                    className="h-full rounded-md bg-gradient-to-r from-blue-600 to-emerald-500"
                    style={{ width: `${stage.count > 0 ? Math.max(6, stage.percentage) : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Bottom Split: Top Priority Leads & Scheduled Follow-ups */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-slate-800/80 bg-[#111827] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-white">
                Highest-Scoring Prospects Ready for Action
              </h3>
              <p className="text-xs text-slate-400">
                Ranked by transparent qualification score (missing/outdated website + reviews + category)
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('crm')}
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-400 hover:text-blue-300 whitespace-nowrap shrink-0"
            >
              View All Leads
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {topLeads.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-800 p-8 text-center">
              <p className="text-sm text-slate-300">No leads in your workspace yet.</p>
              <p className="mt-1 text-xs text-slate-500">
                Use Lead Finder to discover local businesses or load sample agency data.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('finder')}
                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
              >
                Open Lead Finder
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-800/70">
              {topLeads.map((lead) => (
                <div
                  key={lead.id}
                  className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-white truncate">
                        {lead.businessName}
                      </span>
                      <span className="font-mono text-xs text-emerald-400 tabular-nums">
                        {lead.leadScore}/100
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                      <span>{lead.category}</span>
                      <span aria-hidden="true">·</span>
                      <span>{lead.city || 'Local'}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {lead.websiteStatus === 'missing_verified'
                          ? 'Verified No Website'
                          : lead.websiteStatus === 'outdated_verified'
                          ? 'Verified Outdated Site'
                          : lead.websiteStatus === 'modern_verified'
                          ? 'Modern Website'
                          : 'Website Unverified'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>Status: {LEAD_STATUS_LABELS[lead.status]}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onSelectLeadForResearch(lead)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Sparkles className="h-3.5 w-3.5 text-violet-400" />
                      AI Research
                    </button>
                    <button
                      type="button"
                      onClick={() => onSelectLeadForDm(lead)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 whitespace-nowrap"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      Draft DM
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Upcoming Follow-ups Queue */}
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-white">Upcoming Follow-Ups</h3>
            <p className="text-xs text-slate-400">Scheduled prospect touchpoints</p>
          </div>

          {pendingFollowups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center">
              <p className="text-xs text-slate-400">
                No pending follow-ups scheduled. Schedule follow-ups from any lead detail drawer in CRM.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {pendingFollowups.map((fup) => (
                <div
                  key={fup.id}
                  className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 space-y-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-semibold text-white">
                      {fup.leadBusinessName}
                    </span>
                    <span className="font-mono text-[11px] text-amber-400 tabular-nums shrink-0">
                      {fup.scheduledAt.slice(0, 10)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">{fup.notes}</p>
                  <button
                    type="button"
                    onClick={() => onCompleteFollowup(fup.id)}
                    className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/20"
                  >
                    Mark Completed
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
