import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Ban,
  Check,
  CheckCircle2,
  Copy,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react';
import {
  LeadRecord,
  MessageLanguage,
  MessageRecord,
  MessageStatus,
  MessageStyle,
  OutreachPlatform,
} from '../types/leadpilot';
import { authenticatedFetch } from '../lib/supabase';

interface AiDmGeneratorViewProps {
  leads: LeadRecord[];
  messages: MessageRecord[];
  selectedLead: LeadRecord | null;
  agencyName: string;
  onSaveMessage: (
    msg: Omit<MessageRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>,
    existingId?: string
  ) => Promise<void>;
  onMarkLeadOptedOut: (leadId: string) => Promise<void>;
}

export const AiDmGeneratorView: React.FC<AiDmGeneratorViewProps> = ({
  leads,
  messages,
  selectedLead,
  agencyName,
  onSaveMessage,
  onMarkLeadOptedOut,
}) => {
  const activeLeads = leads.filter((l) => l.status !== 'opted_out');
  const [targetLeadId, setTargetLeadId] = useState<string>(
    selectedLead?.id || activeLeads[0]?.id || ''
  );
  const [platform, setPlatform] = useState<OutreachPlatform>('instagram');
  const [tone, setTone] = useState<MessageStyle>('Friendly');
  const [language, setLanguage] = useState<MessageLanguage>('English');

  const [variations, setVariations] = useState<string[]>([]);
  const [selectedVariationIdx, setSelectedVariationIdx] = useState<number>(0);
  const [editorText, setEditorText] = useState<string>('');
  const [replyNotes, setReplyNotes] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    if (selectedLead) {
      setTargetLeadId(selectedLead.id);
    }
  }, [selectedLead]);

  const currentLead = leads.find((l) => l.id === targetLeadId) || null;
  const isOptedOut = currentLead?.status === 'opted_out';

  const handleGenerateVariations = async () => {
    if (!currentLead) {
      setFeedback({ type: 'error', text: 'Please select a lead from your CRM first.' });
      return;
    }
    if (currentLead.status === 'opted_out') {
      setFeedback({
        type: 'error',
        text: 'Compliance Lock: This prospect has opted out and cannot be contacted.',
      });
      return;
    }

    setLoading(true);
    setFeedback(null);
    try {
      const res = await authenticatedFetch('/api/ai/generate-dms', {
        method: 'POST',
        body: JSON.stringify({
          leadId: currentLead.id,
          leadStatus: currentLead.status,
          businessName: currentLead.businessName,
          category: currentLead.category,
          city: currentLead.city,
          websiteStatus: currentLead.websiteStatus,
          rating: currentLead.rating,
          reviewCount: currentLead.reviewCount,
          platform,
          tone,
          language,
          notes: currentLead.notes,
          agencyName: agencyName || 'Northstar Web Studio',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to generate messages.');

      const list: string[] = Array.isArray(data.variations) ? data.variations : [];
      setVariations(list);
      setSelectedVariationIdx(0);
      setEditorText(list[0] || '');
      setFeedback({
        type: 'success',
        text: `Generated 3 personalized ${language} (${tone}) variations for ${currentLead.businessName}.`,
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!editorText.trim()) return;
    try {
      await navigator.clipboard.writeText(editorText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFeedback({ type: 'info', text: 'Selected text ready to copy.' });
    }
  };

  const handlePersistStatus = async (status: MessageStatus) => {
    if (!currentLead) return;
    if (currentLead.status === 'opted_out' && status !== 'opted_out') {
      setFeedback({
        type: 'error',
        text: 'Opted-out leads are permanently locked from outreach queues.',
      });
      return;
    }
    if (!editorText.trim() && status !== 'opted_out') {
      setFeedback({
        type: 'error',
        text: 'Please generate or write a message before saving.',
      });
      return;
    }

    const nowIso = new Date().toISOString();
    await onSaveMessage({
      leadId: currentLead.id,
      leadBusinessName: currentLead.businessName,
      platform,
      messageBody: editorText.trim() || '[Opted Out]',
      language,
      tone,
      status,
      approvedAt: status === 'approved' || status === 'sent' ? nowIso : '',
      sentAt: status === 'sent' || status === 'replied' ? nowIso : '',
      replyNotes: replyNotes.trim(),
    });

    if (status === 'opted_out') {
      await onMarkLeadOptedOut(currentLead.id);
    }

    const statusDescriptions: Record<MessageStatus, string> = {
      draft: 'Saved personalized message as Draft.',
      approved: 'Message marked as Approved and ready for manual outreach.',
      sent: `Recorded manual send on ${platform.toUpperCase()} and updated lead status to Contacted.`,
      replied: 'Recorded prospect reply and updated CRM status to Interested.',
      opted_out: 'Recorded Opt-Out. Lead permanently locked from future outreach queues.',
    };

    setFeedback({
      type: 'success',
      text: statusDescriptions[status],
    });
  };

  const leadMessages = messages.filter((m) => m.leadId === targetLeadId);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Configuration & 3 Variations Selector */}
        <section className="lg:col-span-5 rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-white">
              AI Personalized First-Contact DM Generator
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Uses verified business details to craft 3 tailored variations. Never sends unsolicited automated messages.
            </p>
          </div>

          <div className="space-y-3.5">
            <div>
              <label htmlFor="dm-lead-select" className="block text-xs font-medium text-slate-300 mb-1">
                Select Prospect from CRM
              </label>
              <select
                id="dm-lead-select"
                value={targetLeadId}
                onChange={(e) => setTargetLeadId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
              >
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.businessName} ({l.city || 'Local'} · {l.leadScore}/100
                    {l.status === 'opted_out' ? ' · OPTED OUT' : ''})
                  </option>
                ))}
              </select>
            </div>

            {currentLead && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-white">{currentLead.businessName}</span>
                  <span className="font-mono text-emerald-400 tabular-nums">
                    Score: {currentLead.leadScore}/100
                  </span>
                </div>
                <div className="text-slate-400">
                  {currentLead.category} · {currentLead.city} ·{' '}
                  {currentLead.websiteStatus === 'missing_verified'
                    ? 'Verified Missing Website'
                    : currentLead.websiteStatus === 'outdated_verified'
                    ? 'Verified Outdated Website'
                    : 'Website Unverified / Present'}
                </div>
                {isOptedOut && (
                  <p className="text-red-400 font-medium pt-1">
                    Compliance Lock: Prospect has opted out. Outreach generation is disabled.
                  </p>
                )}
              </div>
            )}

            {/* Platform Selector */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Outreach Platform
              </label>
              <div className="grid grid-cols-4 gap-1.5 rounded-lg bg-slate-900 p-1 border border-slate-800">
                {(['instagram', 'facebook', 'whatsapp', 'email'] as OutreachPlatform[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPlatform(p)}
                    className={`rounded-md py-1.5 text-xs font-medium capitalize transition-colors ${
                      platform === p
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Style / Tone & Language */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="dm-style" className="block text-xs font-medium text-slate-300 mb-1">
                  Message Style
                </label>
                <select
                  id="dm-style"
                  value={tone}
                  onChange={(e) => setTone(e.target.value as MessageStyle)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
                >
                  <option value="Friendly">Friendly</option>
                  <option value="Professional">Professional</option>
                  <option value="Premium">Premium</option>
                  <option value="Short and natural">Short and natural</option>
                </select>
              </div>

              <div>
                <label htmlFor="dm-language" className="block text-xs font-medium text-slate-300 mb-1">
                  Language
                </label>
                <select
                  id="dm-language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as MessageLanguage)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
                >
                  <option value="English">English</option>
                  <option value="Hinglish">Hinglish</option>
                  <option value="Hindi">Hindi</option>
                </select>
              </div>
            </div>

            <button
              type="button"
              disabled={loading || isOptedOut || !currentLead}
              onClick={handleGenerateVariations}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {loading ? 'Generating 3 Variations...' : 'Generate 3 Personalized Variations'}
            </button>
          </div>

          {/* 3 Generated Variations Cards */}
          {variations.length > 0 && (
            <div className="space-y-2.5 pt-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-300">Select a Variation to Edit & Approve</span>
                <button
                  type="button"
                  onClick={handleGenerateVariations}
                  className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  <RefreshCw className="h-3 w-3" />
                  Regenerate
                </button>
              </div>

              {variations.map((v, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setSelectedVariationIdx(idx);
                    setEditorText(v);
                  }}
                  className={`w-full text-left rounded-lg border p-3 text-xs transition-colors ${
                    selectedVariationIdx === idx
                      ? 'border-blue-500 bg-blue-500/10 text-white'
                      : 'border-slate-800 bg-slate-900/50 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="font-mono text-[11px] text-blue-400 mb-1">
                    Variation 0{idx + 1} · {language} · {tone}
                  </div>
                  <p className="leading-relaxed">{v}</p>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Right Column: Message Review, Approval, Manual Send & Reply/Opt-Out Tracker */}
        <section className="lg:col-span-7 space-y-5">
          <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Human-in-the-Loop Message Review & Approval
                </h3>
                <p className="text-xs text-slate-400">
                  Review, customize, approve, and log manual outreach or replies
                </p>
              </div>

              <button
                type="button"
                onClick={handleCopy}
                disabled={!editorText.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    Copy Message
                  </>
                )}
              </button>
            </div>

            <div>
              <label htmlFor="dm-editor-textarea" className="block text-xs font-medium text-slate-300 mb-1">
                Personalized Outreach Draft ({platform.toUpperCase()})
              </label>
              <textarea
                id="dm-editor-textarea"
                rows={5}
                value={editorText}
                onChange={(e) => setEditorText(e.target.value)}
                placeholder="Click 'Generate 3 Personalized Variations' on the left or write your custom message here..."
                className="w-full rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs text-white leading-relaxed placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="dm-reply-notes" className="block text-xs font-medium text-slate-300 mb-1">
                Prospect Reply / Outcome Notes (Optional)
              </label>
              <input
                id="dm-reply-notes"
                type="text"
                value={replyNotes}
                onChange={(e) => setReplyNotes(e.target.value)}
                placeholder="e.g., Replied asking for bridal website demo link on WhatsApp"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

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

            {/* Action Buttons */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button
                type="button"
                disabled={isOptedOut}
                onClick={() => handlePersistStatus('draft')}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
              >
                Save as Draft
              </button>

              <button
                type="button"
                disabled={isOptedOut}
                onClick={() => handlePersistStatus('approved')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                Mark as Approved
              </button>

              <button
                type="button"
                disabled={isOptedOut}
                onClick={() => handlePersistStatus('sent')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                Mark as Manually Sent
              </button>

              <button
                type="button"
                disabled={isOptedOut}
                onClick={() => handlePersistStatus('replied')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Record Prospect Reply
              </button>

              <button
                type="button"
                onClick={() => handlePersistStatus('opted_out')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3.5 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20 ml-auto"
              >
                <Ban className="h-3.5 w-3.5" />
                Record Opt-Out
              </button>
            </div>
          </div>

          {/* Saved Outreach History for Selected Lead */}
          <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
            <h3 className="text-sm font-semibold text-white mb-3">
              Outreach History for {currentLead?.businessName || 'Selected Lead'} ({leadMessages.length})
            </h3>

            {leadMessages.length === 0 ? (
              <p className="text-xs text-slate-400">
                No drafts or sent messages recorded for this business yet.
              </p>
            ) : (
              <div className="space-y-3">
                {leadMessages.map((m) => (
                  <div
                    key={m.id}
                    className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 text-xs space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-slate-400">
                      <div>
                        <span className="font-semibold text-white uppercase">{m.platform}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{m.language}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{m.tone}</span>
                        <span aria-hidden="true"> · </span>
                        <span className="text-blue-400 font-medium">Status: {m.status}</span>
                      </div>
                      <span className="font-mono text-[11px] tabular-nums">
                        {m.sentAt ? `Sent ${m.sentAt.slice(0, 10)}` : `Drafted ${m.createdAt.slice(0, 10)}`}
                      </span>
                    </div>
                    <p className="text-slate-200 leading-relaxed">{m.messageBody}</p>
                    {m.replyNotes && (
                      <p className="text-emerald-300 text-[11px]">
                        Reply Note: {m.replyNotes}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
