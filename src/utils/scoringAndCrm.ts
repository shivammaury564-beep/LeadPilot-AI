import {
  AIResearchSummary,
  LeadRecord,
  LeadScoreBreakdown,
  LeadStatus,
  MessageRecord,
  MessageStatus,
  ScoreReason,
  WebsiteStatus,
} from '../types/leadpilot';

export const PREMIUM_CATEGORIES = new Set([
  'premium salons',
  'beauty studios',
  'makeup artists',
  'dental clinics',
  'hotels',
  'spas',
  'real estate agencies',
]);

export function isPremiumCategory(category?: string): boolean {
  return PREMIUM_CATEGORIES.has((category || '').trim().toLowerCase());
}

export const VERIFIED_PREMIUM_KEYWORDS =
  /\b(luxury|luxe|atelier|aesthetic|aesthetics|bridal|implant|orthodontic|cosmetic|dermat|wellness|boutique|resort|couture|laser|medspa|medi\s*spa|signature)\b/i;

export function hasVerifiedPremiumService(lead: Partial<LeadRecord>): boolean {
  const websiteStatus: WebsiteStatus = lead.websiteStatus || 'unverified';
  const explicitlyUnverified =
    lead.verificationStatus === 'unverified' ||
    lead.verificationStatus === 'needs_review' ||
    websiteStatus === 'unverified';
  const hasVerifiedSource =
    !explicitlyUnverified || Boolean(lead.googlePlaceId?.trim());

  if (!hasVerifiedSource) return false;
  if (lead.isPremiumService === false) return false;
  if (/\b(premium-verified)\b/i.test(lead.tags || '')) return true;

  const combinedText = `${lead.businessName || ''} ${lead.notes || ''} ${lead.tags || ''}`;
  if (VERIFIED_PREMIUM_KEYWORDS.test(combinedText)) {
    return true;
  }

  // For Google Places leads, do not assume premium services solely from the search category dropdown
  // unless verified via notes, AI research, or explicit premium-verified tag.
  if (lead.source === 'google_places') {
    return Boolean(
      lead.isPremiumService === true &&
        (Boolean(lead.notes?.trim()) || Boolean(lead.aiResearchJson?.trim()))
    );
  }

  return !explicitlyUnverified && lead.isPremiumService === true;
}

export function hasVerifiedMissingOnlineBooking(
  lead: Partial<LeadRecord>,
  isWebsiteVerified: boolean
): boolean {
  if (!isWebsiteVerified) return false;
  if (lead.hasOnlineBooking !== false) return false;

  if (/\b(no-booking|booking-verified)\b/i.test(lead.tags || '')) {
    return true;
  }

  // Google Places API does not report whether a business uses Instagram/WhatsApp/third-party booking
  // unless the user or AI research has verified the profile.
  if (lead.source === 'google_places') {
    return (
      Boolean(lead.instagramUrl?.trim()) ||
      Boolean(lead.facebookUrl?.trim()) ||
      Boolean(lead.aiResearchJson?.trim()) ||
      Boolean(lead.notes?.trim())
    );
  }

  return true;
}

/**
 * Realistic Weighted Lead Scoring Engine (Max 100 points)
 * - Verified missing website: +30 (Verified outdated website: +20)
 * - Missing online booking: +15 (only when verified)
 * - Rating 4.5+: +10
 * - Reviews 50+: +10
 * - Premium services: +10 (only when verified)
 * - Active business profile: +5
 * - Verified contact information: +10
 * Never awards points for unverified information.
 */
export function calculateLeadScore(lead: Partial<LeadRecord>): LeadScoreBreakdown {
  const websiteStatus: WebsiteStatus = lead.websiteStatus || 'unverified';
  const hasWebsiteUrl = Boolean((lead.websiteUrl || '').trim());
  const explicitlyUnverified =
    lead.verificationStatus === 'unverified' ||
    lead.verificationStatus === 'needs_review' ||
    websiteStatus === 'unverified';
  const isVerified =
    !explicitlyUnverified &&
    (lead.verificationStatus === 'verified' ||
      websiteStatus === 'missing_verified' ||
      websiteStatus === 'outdated_verified' ||
      websiteStatus === 'modern_verified');
  const hasVerifiedPublicSource =
    isVerified ||
    Boolean(lead.googlePlaceId?.trim()) ||
    Boolean(lead.googleMapsUrl?.trim()) ||
    Boolean(lead.instagramUrl?.trim()) ||
    Boolean(lead.facebookUrl?.trim());

  const reasons: ScoreReason[] = [];

  // 1. Verified missing website (+30) or Verified outdated website (+20)
  if (isVerified && websiteStatus === 'missing_verified' && !hasWebsiteUrl) {
    reasons.push({
      key: 'website_status',
      label: 'Verified missing website',
      points: 30,
      maxPoints: 30,
      met: true,
      explanation: 'Verified business has no official website (+30 pts).',
    });
  } else if (isVerified && websiteStatus === 'outdated_verified') {
    reasons.push({
      key: 'website_status',
      label: 'Verified outdated website',
      points: 20,
      maxPoints: 30,
      met: true,
      explanation: 'Verified existing website is outdated or non-responsive (+20 pts).',
    });
  } else if (!isVerified) {
    reasons.push({
      key: 'website_status',
      label: 'Verified missing website',
      points: 0,
      maxPoints: 30,
      met: false,
      explanation:
        'Website status is unverified; 0 pts awarded for unverified information.',
    });
  } else {
    reasons.push({
      key: 'website_status',
      label: 'Verified missing website',
      points: 0,
      maxPoints: 30,
      met: false,
      explanation: 'Business already operates an active official website (0 pts).',
    });
  }

  // 2. Missing online booking (+15) — only awarded when booking absence is verified!
  const missingBookingVerified = hasVerifiedMissingOnlineBooking(lead, isVerified);
  reasons.push({
    key: 'online_booking',
    label: 'Missing online booking',
    points: missingBookingVerified ? 15 : 0,
    maxPoints: 15,
    met: missingBookingVerified,
    explanation: missingBookingVerified
      ? 'Verified absence of online appointment or reservation booking (+15 pts).'
      : lead.hasOnlineBooking === true
      ? 'Business already offers online booking (0 pts).'
      : 'Online booking status is unverified (0 pts until verified).',
  });

  // 3. Rating 4.5+ (+10)
  const rating = typeof lead.rating === 'number' && Number.isFinite(lead.rating) ? lead.rating : 0;
  const highRating = hasVerifiedPublicSource && rating >= 4.5 && rating <= 5.0;
  reasons.push({
    key: 'rating_threshold',
    label: 'Rating 4.5+',
    points: highRating ? 10 : 0,
    maxPoints: 10,
    met: highRating,
    explanation: highRating
      ? `Verified public rating of ${rating.toFixed(1)}★ meets 4.5+ threshold (+10 pts).`
      : !hasVerifiedPublicSource
      ? 'Rating is unverified (0 pts).'
      : rating > 0
      ? `Public rating is ${rating.toFixed(1)}★ (requires 4.5★+ for +10 pts) (0 pts).`
      : 'No verified public rating recorded (0 pts).',
  });

  // 4. Reviews 50+ (+10)
  const reviewCount =
    typeof lead.reviewCount === 'number' && Number.isFinite(lead.reviewCount)
      ? Math.max(0, Math.floor(lead.reviewCount))
      : 0;
  const highReviews = hasVerifiedPublicSource && reviewCount >= 50;
  reasons.push({
    key: 'review_volume',
    label: 'Reviews 50+',
    points: highReviews ? 10 : 0,
    maxPoints: 10,
    met: highReviews,
    explanation: highReviews
      ? `Verified review volume of ${reviewCount.toLocaleString()} reviews meets 50+ threshold (+10 pts).`
      : !hasVerifiedPublicSource
      ? 'Review count is unverified (0 pts).'
      : `Currently has ${reviewCount.toLocaleString()} public reviews (requires 50+ for +10 pts) (0 pts).`,
  });

  // 5. Premium services (+10) — only awarded when premium service positioning is verified
  const isPremium = hasVerifiedPremiumService(lead);
  reasons.push({
    key: 'premium_services',
    label: 'Premium services',
    points: isPremium ? 10 : 0,
    maxPoints: 10,
    met: isPremium,
    explanation: isPremium
      ? `Verified high-value / premium service offering (${lead.category || 'Specialist'}) (+10 pts).`
      : 'Premium service positioning is unverified (0 pts).',
  });

  // 6. Active business profile (+5)
  const activeProfile = lead.hasActivePublicProfile !== false && hasVerifiedPublicSource;
  reasons.push({
    key: 'active_profile',
    label: 'Active business profile',
    points: activeProfile ? 5 : 0,
    maxPoints: 5,
    met: activeProfile,
    explanation: activeProfile
      ? 'Verified active public business profile on Google Maps or social platforms (+5 pts).'
      : 'No verified active public profile linked (0 pts).',
  });

  // 7. Verified contact information (+10)
  const hasVerifiedPhone = normalizePhoneDigits(lead.phone).length >= 10;
  const hasVerifiedIg = Boolean(normalizeSocialOrWebUrl(lead.instagramUrl, 'instagram'));
  const hasVerifiedFb = Boolean(normalizeSocialOrWebUrl(lead.facebookUrl, 'facebook'));
  const hasVerifiedContact =
    hasVerifiedPublicSource && (hasVerifiedPhone || hasVerifiedIg || hasVerifiedFb);
  const contactChannels = [
    hasVerifiedPhone ? 'Phone' : '',
    hasVerifiedIg ? 'Instagram' : '',
    hasVerifiedFb ? 'Facebook' : '',
  ].filter(Boolean);

  reasons.push({
    key: 'verified_contact',
    label: 'Verified contact information',
    points: hasVerifiedContact ? 10 : 0,
    maxPoints: 10,
    met: hasVerifiedContact,
    explanation: hasVerifiedContact
      ? `Verified direct contact information (${contactChannels.join(', ')}) (+10 pts).`
      : !hasVerifiedPublicSource
      ? 'Contact information not yet verified (0 pts).'
      : 'No verified phone number or social contact channel on record (0 pts).',
  });

  const rawTotal = reasons.reduce((sum, r) => sum + r.points, 0);
  const totalScore = Math.min(100, Math.max(0, rawTotal));

  let priority: LeadScoreBreakdown['priority'] = 'Low Priority';
  if (totalScore >= 75) {
    priority = 'High Priority';
  } else if (totalScore >= 55) {
    priority = 'Medium Priority';
  }

  return {
    totalScore,
    priority,
    reasons,
  };
}

export function recalculateLeadRecord(lead: LeadRecord): LeadRecord {
  const { totalScore } = calculateLeadScore(lead);
  return {
    ...lead,
    leadScore: totalScore,
  };
}

/**
 * Normalizes social URLs, handles, websites, phone numbers, and text for accurate deduplication.
 */
export function normalizeSocialOrWebUrl(raw?: string, platform?: 'instagram' | 'facebook' | 'web'): string {
  const trimmed = (raw || '').trim().toLowerCase();
  if (!trimmed) return '';

  if (platform === 'instagram') {
    const withoutAt = trimmed.replace(/^@/, '');
    const cleaned = withoutAt
      .replace(/^https?:\/\//, '')
      .replace(/^(?:www\.|m\.)/, '')
      .split('?')[0]
      .split('#')[0]
      .replace(/\/+$/, '');
    const slug = cleaned.replace(/^(?:instagram\.com|instagr\.am)\//, '');
    const handle = slug.split('/')[0];
    if (handle && !['p', 'reel', 'explore', 'stories'].includes(handle)) {
      return `instagram.com/${handle}`;
    }
    return '';
  }

  if (platform === 'facebook') {
    const withoutAt = trimmed.replace(/^@/, '');
    const cleaned = withoutAt
      .replace(/^https?:\/\//, '')
      .replace(/^(?:www\.|m\.|web\.)/, '')
      .split('?')[0]
      .split('#')[0]
      .replace(/\/+$/, '');
    if (cleaned.startsWith('facebook.com/') || cleaned.startsWith('fb.com/')) {
      const slug = cleaned.replace(/^(?:facebook\.com|fb\.com)\//, '');
      return slug ? `facebook.com/${slug}` : '';
    }
    return cleaned ? `facebook.com/${cleaned}` : '';
  }

  return trimmed
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/+$/, '');
}

export function normalizePhoneDigits(phone?: string): string {
  const digits = (phone || '').replace(/\D+/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

export function normalizeTextToken(value?: string): string {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeGooglePlaceId(raw?: string): string {
  return (raw || '').trim().replace(/^places\//i, '');
}

/**
 * Duplicate Detection across Place ID, Instagram handle/URL, Facebook Page URL,
 * Website URL, Phone Number, or normalized (businessName + city).
 */
export function detectDuplicateLead(
  candidate: Partial<LeadRecord>,
  existingLeads: LeadRecord[],
  ignoreId?: string
): { isDuplicate: boolean; matchedLead?: LeadRecord; reason?: string } {
  const candPlaceId = normalizeGooglePlaceId(candidate.googlePlaceId);
  const candIg = normalizeSocialOrWebUrl(candidate.instagramUrl, 'instagram');
  const candFb = normalizeSocialOrWebUrl(candidate.facebookUrl, 'facebook');
  const candWeb = normalizeSocialOrWebUrl(candidate.websiteUrl, 'web');
  const candPhone = normalizePhoneDigits(candidate.phone);
  const candName = normalizeTextToken(candidate.businessName);
  const candCity = normalizeTextToken(candidate.city);

  for (const existing of existingLeads) {
    if (ignoreId && existing.id === ignoreId) continue;

    if (
      candPlaceId &&
      existing.googlePlaceId &&
      candPlaceId === normalizeGooglePlaceId(existing.googlePlaceId)
    ) {
      return {
        isDuplicate: true,
        matchedLead: existing,
        reason: `Duplicate Google Place ID (${candPlaceId}) matches "${existing.businessName}".`,
      };
    }

    if (candIg && existing.instagramUrl && candIg === normalizeSocialOrWebUrl(existing.instagramUrl, 'instagram')) {
      return {
        isDuplicate: true,
        matchedLead: existing,
        reason: `Duplicate Instagram profile matches "${existing.businessName}".`,
      };
    }

    if (candFb && existing.facebookUrl && candFb === normalizeSocialOrWebUrl(existing.facebookUrl, 'facebook')) {
      return {
        isDuplicate: true,
        matchedLead: existing,
        reason: `Duplicate Facebook Page URL matches "${existing.businessName}".`,
      };
    }

    if (candWeb && existing.websiteUrl && candWeb === normalizeSocialOrWebUrl(existing.websiteUrl, 'web')) {
      return {
        isDuplicate: true,
        matchedLead: existing,
        reason: `Duplicate Website URL matches "${existing.businessName}".`,
      };
    }

    if (candPhone && existing.phone && candPhone === normalizePhoneDigits(existing.phone)) {
      return {
        isDuplicate: true,
        matchedLead: existing,
        reason: `Duplicate phone number matches "${existing.businessName}".`,
      };
    }

    if (
      candName &&
      candName === normalizeTextToken(existing.businessName) &&
      candCity === normalizeTextToken(existing.city)
    ) {
      return {
        isDuplicate: true,
        matchedLead: existing,
        reason: `A lead named "${existing.businessName}" in ${existing.city || 'the same city'} already exists.`,
      };
    }
  }

  return { isDuplicate: false };
}

/**
 * Enforces the strict compliance rule:
 * "Never allow opted-out leads to re-enter outreach queues."
 */
export function canTransitionLeadStatus(
  currentStatus: LeadStatus,
  nextStatus: LeadStatus
): { allowed: boolean; error?: string } {
  if (currentStatus === 'opted_out' && nextStatus !== 'opted_out') {
    return {
      allowed: false,
      error:
        'Compliance Lock: Opted-out leads can never re-enter outreach queues or transition back to active statuses.',
    };
  }
  return { allowed: true };
}

/**
 * Verifies whether a lead is eligible to enter outreach workflows (DM generation, draft, approve, send).
 */
export function canLeadEnterOutreach(
  leadOrStatus: LeadStatus | Partial<LeadRecord>,
  requestedMessageStatus?: MessageStatus
): { allowed: boolean; error?: string } {
  const leadStatus =
    typeof leadOrStatus === 'string' ? leadOrStatus : leadOrStatus?.status || 'new';
  if (leadStatus === 'opted_out' && requestedMessageStatus !== 'opted_out') {
    return {
      allowed: false,
      error:
        'Compliance Lock: Opted-out leads cannot enter outreach workflows, have messages drafted, or be contacted.',
    };
  }
  return { allowed: true };
}

/**
 * Validates and normalizes structured JSON returned by Gemini AI Business Research.
 */
export function validateAiResearchJson(rawText: string): AIResearchSummary {
  const cleaned = (rawText || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (!cleaned) {
    throw new Error('Gemini returned an empty response for AI business research.');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Gemini returned malformed JSON for AI business research.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI business research output must be a JSON object.');
  }

  const requireString = (val: unknown, fieldName: string): string => {
    if (typeof val !== 'string' || !val.trim()) {
      throw new Error(`Invalid or missing string field "${fieldName}" in AI research response.`);
    }
    return val.trim().slice(0, 2000);
  };

  const requireStringArray = (val: unknown, fieldName: string): string[] => {
    if (!Array.isArray(val)) {
      throw new Error(`Field "${fieldName}" in AI research response must be an array of strings.`);
    }
    const items = val
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((s) => s.trim().slice(0, 500));
    if (items.length === 0) {
      throw new Error(`Field "${fieldName}" in AI research response must contain at least one item.`);
    }
    return items.slice(0, 12);
  };

  if (
    !parsed.onlinePresenceAssessment ||
    typeof parsed.onlinePresenceAssessment !== 'object'
  ) {
    throw new Error('Missing "onlinePresenceAssessment" object in AI research response.');
  }

  return {
    businessOverview: requireString(parsed.businessOverview, 'businessOverview'),
    targetCustomers: requireStringArray(parsed.targetCustomers, 'targetCustomers'),
    mainServices: requireStringArray(parsed.mainServices, 'mainServices'),
    brandPositioning: requireString(parsed.brandPositioning, 'brandPositioning'),
    onlinePresenceAssessment: {
      verifiedFacts: requireStringArray(
        parsed.onlinePresenceAssessment.verifiedFacts,
        'onlinePresenceAssessment.verifiedFacts'
      ),
      unverifiedAreas: requireStringArray(
        parsed.onlinePresenceAssessment.unverifiedAreas,
        'onlinePresenceAssessment.unverifiedAreas'
      ),
    },
    websiteOpportunities: requireStringArray(parsed.websiteOpportunities, 'websiteOpportunities'),
    suggestedWebsiteSections: requireStringArray(
      parsed.suggestedWebsiteSections,
      'suggestedWebsiteSections'
    ),
    suggestedBookingFeatures: requireStringArray(
      parsed.suggestedBookingFeatures,
      'suggestedBookingFeatures'
    ),
    personalizedOutreachAngle: requireString(
      parsed.personalizedOutreachAngle,
      'personalizedOutreachAngle'
    ),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Validates and normalizes structured JSON returned by Gemini AI DM Generator.
 */
export function validateAiDmVariationsJson(rawText: string): string[] {
  const cleaned = (rawText || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (!cleaned) {
    throw new Error('Gemini returned an empty response for DM variations.');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('Gemini returned malformed JSON for DM variations.');
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.variations)) {
    throw new Error('DM generator response must contain a "variations" string array.');
  }

  const validVariations = parsed.variations
    .filter((v: unknown): v is string => typeof v === 'string' && v.trim().length >= 10)
    .map((v: string) => v.trim().slice(0, 2000));

  if (validVariations.length === 0) {
    throw new Error('DM generator response did not contain any valid message variations.');
  }

  return validVariations.slice(0, 3);
}

export type WebsiteFilterOption = 'missing_verified' | 'has_website' | 'unverified' | 'all';

const CATEGORY_QUERY_EXPANSIONS: Record<string, string[]> = {
  'premium salons': [
    'Premium salons',
    'Unisex hair and beauty salon',
    'Luxury beauty parlour',
    'Hair styling and skin studio',
    'Boutique hair lounge',
  ],
  'beauty studios': [
    'Beauty studios',
    'Skin and aesthetics studio',
    'Lash nail and brow studio',
    'Cosmetology and facial studio',
    'Boutique beauty lounge',
  ],
  'makeup artists': [
    'Makeup artists',
    'Bridal makeup studio',
    'Professional makeup academy and studio',
    'Celebrity and party makeup artist',
  ],
  'dental clinics': [
    'Dental clinics',
    'Orthodontic and implant dental care',
    'Cosmetic dentistry clinic',
    'Multi-specialty dental hospital',
    'Family dentist clinic',
  ],
  'fitness coaching centers': [
    'Fitness coaching centers',
    'Personal training gym studio',
    'Crossfit and functional fitness center',
    'Pilates and yoga studio',
  ],
  cafes: [
    'Specialty coffee cafes',
    'Artisan bakery and cafe',
    'Boutique bistro and coffee house',
    'Roastery and dessert cafe',
  ],
  restaurants: [
    'Fine dining restaurants',
    'Casual dining restaurant',
    'Multi-cuisine family restaurant',
    'Specialty kitchen and bistro',
  ],
  hotels: [
    'Boutique hotels',
    'Business hotel and suites',
    'Heritage hotel and resort',
    'Executive residency hotel',
  ],
  spas: [
    'Luxury day spas',
    'Ayurvedic wellness and massage spa',
    'Thai spa and wellness lounge',
    'Hydrotherapy and aromatherapy spa',
  ],
  'real estate agencies': [
    'Real estate agencies',
    'Property consultants and brokers',
    'Luxury residential realtors',
    'Commercial real estate advisory',
  ],
  'interior designers': [
    'Interior designers',
    'Architectural and interior design studio',
    'Luxury home interiors firm',
    'Turnkey modular interior studio',
  ],
  photographers: [
    'Wedding photographers',
    'Commercial and portrait photography studio',
    'Candid wedding cinematography studio',
    'Fashion and product photography studio',
  ],
  'fashion boutiques': [
    'Designer fashion boutiques',
    'Bridal Couture and ethnic wear boutique',
    'Bespoke tailoring and studio',
    'Contemporary womenswear boutique',
  ],
  'pet grooming services': [
    'Pet grooming services',
    'Dog spa and pet styling salon',
    'Veterinary and pet care studio',
    'Luxury pet boarding and grooming',
  ],
  'car detailing studios': [
    'Car detailing studios',
    'Ceramic coating and PPF auto studio',
    'Luxury car wash and detailing lounge',
    'Automotive paint correction studio',
  ],
};

/**
 * Generates multiple distinct search queries across categories and sub-verticals
 * so pagination (max 20/page, up to 60/query) + multi-query execution can discover up to 100 unique leads.
 */
export function buildDiscoveryQueryPlan(params: {
  city: string;
  state?: string;
  country?: string;
  categories?: string[];
  category?: string;
  keyword?: string;
  targetCount?: number;
}): Array<{ query: string; category: string }> {
  const city = (params.city || '').trim();
  const state = (params.state || '').trim();
  const country = (params.country || 'India').trim();
  const keyword = (params.keyword || '').trim();
  const targetCount = Math.min(100, Math.max(1, Number(params.targetCount || 100)));

  const locationParts = [city, state, country].filter(Boolean);
  const locationSuffix = locationParts.length > 0 ? ` in ${locationParts.join(', ')}` : '';

  const rawCategories =
    Array.isArray(params.categories) && params.categories.length > 0
      ? params.categories.map((c) => String(c || '').trim()).filter(Boolean)
      : [String(params.category || 'Premium salons').trim() || 'Premium salons'];

  const uniqueCategories = Array.from(new Set(rawCategories));
  const plan: Array<{ query: string; category: string }> = [];
  const seenQueries = new Set<string>();

  const addQuery = (q: string, cat: string) => {
    const normalized = q.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized || seenQueries.has(normalized)) return;
    seenQueries.add(normalized);
    plan.push({ query: q.trim(), category: cat });
  };

  // 1. If a custom keyword is provided, prioritize it first across selected categories
  if (keyword) {
    for (const cat of uniqueCategories) {
      addQuery(`${keyword} ${cat}${locationSuffix}`, cat);
    }
    addQuery(`${keyword}${locationSuffix}`, uniqueCategories[0]);
  }

  // 2. Interleave primary and expanded sub-vertical queries for each selected category
  const maxExpansionDepth = 5;
  for (let depth = 0; depth < maxExpansionDepth; depth++) {
    for (const cat of uniqueCategories) {
      const expansions = CATEGORY_QUERY_EXPANSIONS[cat.toLowerCase()] || [
        cat,
        `Best ${cat}`,
        `Local ${cat}`,
        `Top rated ${cat}`,
      ];
      if (depth < expansions.length) {
        addQuery(`${expansions[depth]}${locationSuffix}`, cat);
      }
    }
  }

  // Since each query returns up to 20 per page (and up to 60 across pages),
  // cap the number of queries to a reasonable ceiling (e.g., 8 queries max for 100 leads).
  const maxQueriesNeeded = Math.max(2, Math.min(10, Math.ceil(targetCount / 15) + 2));
  return plan.slice(0, maxQueriesNeeded);
}

/**
 * Evaluates whether a lead matches one of the three Website Filter options:
 * A. 'missing_verified' -> No Website – Verified (ONLY verified no-website businesses)
 * B. 'has_website'      -> Has Website (websiteUri present or verified modern/outdated website)
 * C. 'unverified'       -> Unverified – Needs Review
 */
export function matchesWebsiteFilterGroup(
  lead: Partial<LeadRecord>,
  filter: WebsiteFilterOption | string
): boolean {
  if (!filter || filter === 'all') return true;

  const hasUrl = Boolean((lead.websiteUrl || '').trim());
  const status = lead.websiteStatus || 'unverified';
  const verStatus = lead.verificationStatus || 'unverified';

  if (filter === 'missing_verified') {
    return (
      !hasUrl &&
      status === 'missing_verified' &&
      verStatus === 'verified'
    );
  }

  if (filter === 'has_website' || filter === 'modern_verified' || filter === 'outdated_verified') {
    if (filter === 'outdated_verified') return status === 'outdated_verified';
    if (filter === 'modern_verified') return status === 'modern_verified';
    return hasUrl || status === 'modern_verified' || status === 'outdated_verified';
  }

  if (filter === 'unverified') {
    return (
      !hasUrl &&
      (status === 'unverified' || verStatus === 'unverified' || verStatus === 'needs_review')
    );
  }

  return status === filter;
}

/**
 * Independently verifies website status using Place Details (New) `websiteUri` FieldMask
 * and secondary domain/editorial signals before classifying as `No Website – Verified`.
 */
export function verifyPlaceDetailsWebsiteStatus(
  rawPlace: Record<string, any>,
  placeDetails?: Record<string, any> | null,
  independentVerificationConfirmed = false
): {
  websiteUrl: string;
  websiteStatus: WebsiteStatus;
  verificationStatus: 'unverified' | 'verified' | 'needs_review';
} {
  const searchWebsite = typeof rawPlace?.websiteUri === 'string' ? rawPlace.websiteUri.trim() : '';
  const detailsWebsite =
    typeof placeDetails?.websiteUri === 'string' ? placeDetails.websiteUri.trim() : '';

  const resolvedWebsite = detailsWebsite || searchWebsite;
  if (/^https?:\/\/.+/i.test(resolvedWebsite)) {
    return {
      websiteUrl: resolvedWebsite.slice(0, 500),
      websiteStatus: 'modern_verified',
      verificationStatus: 'verified',
    };
  }

  // Check if an explicit URL is mentioned in editorialSummary
  const editorialText =
    typeof placeDetails?.editorialSummary?.text === 'string'
      ? placeDetails.editorialSummary.text
      : '';
  const urlMatch = editorialText.match(/https?:\/\/[^\s)"]+/i);
  if (urlMatch && /^https?:\/\/.+/i.test(urlMatch[0])) {
    return {
      websiteUrl: urlMatch[0].slice(0, 500),
      websiteStatus: 'modern_verified',
      verificationStatus: 'verified',
    };
  }

  // Never assume missing websiteUri in Text Search alone proves no website exists.
  // Require both Place Details response AND independent verification check before marking 'missing_verified'.
  if (placeDetails && independentVerificationConfirmed) {
    const businessStatus = String(
      placeDetails.businessStatus || rawPlace?.businessStatus || 'OPERATIONAL'
    ).toUpperCase();
    if (businessStatus === 'OPERATIONAL') {
      return {
        websiteUrl: '',
        websiteStatus: 'missing_verified',
        verificationStatus: 'verified',
      };
    }
  }

  return {
    websiteUrl: '',
    websiteStatus: 'unverified',
    verificationStatus: 'needs_review',
  };
}

/**
 * Validates and normalizes a raw Google Places API (New) place object into a safe Partial<LeadRecord>.
 */
export function validateAndNormalizePlaceRecord(
  rawPlace: unknown,
  context: {
    city?: string;
    state?: string;
    country?: string;
    category?: string;
    placeDetails?: Record<string, any> | null;
    independentVerificationConfirmed?: boolean;
  }
): (Partial<LeadRecord> & { leadScore: number; scoreBreakdown: LeadScoreBreakdown }) | null {
  if (!rawPlace || typeof rawPlace !== 'object') return null;
  const p = rawPlace as Record<string, any>;
  const details = context.placeDetails || null;

  const placeId = normalizeGooglePlaceId(
    typeof p.id === 'string' ? p.id : typeof details?.id === 'string' ? details.id : ''
  );
  const displayName =
    typeof p.displayName?.text === 'string'
      ? p.displayName.text.trim()
      : typeof details?.displayName?.text === 'string'
      ? details.displayName.text.trim()
      : '';

  if (!placeId || !displayName) {
    return null;
  }

  const { websiteUrl, websiteStatus, verificationStatus } = verifyPlaceDetailsWebsiteStatus(
    p,
    details,
    Boolean(context.independentVerificationConfirmed)
  );

  const rawRating =
    typeof details?.rating === 'number' && Number.isFinite(details.rating)
      ? details.rating
      : typeof p.rating === 'number' && Number.isFinite(p.rating)
      ? p.rating
      : 0;
  const clampedRating = Math.min(5.0, Math.max(0, Number(rawRating.toFixed(2))));

  const rawReviews =
    typeof details?.userRatingCount === 'number' && Number.isFinite(details.userRatingCount)
      ? Math.max(0, Math.floor(details.userRatingCount))
      : typeof p.userRatingCount === 'number' && Number.isFinite(p.userRatingCount)
      ? Math.max(0, Math.floor(p.userRatingCount))
      : 0;

  const resolvedCategory =
    (context.category || '').trim() ||
    (typeof p.primaryTypeDisplayName?.text === 'string'
      ? p.primaryTypeDisplayName.text.trim()
      : 'Business');

  const locSource = details?.location || p.location;
  const lat =
    typeof locSource?.latitude === 'number' &&
    locSource.latitude >= -90 &&
    locSource.latitude <= 90
      ? locSource.latitude
      : undefined;
  const lng =
    typeof locSource?.longitude === 'number' &&
    locSource.longitude >= -180 &&
    locSource.longitude <= 180
      ? locSource.longitude
      : undefined;

  const formattedAddress =
    typeof details?.formattedAddress === 'string' && details.formattedAddress.trim()
      ? details.formattedAddress.trim()
      : typeof p.formattedAddress === 'string'
      ? p.formattedAddress.trim()
      : '';

  const phone =
    (typeof details?.internationalPhoneNumber === 'string' &&
      details.internationalPhoneNumber.trim()) ||
    (typeof details?.nationalPhoneNumber === 'string' && details.nationalPhoneNumber.trim()) ||
    (typeof p.internationalPhoneNumber === 'string' && p.internationalPhoneNumber.trim()) ||
    (typeof p.nationalPhoneNumber === 'string' && p.nationalPhoneNumber.trim()) ||
    '';

  const googleMapsUrl =
    (typeof details?.googleMapsUri === 'string' && details.googleMapsUri.trim()) ||
    (typeof p.googleMapsUri === 'string' ? p.googleMapsUri.trim() : '');

  const editorialSummaryText =
    typeof details?.editorialSummary?.text === 'string'
      ? details.editorialSummary.text.trim()
      : '';
  const verifiedPremiumFromPlace = VERIFIED_PREMIUM_KEYWORDS.test(
    `${displayName} ${editorialSummaryText}`
  );

  const nowIso = new Date().toISOString();
  const draftLead: Partial<LeadRecord> = {
    businessName: displayName.slice(0, 200),
    category: resolvedCategory.slice(0, 100),
    city: (context.city || '').trim().slice(0, 100),
    state: (context.state || '').trim().slice(0, 100),
    country: (context.country || 'India').trim().slice(0, 100),
    address: formattedAddress.slice(0, 400),
    phone: phone.slice(0, 60),
    websiteUrl,
    websiteStatus,
    // Online booking is not reported by Google Places Text/Details; do not award +15 until verified
    hasOnlineBooking: false,
    isPremiumService: verifiedPremiumFromPlace,
    hasActivePublicProfile: true,
    googlePlaceId: placeId.slice(0, 200),
    googleMapsUrl: googleMapsUrl.slice(0, 600),
    rating: clampedRating,
    reviewCount: rawReviews,
    source: 'google_places',
    verificationStatus,
    lastVerifiedAt: nowIso,
    createdAt: nowIso,
    lat,
    lng,
  };

  const scoreBreakdown = calculateLeadScore(draftLead);
  return {
    ...draftLead,
    leadScore: scoreBreakdown.totalScore,
    scoreBreakdown,
  };
}

/**
 * Escapes a single CSV cell safely, protecting against formula injection and preserving quotes/newlines.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let str = String(value);
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Exports permitted LeadRecords to RFC-4180 UTF-8 CSV without any internal secrets or opted-out leads.
 */
export function generateCsvContent(leads: LeadRecord[]): string {
  const permittedLeads = leads.filter((lead) => lead.status !== 'opted_out');
  const headers = [
    'Business Name',
    'Category',
    'City',
    'State',
    'Country',
    'Phone',
    'Website URL',
    'Website Verification Status',
    'Instagram URL',
    'Facebook URL',
    'Google Place ID',
    'Google Maps URL',
    'Rating',
    'Review Count',
    'Lead Score',
    'Priority Tier',
    'Source',
    'Verification Status',
    'Outreach Status',
    'Last Contacted',
    'Next Follow-Up',
    'Tags',
    'Research Notes',
  ];

  const rows = permittedLeads.map((lead) => {
    const { priority } = calculateLeadScore(lead);
    return [
      lead.businessName,
      lead.category,
      lead.city,
      lead.state,
      lead.country,
      lead.phone,
      lead.websiteUrl,
      lead.websiteStatus,
      lead.instagramUrl,
      lead.facebookUrl,
      lead.googlePlaceId,
      lead.googleMapsUrl,
      lead.rating || '',
      lead.reviewCount || 0,
      lead.leadScore,
      priority,
      lead.source,
      lead.verificationStatus,
      lead.status,
      lead.lastContactedAt,
      lead.nextFollowUpAt,
      lead.tags,
      lead.notes,
    ]
      .map(escapeCsvCell)
      .join(',');
  });

  return '\uFEFF' + [headers.map(escapeCsvCell).join(','), ...rows].join('\r\n');
}

export interface DashboardMetrics {
  totalDiscovered: number;
  qualifiedLeads: number;
  leadsWithoutWebsites: number;
  leadsWithOutdatedWebsites: number;
  messagesDrafted: number;
  messagesSent: number;
  interestedProspects: number;
  demosShared: number;
  clientsConverted: number;
  highPriorityCount: number;
  byDay: Array<{ date: string; count: number }>;
  bySource: Array<{ source: string; label: string; count: number }>;
  byOutreachStatus: Array<{ status: string; label: string; count: number }>;
  conversionFunnel: Array<{ stage: string; count: number; percentage: number }>;
}

export function computeDashboardMetrics(
  leads: LeadRecord[],
  messages: MessageRecord[]
): DashboardMetrics {
  const totalDiscovered = leads.length;
  const qualifiedLeads = leads.filter(
    (l) =>
      l.status !== 'opted_out' &&
      (l.leadScore >= 60 ||
        [
          'qualified',
          'draft_ready',
          'approved',
          'contacted',
          'replied',
          'interested',
          'demo_sent',
          'negotiation',
          'converted',
        ].includes(l.status))
  ).length;

  const leadsWithoutWebsites = leads.filter(
    (l) => l.websiteStatus === 'missing_verified'
  ).length;

  const leadsWithOutdatedWebsites = leads.filter(
    (l) => l.websiteStatus === 'outdated_verified'
  ).length;

  const messagesDrafted = messages.length;
  const messagesSent =
    messages.filter((m) => ['sent', 'replied'].includes(m.status)).length ||
    leads.filter((l) =>
      ['contacted', 'replied', 'interested', 'demo_sent', 'negotiation', 'converted'].includes(
        l.status
      )
    ).length;

  const interestedProspects = leads.filter((l) =>
    ['interested', 'demo_sent', 'negotiation', 'converted'].includes(l.status)
  ).length;

  const demosShared = leads.filter((l) =>
    ['demo_sent', 'negotiation', 'converted'].includes(l.status)
  ).length;

  const clientsConverted = leads.filter((l) => l.status === 'converted').length;
  const highPriorityCount = leads.filter(
    (l) => l.status !== 'opted_out' && l.leadScore >= 80
  ).length;

  const dayCounts: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    dayCounts[key] = 0;
  }
  for (const lead of leads) {
    const dayKey = (lead.createdAt || '').slice(0, 10);
    if (dayKey) {
      dayCounts[dayKey] = (dayCounts[dayKey] || 0) + 1;
    }
  }
  const byDay = Object.entries(dayCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-7)
    .map(([date, count]) => ({
      date: date.slice(5),
      count,
    }));

  const sourceLabels: Record<string, string> = {
    google_places: 'Google Places',
    instagram: 'Instagram Research',
    facebook: 'Facebook Pages',
    manual: 'Manual Entry',
    chrome_extension: 'Chrome Extension',
  };
  const sourceCounts: Record<string, number> = {};
  for (const lead of leads) {
    const src = lead.source || 'manual';
    sourceCounts[src] = (sourceCounts[src] || 0) + 1;
  }
  const bySource = Object.entries(sourceLabels).map(([source, label]) => ({
    source,
    label,
    count: sourceCounts[source] || 0,
  }));

  const statusGroups: Array<{ key: LeadStatus; label: string }> = [
    { key: 'new', label: 'New / Researching' },
    { key: 'qualified', label: 'Qualified' },
    { key: 'draft_ready', label: 'Draft / Approved' },
    { key: 'contacted', label: 'Contacted' },
    { key: 'interested', label: 'Interested / Replied' },
    { key: 'demo_sent', label: 'Demo / Negotiation' },
    { key: 'converted', label: 'Converted' },
    { key: 'opted_out', label: 'Opted Out / Closed' },
  ];

  const byOutreachStatus = statusGroups.map((g) => {
    let count = 0;
    if (g.key === 'new') {
      count = leads.filter((l) => ['new', 'researching'].includes(l.status)).length;
    } else if (g.key === 'draft_ready') {
      count = leads.filter((l) => ['draft_ready', 'approved'].includes(l.status)).length;
    } else if (g.key === 'interested') {
      count = leads.filter((l) => ['replied', 'interested'].includes(l.status)).length;
    } else if (g.key === 'demo_sent') {
      count = leads.filter((l) => ['demo_sent', 'negotiation'].includes(l.status)).length;
    } else if (g.key === 'opted_out') {
      count = leads.filter((l) => ['not_interested', 'opted_out'].includes(l.status)).length;
    } else {
      count = leads.filter((l) => l.status === g.key).length;
    }
    return { status: g.key, label: g.label, count };
  });

  const base = Math.max(1, totalDiscovered);
  const contactedStage = leads.filter((l) =>
    ['contacted', 'replied', 'interested', 'demo_sent', 'negotiation', 'converted'].includes(
      l.status
    )
  ).length;

  const conversionFunnel = [
    {
      stage: 'Discovered Leads',
      count: totalDiscovered,
      percentage: totalDiscovered > 0 ? 100 : 0,
    },
    {
      stage: 'Qualified Prospects',
      count: qualifiedLeads,
      percentage: Math.round((qualifiedLeads / base) * 100),
    },
    {
      stage: 'Outreach Sent',
      count: contactedStage,
      percentage: Math.round((contactedStage / base) * 100),
    },
    {
      stage: 'Interested / Replied',
      count: interestedProspects,
      percentage: Math.round((interestedProspects / base) * 100),
    },
    {
      stage: 'Demos Shared',
      count: demosShared,
      percentage: Math.round((demosShared / base) * 100),
    },
    {
      stage: 'Clients Converted',
      count: clientsConverted,
      percentage: Math.round((clientsConverted / base) * 100),
    },
  ];

  return {
    totalDiscovered,
    qualifiedLeads,
    leadsWithoutWebsites,
    leadsWithOutdatedWebsites,
    messagesDrafted,
    messagesSent,
    interestedProspects,
    demosShared,
    clientsConverted,
    highPriorityCount,
    byDay,
    bySource,
    byOutreachStatus,
    conversionFunnel,
  };
}
