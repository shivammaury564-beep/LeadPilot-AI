import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoveryQueryPlan,
  calculateLeadScore,
  canLeadEnterOutreach,
  canTransitionLeadStatus,
  computeDashboardMetrics,
  detectDuplicateLead,
  generateCsvContent,
  matchesWebsiteFilterGroup,
  validateAiDmVariationsJson,
  validateAiResearchJson,
  validateAndNormalizePlaceRecord,
  verifyPlaceDetailsWebsiteStatus,
} from './scoringAndCrm';
import { LeadRecord } from '../types/leadpilot';

const sampleLead: LeadRecord = {
  id: 'lead_101',
  userId: 'user_1',
  businessName: 'Lumiere Aesthetics & Spa',
  category: 'Spas',
  city: 'Mumbai',
  state: 'Maharashtra',
  country: 'India',
  address: 'Bandra West, Mumbai',
  phone: '+91 98201 11223',
  websiteUrl: 'https://www.lumierespa.in/',
  websiteStatus: 'missing_verified',
  hasOnlineBooking: false,
  isPremiumService: true,
  hasActivePublicProfile: true,
  instagramUrl: 'https://instagram.com/lumierebandra',
  facebookUrl: 'https://facebook.com/lumierespa',
  googlePlaceId: 'ChIJ_lumiere_001',
  googleMapsUrl: 'https://maps.google.com/?cid=101',
  rating: 4.7,
  reviewCount: 142,
  leadScore: 90,
  source: 'google_places',
  verificationStatus: 'verified',
  lastVerifiedAt: '2026-11-08T12:00:00.000Z',
  status: 'qualified',
  notes: 'High-end Bandra spa with no website; takes appointments via WhatsApp only.',
  tags: 'high-ticket,bandra,no-website',
  lastContactedAt: '',
  nextFollowUpAt: '',
  aiResearchJson: '',
  createdAt: '2026-11-08T12:00:00.000Z',
  updatedAt: '2026-11-08T12:00:00.000Z',
};

test('Lead scoring awards exact weighted points and returns individual scoring reasons', () => {
  const fullyVerifiedLead: LeadRecord = {
    ...sampleLead,
    websiteUrl: '',
    websiteStatus: 'missing_verified',
  };
  const breakdown = calculateLeadScore(fullyVerifiedLead);
  // 30 (website) + 15 (booking) + 10 (rating 4.5+) + 10 (reviews 50+) + 10 (premium) + 5 (active profile) + 10 (verified contact) = 90
  assert.equal(breakdown.totalScore, 90);
  assert.equal(breakdown.priority, 'High Priority');
  assert.equal(breakdown.reasons.length, 7);

  const byKey = Object.fromEntries(breakdown.reasons.map((r) => [r.key, r.points]));
  assert.equal(byKey.website_status, 30);
  assert.equal(byKey.online_booking, 15);
  assert.equal(byKey.rating_threshold, 10);
  assert.equal(byKey.review_volume, 10);
  assert.equal(byKey.premium_services, 10);
  assert.equal(byKey.active_profile, 5);
  assert.equal(byKey.verified_contact, 10);
});

test('Lead scoring recalculates dynamically whenever lead information changes', () => {
  const baseLead: Partial<LeadRecord> = {
    businessName: 'City Hair Studio',
    category: 'Premium salons',
    source: 'google_places',
    googlePlaceId: 'ChIJ_city_hair_1',
    websiteStatus: 'missing_verified',
    verificationStatus: 'verified',
    hasOnlineBooking: false,
    isPremiumService: false,
    phone: '+91 98200 11223',
    rating: 4.3,
    reviewCount: 28,
  };

  // Initial: +30 (missing website) + 5 (active profile) + 10 (verified phone) = 45
  const score1 = calculateLeadScore(baseLead);
  assert.equal(score1.totalScore, 45);

  // Rating increases to 4.6 (+10) and reviews to 65 (+10) => 65
  const score2 = calculateLeadScore({ ...baseLead, rating: 4.6, reviewCount: 65 });
  assert.equal(score2.totalScore, 65);

  // Verify missing online booking (+15) and premium services (+10) => 90
  const score3 = calculateLeadScore({
    ...baseLead,
    rating: 4.6,
    reviewCount: 65,
    tags: 'booking-verified,premium-verified',
    isPremiumService: true,
  });
  assert.equal(score3.totalScore, 90);

  // Change website status to modern_verified => drops +30 website and +15 booking => 45
  const score4 = calculateLeadScore({
    ...baseLead,
    rating: 4.6,
    reviewCount: 65,
    websiteStatus: 'modern_verified',
    websiteUrl: 'https://cityhairstudio.in',
    hasOnlineBooking: true,
    tags: 'premium-verified',
    isPremiumService: true,
  });
  assert.equal(score4.totalScore, 45);
});

test('Unverified information is NEVER awarded points', () => {
  const unverifiedLead: Partial<LeadRecord> = {
    businessName: 'Unverified Cafe',
    category: 'Restaurants',
    websiteStatus: 'unverified',
    verificationStatus: 'unverified',
    hasOnlineBooking: false,
    isPremiumService: false,
    hasActivePublicProfile: true,
    rating: 4.8,
    reviewCount: 120,
  };
  const breakdown = calculateLeadScore(unverifiedLead);
  assert.equal(breakdown.totalScore, 0);
  assert.equal(breakdown.priority, 'Low Priority');
  for (const reason of breakdown.reasons) {
    assert.equal(reason.points, 0, `Expected 0 points for unverified ${reason.key}`);
  }
});

test('Duplicate detection catches matching Google Place ID, Phone, Website, Instagram @handle/URL, Facebook URL, or Name+City', () => {
  const dupByPlace = detectDuplicateLead(
    { businessName: 'Different Name', googlePlaceId: 'places/ChIJ_lumiere_001' },
    [sampleLead]
  );
  assert.equal(dupByPlace.isDuplicate, true);

  const dupByPhone = detectDuplicateLead(
    { businessName: 'Another Name', phone: '9820111223' },
    [sampleLead]
  );
  assert.equal(dupByPhone.isDuplicate, true);

  const dupByWebsite = detectDuplicateLead(
    { businessName: 'Another Name', websiteUrl: 'http://lumierespa.in' },
    [sampleLead]
  );
  assert.equal(dupByWebsite.isDuplicate, true);

  const dupByIgHandle = detectDuplicateLead(
    { businessName: 'Another Spa', instagramUrl: '@lumierebandra' },
    [sampleLead]
  );
  assert.equal(dupByIgHandle.isDuplicate, true);

  const dupByFbUrl = detectDuplicateLead(
    { businessName: 'Another Spa', facebookUrl: 'https://www.facebook.com/lumierespa/' },
    [sampleLead]
  );
  assert.equal(dupByFbUrl.isDuplicate, true);

  const dupByNameCity = detectDuplicateLead(
    { businessName: 'lumiere aesthetics & spa', city: 'mumbai' },
    [sampleLead]
  );
  assert.equal(dupByNameCity.isDuplicate, true);

  const uniqueLead = detectDuplicateLead(
    { businessName: 'Zenith Dental Clinic', city: 'Pune', googlePlaceId: 'ChIJ_zenith_999' },
    [sampleLead]
  );
  assert.equal(uniqueLead.isDuplicate, false);
});

test('Opt-out guard blocks opted-out leads from re-entering outreach workflows or statuses', () => {
  const blocked = canTransitionLeadStatus('opted_out', 'contacted');
  assert.equal(blocked.allowed, false);

  const outreachBlocked = canLeadEnterOutreach({ status: 'opted_out' });
  assert.equal(outreachBlocked.allowed, false);

  const allowed = canTransitionLeadStatus('qualified', 'draft_ready');
  assert.equal(allowed.allowed, true);
});

test('CSV export properly escapes quotes/commas/formulas and strictly excludes opted_out leads', () => {
  const trickyLead: LeadRecord = {
    ...sampleLead,
    businessName: '=cmd|" /C calc"!A0, "Luxury" Salon',
  };
  const optedOutLead: LeadRecord = {
    ...sampleLead,
    id: 'lead_opted_out',
    businessName: 'Should Never Export Spa',
    status: 'opted_out',
  };
  const csv = generateCsvContent([trickyLead, optedOutLead]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=cmd|"" /C calc""!A0, ""Luxury"" Salon"'));
  assert.ok(!csv.includes('Should Never Export Spa'));
});

test('validateAndNormalizePlaceRecord normalizes Google Places API (New) responses and never assumes missing website', () => {
  const normalized = validateAndNormalizePlaceRecord(
    {
      id: 'places/ChIJ_test_place_99',
      displayName: { text: 'Maison Royale Salon' },
      formattedAddress: 'Linking Road, Bandra West, Mumbai',
      rating: 4.8,
      userRatingCount: 120,
      location: { latitude: 19.06, longitude: 72.83 },
    },
    { city: 'Mumbai', state: 'Maharashtra', country: 'India', category: 'Premium salons' }
  );

  assert.ok(normalized);
  assert.equal(normalized?.googlePlaceId, 'ChIJ_test_place_99');
  assert.equal(normalized?.websiteStatus, 'unverified');
  assert.equal(normalized?.verificationStatus, 'needs_review');
  // +10 rating (4.8), +10 reviews (120), +5 active Google Places profile; 0 for unverified website, booking, premium, contact
  assert.equal(normalized?.leadScore, 25);
});

test('validateAiResearchJson and validateAiDmVariationsJson enforce strict JSON schemas', () => {
  const research = validateAiResearchJson(
    JSON.stringify({
      businessOverview: 'Premier salon in Bandra.',
      brandPositioning: 'Luxury bridal and hair care.',
      targetCustomers: ['Brides', 'Working professionals'],
      mainServices: ['Bridal makeup', 'Balayage'],
      onlinePresenceAssessment: {
        verifiedFacts: ['4.8 rating from 120 reviews'],
        unverifiedAreas: ['Current booking software'],
      },
      websiteOpportunities: ['Launch portfolio website'],
      suggestedWebsiteSections: ['Service menu'],
      suggestedBookingFeatures: ['WhatsApp slot confirmation'],
      personalizedOutreachAngle: 'Highlight bridal lookbook showcase.',
    })
  );
  assert.equal(research.businessOverview, 'Premier salon in Bandra.');
  assert.equal(research.onlinePresenceAssessment.verifiedFacts.length, 1);

  const variations = validateAiDmVariationsJson(
    JSON.stringify({
      variations: [
        'Hi Maison Royale team, loved your Bandra studio reviews!',
        'Hello Maison Royale, noticed your 4.8 rating in Mumbai.',
        'Hi there, we built a custom bridal lookbook concept for Maison Royale.',
      ],
    })
  );
  assert.equal(variations.length, 3);
});

test('Dashboard metrics accurately aggregate live database records', () => {
  const convertedLead: LeadRecord = {
    ...sampleLead,
    id: 'lead_102',
    websiteStatus: 'outdated_verified',
    status: 'converted',
  };
  const metrics = computeDashboardMetrics([sampleLead, convertedLead], []);
  assert.equal(metrics.totalDiscovered, 2);
  assert.equal(metrics.leadsWithoutWebsites, 1);
  assert.equal(metrics.leadsWithOutdatedWebsites, 1);
  assert.equal(metrics.clientsConverted, 1);
});

test('buildDiscoveryQueryPlan generates multiple distinct relevant search queries to reach up to 100 leads', () => {
  const plan = buildDiscoveryQueryPlan({
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'India',
    categories: ['Premium salons', 'Dental clinics'],
    targetCount: 100,
  });

  assert.ok(plan.length >= 4, 'Expected at least 4 distinct queries for 100 lead target');
  const uniqueQueries = new Set(plan.map((p) => p.query.toLowerCase()));
  assert.equal(uniqueQueries.size, plan.length, 'Queries must be deduplicated');
  assert.ok(plan[0].query.includes('Mumbai, Maharashtra, India'));
});

test('Place Details verification and Website Filter strictly distinguish No Website – Verified, Has Website, and Unverified', () => {
  // 1. Missing websiteUri in Text Search WITHOUT Place Details stays unverified
  const unverifiedCheck = verifyPlaceDetailsWebsiteStatus(
    { id: 'ChIJ_1', displayName: { text: 'Bandra Studio' } },
    null,
    false
  );
  assert.equal(unverifiedCheck.websiteStatus, 'unverified');
  assert.equal(unverifiedCheck.verificationStatus, 'needs_review');
  assert.equal(matchesWebsiteFilterGroup(unverifiedCheck, 'missing_verified'), false);
  assert.equal(matchesWebsiteFilterGroup(unverifiedCheck, 'unverified'), true);

  // 2. Missing websiteUri in Text Search WITH Place Details confirmation + independent check is No Website – Verified
  const verifiedNoWeb = validateAndNormalizePlaceRecord(
    {
      id: 'places/ChIJ_no_web_202',
      displayName: { text: 'Aura Bridal Studio' },
      rating: 4.6,
      userRatingCount: 64,
    },
    {
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
      category: 'Makeup artists',
      placeDetails: {
        id: 'ChIJ_no_web_202',
        displayName: { text: 'Aura Bridal Studio' },
        formattedAddress: 'Juhu, Mumbai, Maharashtra',
        internationalPhoneNumber: '+91 98201 99887',
        businessStatus: 'OPERATIONAL',
      },
      independentVerificationConfirmed: true,
    }
  );
  assert.ok(verifiedNoWeb);
  assert.equal(verifiedNoWeb?.websiteStatus, 'missing_verified');
  assert.equal(verifiedNoWeb?.verificationStatus, 'verified');
  // +30 missing website, 0 unverified booking, +10 rating 4.6, +10 reviews 64, +10 Bridal premium keyword, +5 active profile, +10 verified phone = 75
  assert.equal(verifiedNoWeb?.leadScore, 75);
  assert.equal(matchesWebsiteFilterGroup(verifiedNoWeb!, 'missing_verified'), true);
  assert.equal(matchesWebsiteFilterGroup(verifiedNoWeb!, 'has_website'), false);
  assert.equal(matchesWebsiteFilterGroup(verifiedNoWeb!, 'unverified'), false);

  // 3. Present websiteUri in Place Details is classified as Has Website
  const hasWeb = verifyPlaceDetailsWebsiteStatus(
    { id: 'ChIJ_3' },
    { id: 'ChIJ_3', websiteUri: 'https://aurabridal.in', businessStatus: 'OPERATIONAL' },
    true
  );
  assert.equal(hasWeb.websiteStatus, 'modern_verified');
  assert.equal(hasWeb.websiteUrl, 'https://aurabridal.in');
  assert.equal(matchesWebsiteFilterGroup(hasWeb, 'has_website'), true);
  assert.equal(matchesWebsiteFilterGroup(hasWeb, 'missing_verified'), false);
});

