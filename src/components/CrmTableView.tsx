import React, { useState } from 'react';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Edit3,
  ExternalLink,
  Eye,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import {
  ActivityRecord,
  BUSINESS_CATEGORIES,
  FollowupRecord,
  LEAD_STATUS_LABELS,
  LeadRecord,
  LeadStatus,
  WebsiteStatus,
} from '../types/leadpilot';
import {
  calculateLeadScore,
  canTransitionLeadStatus,
} from '../utils/scoringAndCrm';

interface CrmTableViewProps {
  leads: LeadRecord[];
  activities: ActivityRecord[];
  followups: FollowupRecord[];
  onSaveOrUpdateLead: (
    lead: Partial<LeadRecord>,
    existingId?: string
  ) => Promise<{ saved: boolean; lead?: LeadRecord; message: string }>;
  onDeleteLead: (id: string) => Promise<void>;
  onBulkAddTag: (ids: string[], tag: string) => Promise<void>;
  onScheduleFollowup: (
    leadId: string,
    leadBusinessName: string,
    scheduledAt: string,
    notes: string
  ) => Promise<void>;
  onSelectLeadForResearch: (lead: LeadRecord) => void;
  onSelectLeadForDm: (lead: LeadRecord) => void;
}

export const CrmTableView: React.FC<CrmTableViewProps> = ({
  leads,
  activities,
  followups,
  onSaveOrUpdateLead,
  onDeleteLead,
  onBulkAddTag,
  onScheduleFollowup,
  onSelectLeadForResearch,
  onSelectLeadForDm,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [priorityFilter, setPriorityFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'score_desc' | 'score_asc' | 'rating_desc' | 'newest'>('score_desc');
  const [currentPage, setCurrentPage] = useState<number>(1);
  const pageSize = 8;

  // Bulk selection & tagging
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkTagInput, setBulkTagInput] = useState('');

  // Add / Edit Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formState, setFormState] = useState<{
    businessName: string;
    category: string;
    city: string;
    state: string;
    country: string;
    address: string;
    phone: string;
    websiteUrl: string;
    websiteStatus: WebsiteStatus;
    hasOnlineBooking: boolean;
    missingBookingVerified: boolean;
    isPremiumService: boolean;
    instagramUrl: string;
    facebookUrl: string;
    rating: number;
    reviewCount: number;
    status: LeadStatus;
    tags: string;
    notes: string;
  }>({
    businessName: '',
    category: 'Premium salons',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'India',
    address: '',
    phone: '',
    websiteUrl: '',
    websiteStatus: 'missing_verified',
    hasOnlineBooking: false,
    missingBookingVerified: true,
    isPremiumService: false,
    instagramUrl: '',
    facebookUrl: '',
    rating: 4.5,
    reviewCount: 60,
    status: 'new',
    tags: '',
    notes: '',
  });

  // Detail Drawer State
  const [detailLeadId, setDetailLeadId] = useState<string | null>(null);
  const [fupDate, setFupDate] = useState<string>('');
  const [fupNotes, setFupNotes] = useState<string>('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const detailLead = leads.find((l) => l.id === detailLeadId) || null;

  // Filter & Sort
  const filteredLeads = leads
    .filter((l) => {
      if (statusFilter !== 'all' && l.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && l.category !== categoryFilter) return false;
      if (priorityFilter === 'high' && l.leadScore < 75) return false;
      if (priorityFilter === 'medium' && (l.leadScore < 55 || l.leadScore >= 75)) return false;
      if (priorityFilter === 'low' && l.leadScore >= 55) return false;

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const hay = `${l.businessName} ${l.category} ${l.city} ${l.phone} ${l.tags} ${l.notes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'score_desc') return b.leadScore - a.leadScore;
      if (sortBy === 'score_asc') return a.leadScore - b.leadScore;
      if (sortBy === 'rating_desc') return (b.rating || 0) - (a.rating || 0);
      return b.createdAt.localeCompare(a.createdAt);
    });

  const totalPages = Math.max(1, Math.ceil(filteredLeads.length / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const paginatedLeads = filteredLeads.slice((safePage - 1) * pageSize, safePage * pageSize);

  const openAddModal = () => {
    setEditingId(null);
    setFormState({
      businessName: '',
      category: 'Premium salons',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      address: '',
      phone: '',
      websiteUrl: '',
      websiteStatus: 'missing_verified',
      hasOnlineBooking: false,
      missingBookingVerified: true,
      isPremiumService: false,
      instagramUrl: '',
      facebookUrl: '',
      rating: 4.5,
      reviewCount: 60,
      status: 'new',
      tags: '',
      notes: '',
    });
    setModalOpen(true);
  };

  const openEditModal = (lead: LeadRecord) => {
    const existingBreakdown = calculateLeadScore(lead);
    const bookingMet = Boolean(
      existingBreakdown.reasons.find((r) => r.key === 'online_booking')?.met
    );
    const premiumMet = Boolean(
      existingBreakdown.reasons.find((r) => r.key === 'premium_services')?.met
    );
    setEditingId(lead.id);
    setFormState({
      businessName: lead.businessName,
      category: lead.category,
      city: lead.city,
      state: lead.state,
      country: lead.country,
      address: lead.address,
      phone: lead.phone,
      websiteUrl: lead.websiteUrl,
      websiteStatus: lead.websiteStatus,
      hasOnlineBooking: lead.hasOnlineBooking,
      missingBookingVerified: bookingMet,
      isPremiumService: premiumMet,
      instagramUrl: lead.instagramUrl,
      facebookUrl: lead.facebookUrl,
      rating: lead.rating,
      reviewCount: lead.reviewCount,
      status: lead.status,
      tags: lead.tags,
      notes: lead.notes,
    });
    setModalOpen(true);
  };

  const buildModalCandidate = (): Partial<LeadRecord> => {
    const existing = editingId ? leads.find((l) => l.id === editingId) : undefined;
    const rawTags = formState.tags
      .split(',')
      .map((t) => t.trim())
      .filter(
        (t) =>
          Boolean(t) &&
          t !== 'booking-verified' &&
          t !== 'no-booking' &&
          t !== 'premium-verified'
      );
    if (formState.missingBookingVerified && !formState.hasOnlineBooking) {
      rawTags.push('booking-verified');
    }
    if (formState.isPremiumService) {
      rawTags.push('premium-verified');
    }

    return {
      ...existing,
      businessName: formState.businessName,
      category: formState.category,
      city: formState.city,
      state: formState.state,
      country: formState.country,
      address: formState.address,
      phone: formState.phone,
      websiteUrl: formState.websiteUrl,
      websiteStatus: formState.websiteStatus,
      hasOnlineBooking: formState.missingBookingVerified ? false : formState.hasOnlineBooking,
      isPremiumService: formState.isPremiumService,
      hasActivePublicProfile: true,
      instagramUrl: formState.instagramUrl,
      facebookUrl: formState.facebookUrl,
      rating: Number(formState.rating) || 0,
      reviewCount: Math.max(0, Math.floor(Number(formState.reviewCount) || 0)),
      status: formState.status,
      tags: rawTags.join(','),
      notes: formState.notes,
      source: existing?.source || 'manual',
      verificationStatus:
        formState.websiteStatus === 'unverified' ? 'needs_review' : 'verified',
    };
  };

  const modalLiveBreakdown = calculateLeadScore(buildModalCandidate());

  const handleModalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formState.businessName.trim()) {
      setFeedback({ type: 'error', text: 'Business Name is required.' });
      return;
    }

    if (editingId) {
      const existing = leads.find((l) => l.id === editingId);
      if (existing) {
        const guard = canTransitionLeadStatus(existing.status, formState.status);
        if (!guard.allowed) {
          setFeedback({ type: 'error', text: guard.error! });
          return;
        }
      }
    }

    const candidate = buildModalCandidate();
    const res = await onSaveOrUpdateLead(candidate, editingId || undefined);

    if (!res.saved) {
      setFeedback({ type: 'error', text: res.message });
      return;
    }

    setFeedback({ type: 'success', text: res.message });
    setModalOpen(false);
  };

  const handleInlineStatusChange = async (lead: LeadRecord, nextStatus: LeadStatus) => {
    const guard = canTransitionLeadStatus(lead.status, nextStatus);
    if (!guard.allowed) {
      setFeedback({ type: 'error', text: guard.error! });
      return;
    }
    const res = await onSaveOrUpdateLead({ ...lead, status: nextStatus }, lead.id);
    setFeedback({ type: res.saved ? 'success' : 'error', text: res.message });
  };

  const handleApplyBulkTag = async () => {
    if (!bulkTagInput.trim() || selectedIds.length === 0) return;
    await onBulkAddTag(selectedIds, bulkTagInput.trim());
    setFeedback({
      type: 'success',
      text: `Applied tag "${bulkTagInput.trim()}" to ${selectedIds.length} leads.`,
    });
    setBulkTagInput('');
    setSelectedIds([]);
  };

  const handleScheduleFupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!detailLead || !fupDate) return;
    await onScheduleFollowup(
      detailLead.id,
      detailLead.businessName,
      fupDate,
      fupNotes.trim() || 'Scheduled follow-up check-in'
    );
    setFupDate('');
    setFupNotes('');
    setFeedback({
      type: 'success',
      text: `Follow-up scheduled for ${detailLead.businessName}.`,
    });
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  return (
    <div className="space-y-5">
      {/* Top Controls Bar */}
      <section className="rounded-xl border border-slate-800/80 bg-[#111827] p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">
              CRM Pipeline & Qualification Table ({filteredLeads.length})
            </h2>
            <p className="text-xs text-slate-400">
              Search, sort, bulk-tag, and manage leads across all 13 outreach stages with Opt-Out compliance locking
            </p>
          </div>

          <button
            type="button"
            onClick={openAddModal}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            Add Lead Manually
          </button>
        </div>

        {/* Search, Filter & Sort Controls */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              aria-label="Search CRM leads"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setCurrentPage(1);
              }}
              placeholder="Search name, city, phone, tags..."
              className="w-full rounded-lg border border-slate-700 bg-slate-900 pl-8 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <select
            aria-label="Filter by Lead Status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setCurrentPage(1);
            }}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
          >
            <option value="all">All Pipeline Statuses</option>
            {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[]).map((st) => (
              <option key={st} value={st}>
                {LEAD_STATUS_LABELS[st]}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by Business Category"
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              setCurrentPage(1);
            }}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
          >
            <option value="all">All Business Categories</option>
            {BUSINESS_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            aria-label="Filter by Priority Tier"
            value={priorityFilter}
            onChange={(e) => {
              setPriorityFilter(e.target.value);
              setCurrentPage(1);
            }}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
          >
            <option value="all">All Score Tiers</option>
            <option value="high">High Priority (80–100)</option>
            <option value="medium">Medium Priority (60–79)</option>
            <option value="low">Low Priority (0–59)</option>
          </select>

          <select
            aria-label="Sort CRM leads"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
          >
            <option value="score_desc">Sort: Highest Lead Score</option>
            <option value="score_asc">Sort: Lowest Lead Score</option>
            <option value="rating_desc">Sort: Highest Rating</option>
            <option value="newest">Sort: Recently Added</option>
          </select>
        </div>

        {/* Bulk Tagging Bar */}
        {selectedIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2.5 text-xs">
            <span className="font-medium text-blue-200">
              {selectedIds.length} lead(s) selected
            </span>
            <input
              type="text"
              value={bulkTagInput}
              onChange={(e) => setBulkTagInput(e.target.value)}
              placeholder="Enter bulk tag (e.g., q4-campaign)"
              className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs text-white"
            />
            <button
              type="button"
              onClick={handleApplyBulkTag}
              className="inline-flex items-center gap-1 rounded bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-500"
            >
              <Tag className="h-3 w-3" />
              Apply Tag
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="text-slate-300 underline ml-auto"
            >
              Clear Selection
            </button>
          </div>
        )}

        {feedback && (
          <div
            className={`flex items-center justify-between rounded-lg border px-4 py-2.5 text-xs ${
              feedback.type === 'error'
                ? 'border-red-500/40 bg-red-500/10 text-red-200'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {feedback.type === 'error' ? (
                <AlertCircle className="h-4 w-4 shrink-0" />
              ) : (
                <CheckCircle2 className="h-4 w-4 shrink-0" />
              )}
              <span>{feedback.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-xs underline"
            >
              Dismiss
            </button>
          </div>
        )}
      </section>

      {/* Main 12-Column CRM Data Grid */}
      <section className="rounded-xl border border-slate-800/80 bg-[#111827] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400">
                <th className="py-3 px-3 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all visible leads"
                    checked={
                      paginatedLeads.length > 0 &&
                      paginatedLeads.every((l) => selectedIds.includes(l.id))
                    }
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds(paginatedLeads.map((l) => l.id));
                      } else {
                        setSelectedIds([]);
                      }
                    }}
                    className="rounded border-slate-700 bg-slate-900"
                  />
                </th>
                <th className="py-3 px-3">Business Name</th>
                <th className="py-3 px-3">Category · City</th>
                <th className="py-3 px-3">Phone</th>
                <th className="py-3 px-3">Website · Social</th>
                <th className="py-3 px-3 text-right">Lead Score</th>
                <th className="py-3 px-3">Source</th>
                <th className="py-3 px-3">Status</th>
                <th className="py-3 px-3">Last Contacted · Next Follow-Up</th>
                <th className="py-3 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 text-xs">
              {paginatedLeads.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-400">
                    No leads match your current filter criteria.
                  </td>
                </tr>
              ) : (
                paginatedLeads.map((lead) => (
                  <tr
                    key={lead.id}
                    className={`hover:bg-slate-800/40 transition-colors ${
                      lead.status === 'opted_out' ? 'opacity-60' : ''
                    }`}
                  >
                    <td className="py-3 px-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${lead.businessName}`}
                        checked={selectedIds.includes(lead.id)}
                        onChange={() => toggleSelectRow(lead.id)}
                        className="rounded border-slate-700 bg-slate-900"
                      />
                    </td>

                    <td className="py-3 px-3">
                      <button
                        type="button"
                        onClick={() => setDetailLeadId(lead.id)}
                        className="font-medium text-white hover:text-blue-400 text-left"
                      >
                        {lead.businessName}
                      </button>
                      {lead.tags && (
                        <div className="mt-0.5 text-[11px] text-slate-400 truncate max-w-[180px]">
                          Tags: {lead.tags}
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-3 text-slate-300">
                      <div>{lead.category}</div>
                      <div className="text-[11px] text-slate-400">{lead.city || '—'}</div>
                    </td>

                    <td className="py-3 px-3 font-mono text-[11px] text-slate-300 tabular-nums whitespace-nowrap">
                      {lead.phone || '—'}
                    </td>

                    <td className="py-3 px-3">
                      <div className="text-[11px] text-slate-300">
                        {lead.websiteStatus === 'missing_verified'
                          ? 'Verified No Website'
                          : lead.websiteStatus === 'outdated_verified'
                          ? 'Verified Outdated'
                          : lead.websiteStatus === 'modern_verified'
                          ? 'Modern Website'
                          : 'Website Unverified'}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-blue-400">
                        {lead.websiteUrl && (
                          <a
                            href={lead.websiteUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            Web
                          </a>
                        )}
                        {lead.instagramUrl && (
                          <a
                            href={lead.instagramUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            IG
                          </a>
                        )}
                        {lead.facebookUrl && (
                          <a
                            href={lead.facebookUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            FB
                          </a>
                        )}
                      </div>
                    </td>

                    <td className="py-3 px-3 text-right font-mono tabular-nums min-w-[240px] max-w-[280px]">
                      {(() => {
                        const rowBreakdown = calculateLeadScore(lead);
                        const earnedReasons = rowBreakdown.reasons.filter((r) => r.met);
                        return (
                          <>
                            <span
                              className={`font-semibold ${
                                rowBreakdown.totalScore >= 75
                                  ? 'text-emerald-400'
                                  : rowBreakdown.totalScore >= 55
                                  ? 'text-amber-400'
                                  : 'text-slate-400'
                              }`}
                            >
                              {rowBreakdown.totalScore}/100
                            </span>
                            <div className="text-[10px] text-slate-400">
                              {lead.rating ? `${lead.rating}★ (${lead.reviewCount})` : 'No rating'}
                            </div>
                            <div className="mt-1 flex flex-wrap justify-end gap-1 font-sans">
                              {earnedReasons.map((r) => (
                                <span
                                  key={r.key}
                                  title={r.explanation}
                                  className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-300 whitespace-nowrap"
                                >
                                  +{r.points} {r.label}
                                </span>
                              ))}
                            </div>
                          </>
                        );
                      })()}
                    </td>

                    <td className="py-3 px-3 text-[11px] text-slate-400">
                      {lead.source.replace('_', ' ')}
                    </td>

                    <td className="py-3 px-3">
                      <select
                        aria-label={`Status for ${lead.businessName}`}
                        value={lead.status}
                        onChange={(e) =>
                          handleInlineStatusChange(lead, e.target.value as LeadStatus)
                        }
                        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-white focus:border-blue-500 focus:outline-none"
                      >
                        {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[]).map((st) => (
                          <option key={st} value={st}>
                            {LEAD_STATUS_LABELS[st]}
                          </option>
                        ))}
                      </select>
                    </td>

                    <td className="py-3 px-3 font-mono text-[11px] text-slate-400 tabular-nums">
                      <div>Last: {lead.lastContactedAt ? lead.lastContactedAt.slice(0, 10) : '—'}</div>
                      <div className="text-amber-400/90">
                        Next: {lead.nextFollowUpAt ? lead.nextFollowUpAt.slice(0, 10) : '—'}
                      </div>
                    </td>

                    <td className="py-3 px-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDetailLeadId(lead.id)}
                          aria-label={`Inspect ${lead.businessName}`}
                          title="Inspect Lead & Score Breakdown"
                          className="rounded p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectLeadForResearch(lead)}
                          aria-label={`AI Research for ${lead.businessName}`}
                          title="Run Gemini Business Research"
                          className="rounded p-1.5 text-violet-400 hover:bg-slate-800"
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={lead.status === 'opted_out'}
                          onClick={() => onSelectLeadForDm(lead)}
                          aria-label={`Draft DM for ${lead.businessName}`}
                          title="Generate Personalized Outreach DM"
                          className="rounded p-1.5 text-blue-400 hover:bg-slate-800 disabled:opacity-30"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditModal(lead)}
                          aria-label={`Edit ${lead.businessName}`}
                          title="Edit Lead"
                          className="rounded p-1.5 text-slate-300 hover:bg-slate-800 hover:text-white"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteLead(lead.id)}
                          aria-label={`Delete ${lead.businessName}`}
                          title="Delete Lead"
                          className="rounded p-1.5 text-red-400 hover:bg-slate-800"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <div className="flex items-center justify-between border-t border-slate-800/80 px-5 py-3 text-xs text-slate-400">
          <span>
            Showing page <strong className="font-mono text-white">{safePage}</strong> of{' '}
            <strong className="font-mono text-white">{totalPages}</strong> ({filteredLeads.length} total leads)
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </section>

      {/* Lead Detail Drawer (Score Breakdown, Follow-Up Scheduler & Activity Timeline) */}
      {detailLead && (
        <section
          aria-label="Lead Detail Inspector"
          className="rounded-xl border border-blue-500/40 bg-[#111827] p-5 space-y-5"
        >
          <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
            <div>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span>Lead Detail Inspector</span>
                <span aria-hidden="true">·</span>
                <span>{detailLead.category}</span>
                <span aria-hidden="true">·</span>
                <span>{detailLead.city}</span>
              </div>
              <h3 className="text-lg font-semibold text-white mt-0.5">
                {detailLead.businessName}
              </h3>
              <p className="text-xs text-slate-400 mt-1">{detailLead.address}</p>
            </div>

            <button
              type="button"
              onClick={() => setDetailLeadId(null)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
            >
              <X className="h-3.5 w-3.5" />
              Close Inspector
            </button>
          </div>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Column 1: Transparent Lead Score Breakdown */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-white">
                Scoring Breakdown ({calculateLeadScore(detailLead).totalScore}/100)
              </h4>
              <div className="space-y-2">
                {calculateLeadScore(detailLead).reasons.map((r) => (
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
                        className={`font-mono ${
                          r.met ? 'text-emerald-400' : 'text-slate-500'
                        }`}
                      >
                        {r.met ? `+${r.points}` : '0'} pts
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-0.5">{r.explanation}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Column 2: Schedule Follow-Up & Notes */}
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-2 text-xs">
                <div className="font-semibold text-white">Research Notes</div>
                <p className="text-slate-300 leading-relaxed">
                  {detailLead.notes || 'No research notes recorded yet.'}
                </p>
                {detailLead.googleMapsUrl && (
                  <a
                    href={detailLead.googleMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-400 hover:underline pt-1"
                  >
                    Open on Google Maps <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>

              <form onSubmit={handleScheduleFupSubmit} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-3 text-xs">
                <div className="flex items-center gap-1.5 font-semibold text-white">
                  <Calendar className="h-3.5 w-3.5 text-blue-400" />
                  Schedule Next Follow-Up
                </div>
                <div>
                  <label htmlFor="fup-date" className="block text-[11px] text-slate-400 mb-1">
                    Follow-Up Date *
                  </label>
                  <input
                    id="fup-date"
                    type="date"
                    value={fupDate}
                    onChange={(e) => setFupDate(e.target.value)}
                    className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-white"
                  />
                </div>
                <div>
                  <label htmlFor="fup-notes" className="block text-[11px] text-slate-400 mb-1">
                    Reminder Note
                  </label>
                  <input
                    id="fup-notes"
                    type="text"
                    value={fupNotes}
                    onChange={(e) => setFupNotes(e.target.value)}
                    placeholder="e.g., Share updated homepage prototype"
                    className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-white"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full rounded-lg bg-blue-600 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                >
                  Save Follow-Up Reminder
                </button>
              </form>
            </div>

            {/* Column 3: Activity Timeline */}
            <div className="space-y-3">
              <h4 className="text-xs font-semibold text-white">Activity & Outreach Timeline</h4>
              <div className="space-y-2.5">
                {activities.filter((a) => a.leadId === detailLead.id).length === 0 ? (
                  <p className="text-xs text-slate-400">
                    Lead created on {detailLead.createdAt.slice(0, 10)}.
                  </p>
                ) : (
                  activities
                    .filter((a) => a.leadId === detailLead.id)
                    .map((act) => (
                      <div
                        key={act.id}
                        className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between text-[11px] text-slate-400">
                          <span className="font-mono uppercase text-blue-400">
                            {act.activityType}
                          </span>
                          <span className="font-mono tabular-nums">
                            {act.createdAt.slice(0, 10)}
                          </span>
                        </div>
                        <p className="text-slate-200">{act.description}</p>
                      </div>
                    ))
                )}

                {followups
                  .filter((f) => f.leadId === detailLead.id)
                  .map((f) => (
                    <div
                      key={f.id}
                      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs space-y-1"
                    >
                      <div className="flex items-center justify-between text-[11px] text-amber-300">
                        <span>Follow-Up ({f.status})</span>
                        <span className="font-mono">{f.scheduledAt.slice(0, 10)}</span>
                      </div>
                      <p className="text-slate-200">{f.notes}</p>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Add / Edit Lead Modal */}
      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="crm-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
        >
          <div className="w-full max-w-2xl rounded-xl border border-slate-800 bg-[#111827] p-6 shadow-2xl max-h-[90vh] overflow-y-auto space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 id="crm-modal-title" className="text-base font-semibold text-white">
                {editingId ? 'Edit CRM Lead' : 'Add New Lead to CRM'}
              </h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleModalSubmit} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="modal-bname" className="block font-medium text-slate-300 mb-1">
                    Business Name *
                  </label>
                  <input
                    id="modal-bname"
                    type="text"
                    required
                    value={formState.businessName}
                    onChange={(e) => setFormState({ ...formState, businessName: e.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  />
                </div>

                <div>
                  <label htmlFor="modal-category" className="block font-medium text-slate-300 mb-1">
                    Category
                  </label>
                  <select
                    id="modal-category"
                    value={formState.category}
                    onChange={(e) => setFormState({ ...formState, category: e.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  >
                    {BUSINESS_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label htmlFor="modal-city" className="block font-medium text-slate-300 mb-1">
                    City
                  </label>
                  <input
                    id="modal-city"
                    type="text"
                    value={formState.city}
                    onChange={(e) => setFormState({ ...formState, city: e.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label htmlFor="modal-phone" className="block font-medium text-slate-300 mb-1">
                    Phone
                  </label>
                  <input
                    id="modal-phone"
                    type="text"
                    value={formState.phone}
                    onChange={(e) => setFormState({ ...formState, phone: e.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label htmlFor="modal-status" className="block font-medium text-slate-300 mb-1">
                    Pipeline Status
                  </label>
                  <select
                    id="modal-status"
                    value={formState.status}
                    onChange={(e) =>
                      setFormState({ ...formState, status: e.target.value as LeadStatus })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  >
                    {(Object.keys(LEAD_STATUS_LABELS) as LeadStatus[]).map((st) => (
                      <option key={st} value={st}>
                        {LEAD_STATUS_LABELS[st]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="modal-web-url" className="block font-medium text-slate-300 mb-1">
                    Website URL
                  </label>
                  <input
                    id="modal-web-url"
                    type="text"
                    value={formState.websiteUrl}
                    onChange={(e) => setFormState({ ...formState, websiteUrl: e.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  />
                </div>

                <div>
                  <label htmlFor="modal-web-status" className="block font-medium text-slate-300 mb-1">
                    Website Verification Status
                  </label>
                  <select
                    id="modal-web-status"
                    value={formState.websiteStatus}
                    onChange={(e) =>
                      setFormState({
                        ...formState,
                        websiteStatus: e.target.value as WebsiteStatus,
                      })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  >
                    <option value="missing_verified">Verified Missing Website (+30 pts)</option>
                    <option value="outdated_verified">Verified Outdated Website (+20 pts)</option>
                    <option value="unverified">Unverified (0 pts)</option>
                    <option value="modern_verified">Modern Website (0 pts)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="modal-ig" className="block font-medium text-slate-300 mb-1">
                    Instagram URL
                  </label>
                  <input
                    id="modal-ig"
                    type="text"
                    value={formState.instagramUrl}
                    onChange={(e) => setFormState({ ...formState, instagramUrl: e.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label htmlFor="modal-fb" className="block font-medium text-slate-300 mb-1">
                    Facebook Page URL
                  </label>
                  <input
                    id="modal-fb"
                    type="text"
                    value={formState.facebookUrl}
                    onChange={(e) => setFormState({ ...formState, facebookUrl: e.target.value })}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <div>
                  <label htmlFor="modal-rating" className="block font-medium text-slate-300 mb-1">
                    Rating (0–5)
                  </label>
                  <input
                    id="modal-rating"
                    type="number"
                    step="0.1"
                    min={0}
                    max={5}
                    value={formState.rating}
                    onChange={(e) =>
                      setFormState({ ...formState, rating: Number(e.target.value) })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-white"
                  />
                </div>
                <div>
                  <label htmlFor="modal-reviews" className="block font-medium text-slate-300 mb-1">
                    Reviews Count
                  </label>
                  <input
                    id="modal-reviews"
                    type="number"
                    min={0}
                    value={formState.reviewCount}
                    onChange={(e) =>
                      setFormState({ ...formState, reviewCount: Number(e.target.value) })
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-white"
                  />
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formState.missingBookingVerified}
                      onChange={(e) =>
                        setFormState({
                          ...formState,
                          missingBookingVerified: e.target.checked,
                          hasOnlineBooking: e.target.checked ? false : formState.hasOnlineBooking,
                        })
                      }
                      className="rounded border-slate-700 bg-slate-900 text-blue-600"
                    />
                    <span>Missing Online Booking (+15)</span>
                  </label>
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formState.isPremiumService}
                      onChange={(e) =>
                        setFormState({
                          ...formState,
                          isPremiumService: e.target.checked,
                        })
                      }
                      className="rounded border-slate-700 bg-slate-900 text-blue-600"
                    />
                    <span>Premium Services (+10)</span>
                  </label>
                </div>
              </div>

              <div>
                <label htmlFor="modal-notes" className="block font-medium text-slate-300 mb-1">
                  Research Notes
                </label>
                <textarea
                  id="modal-notes"
                  rows={2}
                  value={formState.notes}
                  onChange={(e) => setFormState({ ...formState, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"
                />
              </div>

              {/* Live Recalculated Lead Score & Individual Scoring Reasons */}
              <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white">
                    Live Weighted Lead Score: {modalLiveBreakdown.totalScore}/100 ({modalLiveBreakdown.priority})
                  </span>
                  <span className="font-mono text-[11px] text-emerald-400">
                    {modalLiveBreakdown.reasons.filter((r) => r.met).length}/7 verified factors met
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {modalLiveBreakdown.reasons.map((r) => (
                    <span
                      key={r.key}
                      title={r.explanation}
                      className={`rounded border px-2 py-0.5 text-[11px] ${
                        r.met
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-slate-800 bg-slate-950 text-slate-500'
                      }`}
                    >
                      {r.label}: {r.met ? `+${r.points}` : '0'}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
                >
                  {editingId ? 'Save Changes' : 'Create Lead'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
