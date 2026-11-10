import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  MessageSquare,
  Plus,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import {
  AIResearchSummary,
  BUSINESS_CATEGORIES,
  LeadRecord,
  WebsiteStatus,
} from '../types/leadpilot';
import { calculateLeadScore } from '../utils/scoringAndCrm';
import { authenticatedFetch } from '../lib/supabase';

interface SocialResearchViewProps {
  mode: 'instagram' | 'facebook' | 'ai_research';
  leads: LeadRecord[];
  selectedLead: LeadRecord | null;
  metaGraphConfigured: boolean;
  onSaveOrUpdateLead: (
    lead: Partial<LeadRecord>,
    existingId?: string
  ) => Promise<{ saved: boolean; lead?: LeadRecord; message: string }>;
  onOpenInDmGenerator: (lead: LeadRecord) => void;
}

export const SocialResearchView: React.FC<SocialResearchViewProps> = ({
  mode,
  leads,
  selectedLead,
  metaGraphConfigured,
  onSaveOrUpdateLead,
  onOpenInDmGenerator,
}) => {
  const [activeLeadId, setActiveLeadId] = useState<string>(selectedLead?.id || '');
  const [profileUrl, setProfileUrl] = useState<string>('');
  const [businessName, setBusinessName] = useState<string>('');
  const [category, setCategory] = useState<string>('Premium salons');
  const [city, setCity] = useState<string>('Mumbai');
  const [phone, setPhone] = useState<string>('');
  const [websiteUrl, setWebsiteUrl] = useState<string>('');
  const [websiteStatus, setWebsiteStatus] = useState<WebsiteStatus>('missing_verified');
  const [hasOnlineBooking, setHasOnlineBooking] = useState<boolean>(false);
  const [isPremiumService, setIsPremiumService] = useState<boolean>(false);
  const [rating, setRating] = useState<number>(4.6);
  const [reviewCount, setReviewCount] = useState<number>(65);
  const [notes, setNotes] = useState<string>('');

  const [aiResearch, setAiResearch] = useState<AIResearchSummary | null>(null);
  const [loadingAi, setLoadingAi] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (selectedLead) {
      populateFromLead(selectedLead);
    }
  }, [selectedLead, mode]);

  const populateFromLead = (lead: LeadRecord) => {
    const existingScore = calculateLeadScore(lead);
    const premiumMet = Boolean(
      existingScore.reasons.find((r) => r.key === 'premium_services')?.met
    );
    setActiveLeadId(lead.id);
    setBusinessName(lead.businessName);
    setCategory(lead.category || 'Premium salons');
    setCity(lead.city || '');
    setPhone(lead.phone || '');
    setWebsiteUrl(lead.websiteUrl || '');
    setWebsiteStatus(lead.websiteStatus || 'unverified');
    setHasOnlineBooking(Boolean(lead.hasOnlineBooking));
    setIsPremiumService(premiumMet);
    setRating(lead.rating || 0);
    setReviewCount(lead.reviewCount || 0);
    setNotes(lead.notes || '');
    setProfileUrl(
      mode === 'facebook'
        ? lead.facebookUrl || ''
        : lead.instagramUrl || lead.facebookUrl || ''
    );
    if (lead.aiResearchJson) {
      try {
        setAiResearch(JSON.parse(lead.aiResearchJson));
      } catch {
        setAiResearch(null);
      }
    } else {
      setAiResearch(null);
    }
  };

  const handleLeadPickerChange = (id: string) => {
    setActiveLeadId(id);
    if (!id) {
      setBusinessName('');
      setProfileUrl('');
      setWebsiteUrl('');
      setNotes('');
      setIsPremiumService(false);
      setAiResearch(null);
      return;
    }
    const found = leads.find((l) => l.id === id);
    if (found) populateFromLead(found);
  };

  const currentDraftLead: Partial<LeadRecord> = {
    businessName: businessName.trim(),
    category,
    city: city.trim(),
    phone: phone.trim(),
    websiteUrl: websiteUrl.trim(),
    websiteStatus,
    hasOnlineBooking,
    isPremiumService,
    hasActivePublicProfile: true,
    instagramUrl: mode === 'facebook' ? selectedLead?.instagramUrl || '' : profileUrl.trim(),
    facebookUrl: mode === 'facebook' ? profileUrl.trim() : selectedLead?.facebookUrl || '',
    googlePlaceId: selectedLead?.googlePlaceId || '',
    googleMapsUrl: selectedLead?.googleMapsUrl || '',
    rating,
    reviewCount,
    source: mode === 'facebook' ? 'facebook' : mode === 'instagram' ? 'instagram' : selectedLead?.source || 'manual',
    verificationStatus: websiteStatus === 'unverified' ? 'needs_review' : 'verified',
    tags: isPremiumService
      ? `${selectedLead?.tags || ''},premium-verified`
      : (selectedLead?.tags || '').replace(/\bpremium-verified\b/gi, ''),
    notes: notes.trim(),
  };

  const liveScore = calculateLeadScore(currentDraftLead);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessName.trim()) {
      setFeedback({ type: 'error', text: 'Business Name is required.' });
      return;
    }
    if ((mode === 'instagram' || mode === 'facebook') && !profileUrl.trim()) {
      setFeedback({
        type: 'error',
        text: `Please enter the public ${mode === 'instagram' ? 'Instagram profile' : 'Facebook Page'} URL.`,
      });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const payload: Partial<LeadRecord> = {
        ...currentDraftLead,
        leadScore: liveScore.totalScore,
        aiResearchJson: aiResearch ? JSON.stringify(aiResearch) : '',
      };
      const result = await onSaveOrUpdateLead(payload, activeLeadId || undefined);
      if (result.saved && result.lead) {
        setActiveLeadId(result.lead.id);
      }
      setFeedback({
        type: result.saved ? 'success' : 'error',
        text: result.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateAiResearch = async () => {
    if (!businessName.trim()) {
      setFeedback({
        type: 'error',
        text: 'Please enter or select a Business Name before running Gemini AI Research.',
      });
      return;
    }

    setLoadingAi(true);
    setFeedback(null);

    try {
      const res = await authenticatedFetch('/api/ai/research', {
        method: 'POST',
        body: JSON.stringify({
          businessName: businessName.trim(),
          category,
          city: city.trim(),
          websiteUrl: websiteUrl.trim(),
          websiteStatus,
          rating,
          reviewCount,
          instagramUrl: mode === 'facebook' ? '' : profileUrl.trim(),
          facebookUrl: mode === 'facebook' ? profileUrl.trim() : '',
          notes: notes.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'AI Research failed.');

      const summary: AIResearchSummary = data.research;
      setAiResearch(summary);

      // Persist research automatically if lead is saved or save it now
      const saveRes = await onSaveOrUpdateLead(
        {
          ...currentDraftLead,
          leadScore: liveScore.totalScore,
          status: 'qualified',
          aiResearchJson: JSON.stringify(summary),
        },
        activeLeadId || undefined
      );
      if (saveRes.saved && saveRes.lead) {
        setActiveLeadId(saveRes.lead.id);
      }

      setFeedback({
        type: 'success',
        text: 'Generated Gemini structured business research & updated CRM record.',
      });
    } catch (err: any) {
      setFeedback({
        type: 'error',
        text: err.message || 'Failed to generate AI research summary.',
      });
    } finally {
      setLoadingAi(false);
    }
  };

  const handleProceedToDm = async () => {
    if (!businessName.trim()) {
      setFeedback({ type: 'error', text: 'Please enter or select a business first.' });
      return;
    }
    const saveRes = await onSaveOrUpdateLead(
      {
        ...currentDraftLead,
        leadScore: liveScore.totalScore,
        aiResearchJson: aiResearch ? JSON.stringify(aiResearch) : '',
      },
      activeLeadId || undefined
    );
    const targetLead =
      saveRes.lead ||
      leads.find((l) => l.id === activeLeadId) ||
      ({
        id: activeLeadId || `temp_${Date.now()}`,
        userId: 'demo_user',
        ...currentDraftLead,
        leadScore: liveScore.totalScore,
        status: 'qualified',
        lastVerifiedAt: new Date().toISOString(),
        lastContactedAt: '',
        nextFollowUpAt: '',
        tags: '',
        aiResearchJson: aiResearch ? JSON.stringify(aiResearch) : '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as LeadRecord);

    onOpenInDmGenerator(targetLead);
  };

  const titleByMode = {
    instagram: 'Instagram Public Profile Research Workspace',
    facebook: 'Facebook Business Page Research Workspace',
    ai_research: 'Gemini AI Business Research & Qualification Engine',
  }[mode];

  const subtitleByMode = {
    instagram:
      'Record manually discovered public Instagram business profiles, verify website presence, and generate AI research summaries.',
    facebook:
      'Capture public Facebook Business Pages, store verified contact details, and synthesize website conversion opportunities.',
    ai_research:
      'Generate structured JSON research separating verified facts from strategic website and booking recommendations.',
  }[mode];

  return (
    <div className="space-y-6">
      {/* Meta Official API Compliance & Integration Status Banner */}
      {(mode === 'instagram' || mode === 'facebook') && (
        <section className="rounded-xl border border-slate-800/80 bg-[#111827] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <ShieldAlert className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
              <div className="space-y-0.5 text-xs">
                <p className="font-medium text-white">
                  Meta Graph API Compliance Mode:{' '}
                  {metaGraphConfigured
                    ? 'Authorized Graph Token Connected'
                    : 'Manual Public Profile Research Workflow Active'}
                </p>
                <p className="text-slate-400">
                  LeadPilot AI strictly prohibits scraping Instagram/Facebook pages, bypassing login, or automating bulk unsolicited DMs. Arbitrary profile discovery is not supported by official Meta APIs without business authorization — record verified public profile details below.
                </p>
              </div>
            </div>
            <span className="font-mono text-[11px] text-emerald-400 shrink-0">
              Policy Compliant
            </span>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column: Research Capture Form */}
        <section className="lg:col-span-5 rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-white">{titleByMode}</h2>
            <p className="mt-1 text-xs text-slate-400">{subtitleByMode}</p>
          </div>

          {/* Load Existing CRM Lead or Create New */}
          <div>
            <label htmlFor="social-lead-picker" className="block text-xs font-medium text-slate-300 mb-1">
              Load Existing CRM Lead (or leave blank to create new)
            </label>
            <select
              id="social-lead-picker"
              value={activeLeadId}
              onChange={(e) => handleLeadPickerChange(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
            >
              <option value="">+ Create New Research Profile</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.businessName} ({l.city || 'No city'} · {l.leadScore}/100)
                </option>
              ))}
            </select>
          </div>

          <form onSubmit={handleSaveProfile} className="space-y-3.5">
            {(mode === 'instagram' || mode === 'facebook') && (
              <div>
                <label htmlFor="social-profile-url" className="block text-xs font-medium text-slate-300 mb-1">
                  {mode === 'instagram'
                    ? 'Instagram Public Profile URL *'
                    : 'Facebook Business Page URL *'}
                </label>
                <div className="flex gap-2">
                  <input
                    id="social-profile-url"
                    type="url"
                    value={profileUrl}
                    onChange={(e) => setProfileUrl(e.target.value)}
                    placeholder={
                      mode === 'instagram'
                        ? 'https://instagram.com/businesshandle'
                        : 'https://facebook.com/businesspage'
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                  {profileUrl && (
                    <a
                      href={profileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800 px-3 text-slate-200 hover:bg-slate-700"
                      title="Open public profile in new tab"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="social-business-name" className="block text-xs font-medium text-slate-300 mb-1">
                  Business Name *
                </label>
                <input
                  id="social-business-name"
                  type="text"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  placeholder="e.g., Maison Glow Studio"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="social-category" className="block text-xs font-medium text-slate-300 mb-1">
                  Verified Category
                </label>
                <select
                  id="social-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
                >
                  {BUSINESS_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="social-city" className="block text-xs font-medium text-slate-300 mb-1">
                  City
                </label>
                <input
                  id="social-city"
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="e.g., Mumbai"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="social-phone" className="block text-xs font-medium text-slate-300 mb-1">
                  Public Phone / WhatsApp
                </label>
                <input
                  id="social-phone"
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98200 00000"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="social-website-url" className="block text-xs font-medium text-slate-300 mb-1">
                  Public Website URL (if any)
                </label>
                <input
                  id="social-website-url"
                  type="text"
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  placeholder="Leave blank if none"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="social-website-status" className="block text-xs font-medium text-slate-300 mb-1">
                  Website Verification Status
                </label>
                <select
                  id="social-website-status"
                  value={websiteStatus}
                  onChange={(e) => setWebsiteStatus(e.target.value as WebsiteStatus)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
                >
                  <option value="missing_verified">Verified Missing Website (+30 pts)</option>
                  <option value="outdated_verified">Verified Outdated Website (+20 pts)</option>
                  <option value="unverified">Unverified (0 pts)</option>
                  <option value="modern_verified">Verified Modern Website (0 pts)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="social-rating" className="block text-xs font-medium text-slate-300 mb-1">
                  Rating (0–5)
                </label>
                <input
                  id="social-rating"
                  type="number"
                  step="0.1"
                  min={0}
                  max={5}
                  value={rating}
                  onChange={(e) => setRating(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="social-reviews" className="block text-xs font-medium text-slate-300 mb-1">
                  Reviews Count
                </label>
                <input
                  id="social-reviews"
                  type="number"
                  min={0}
                  value={reviewCount}
                  onChange={(e) => setReviewCount(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="flex flex-col justify-end gap-1.5 pb-1">
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasOnlineBooking}
                    onChange={(e) => setHasOnlineBooking(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-900 text-blue-600"
                  />
                  Has Online Booking
                </label>
                <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isPremiumService}
                    onChange={(e) => setIsPremiumService(e.target.checked)}
                    className="rounded border-slate-600 bg-slate-900 text-blue-600"
                  />
                  Premium Services (+10)
                </label>
              </div>
            </div>

            <div>
              <label htmlFor="social-notes" className="block text-xs font-medium text-slate-300 mb-1">
                Verified Research Notes
              </label>
              <textarea
                id="social-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g., Bio says 'DM or WhatsApp for appointments', active reels with 15k+ views, no website link in bio."
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            {/* Live Transparent Lead Score Preview */}
            <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 flex items-center justify-between">
              <div className="text-xs">
                <span className="text-slate-400">Live Qualification Score: </span>
                <strong className="font-mono text-white tabular-nums">
                  {liveScore.totalScore}/100
                </strong>
                <span className="text-slate-400"> · {liveScore.priority}</span>
              </div>
              <span className="font-mono text-[11px] text-emerald-400">
                {liveScore.reasons.filter((r) => r.met).length} criteria met
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                {saving ? 'Saving...' : activeLeadId ? 'Update CRM Profile' : 'Save Profile to CRM'}
              </button>

              <button
                type="button"
                disabled={loadingAi}
                onClick={handleGenerateAiResearch}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {loadingAi ? 'Analyzing with Gemini...' : 'Generate AI Business Summary'}
              </button>

              <button
                type="button"
                onClick={handleProceedToDm}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Generate Outreach Drafts
              </button>
            </div>
          </form>

          {feedback && (
            <div
              className={`flex items-center gap-2 rounded-lg border px-3.5 py-2.5 text-xs ${
                feedback.type === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-200'
                  : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
              }`}
            >
              {feedback.type === 'error' ? (
                <AlertCircle className="h-4 w-4 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              )}
              <span>{feedback.text}</span>
            </div>
          )}
        </section>

        {/* Right Column: Structured AI Business Research Output & Transparent Scoring */}
        <section className="lg:col-span-7 space-y-5">
          {/* Transparent Lead Scoring Reasons Card */}
          <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Transparent Lead Scoring Breakdown
                </h3>
                <p className="text-xs text-slate-400">
                  Every scoring factor is explicitly verified — missing data is never penalized
                </p>
              </div>
              <div className="text-right font-mono tabular-nums">
                <span className="text-xl font-bold text-emerald-400">
                  {liveScore.totalScore}
                </span>
                <span className="text-xs text-slate-400">/100 ({liveScore.priority})</span>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {liveScore.reasons.map((r) => (
                <div
                  key={r.key}
                  className={`rounded-lg border p-2.5 text-xs ${
                    r.met
                      ? 'border-emerald-500/30 bg-emerald-500/5 text-slate-200'
                      : 'border-slate-800 bg-slate-900/40 text-slate-400'
                  }`}
                >
                  <div className="flex items-center justify-between font-medium">
                    <span>{r.label}</span>
                    <span
                      className={`font-mono tabular-nums ${
                        r.met ? 'text-emerald-400' : 'text-slate-500'
                      }`}
                    >
                      {r.met ? `+${r.points}` : '0'} pts
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-slate-400">{r.explanation}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Gemini Structured JSON Business Research Output */}
          <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Gemini Structured Business Research Report
                </h3>
                <p className="text-xs text-slate-400">
                  Strictly separates verified CRM facts from strategic AI website recommendations
                </p>
              </div>
              {aiResearch && (
                <span className="font-mono text-[11px] text-slate-400">
                  Generated {aiResearch.generatedAt.slice(0, 10)}
                </span>
              )}
            </div>

            {loadingAi ? (
              <div className="space-y-3 py-6">
                <div className="h-5 w-2/3 animate-pulse rounded bg-slate-800" />
                <div className="h-16 w-full animate-pulse rounded bg-slate-800/70" />
                <div className="h-24 w-full animate-pulse rounded bg-slate-800/70" />
              </div>
            ) : !aiResearch ? (
              <div className="rounded-lg border border-dashed border-slate-800 p-8 text-center space-y-3">
                <Sparkles className="h-6 w-6 text-violet-400 mx-auto" />
                <p className="text-sm text-slate-300">
                  No AI Business Research generated for this prospect yet.
                </p>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  Select a lead or fill in the business details on the left, then click "Generate AI Business Summary" to produce a structured JSON assessment.
                </p>
              </div>
            ) : (
              <div className="space-y-4 text-xs">
                <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1.5">
                  <div className="font-semibold text-white">Business Overview & Positioning</div>
                  <p className="text-slate-300 leading-relaxed">{aiResearch.businessOverview}</p>
                  <p className="text-slate-400 pt-1">
                    <strong className="text-slate-200">Brand Positioning:</strong>{' '}
                    {aiResearch.brandPositioning}
                  </p>
                </div>

                {/* Fact vs Suggestion Separation */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3.5 space-y-2">
                    <div className="font-semibold text-emerald-300">
                      Verified Facts (From CRM & Public Data)
                    </div>
                    <ul className="list-disc pl-4 space-y-1 text-slate-300">
                      {aiResearch.onlinePresenceAssessment.verifiedFacts.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3.5 space-y-2">
                    <div className="font-semibold text-amber-300">
                      Unverified / Requires Discovery Call
                    </div>
                    <ul className="list-disc pl-4 space-y-1 text-slate-300">
                      {aiResearch.onlinePresenceAssessment.unverifiedAreas.map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1.5">
                    <div className="font-semibold text-white">Target Customers</div>
                    <ul className="list-disc pl-4 space-y-1 text-slate-300">
                      {aiResearch.targetCustomers.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1.5">
                    <div className="font-semibold text-white">Main Services Focus</div>
                    <ul className="list-disc pl-4 space-y-1 text-slate-300">
                      {aiResearch.mainServices.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1.5">
                    <div className="font-semibold text-blue-300">Website Opportunities</div>
                    <ul className="list-disc pl-4 space-y-1 text-slate-300">
                      {aiResearch.websiteOpportunities.map((o, i) => (
                        <li key={i}>{o}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1.5">
                    <div className="font-semibold text-violet-300">Suggested Website Sections</div>
                    <ul className="list-disc pl-4 space-y-1 text-slate-300">
                      {aiResearch.suggestedWebsiteSections.map((sec, i) => (
                        <li key={i}>{sec}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1.5">
                    <div className="font-semibold text-emerald-300">Suggested Booking Features</div>
                    <ul className="list-disc pl-4 space-y-1 text-slate-300">
                      {aiResearch.suggestedBookingFeatures.map((bf, i) => (
                        <li key={i}>{bf}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3.5 space-y-1">
                  <div className="font-semibold text-blue-200">
                    Recommended Personalized Outreach Angle
                  </div>
                  <p className="text-slate-200">{aiResearch.personalizedOutreachAngle}</p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
