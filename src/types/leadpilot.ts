export type WebsiteStatus =
  | 'missing_verified'
  | 'outdated_verified'
  | 'modern_verified'
  | 'unverified';

export type VerificationStatus = 'verified' | 'unverified' | 'needs_review';

export type LeadSource =
  | 'google_places'
  | 'instagram'
  | 'facebook'
  | 'manual'
  | 'chrome_extension';

export type LeadStatus =
  | 'new'
  | 'researching'
  | 'qualified'
  | 'draft_ready'
  | 'approved'
  | 'contacted'
  | 'replied'
  | 'interested'
  | 'demo_sent'
  | 'negotiation'
  | 'converted'
  | 'not_interested'
  | 'opted_out';

export type OutreachPlatform = 'instagram' | 'facebook' | 'whatsapp' | 'email';

export type MessageStatus = 'draft' | 'approved' | 'sent' | 'replied' | 'opted_out';

export type MessageStyle =
  | 'Friendly'
  | 'Professional'
  | 'Premium'
  | 'Short and natural';

export type MessageLanguage = 'English' | 'Hindi' | 'Hinglish';

export const BUSINESS_CATEGORIES = [
  'Premium salons',
  'Beauty studios',
  'Makeup artists',
  'Dental clinics',
  'Gyms',
  'Restaurants',
  'Hotels',
  'Spas',
  'Real estate agencies',
  'Coaching institutes',
] as const;

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number] | string;

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: 'New',
  researching: 'Researching',
  qualified: 'Qualified',
  draft_ready: 'Draft Ready',
  approved: 'Approved',
  contacted: 'Contacted',
  replied: 'Replied',
  interested: 'Interested',
  demo_sent: 'Demo Sent',
  negotiation: 'Negotiation',
  converted: 'Converted',
  not_interested: 'Not Interested',
  opted_out: 'Opted Out',
};

export interface AIResearchSummary {
  businessOverview: string;
  targetCustomers: string[];
  mainServices: string[];
  brandPositioning: string;
  onlinePresenceAssessment: {
    verifiedFacts: string[];
    unverifiedAreas: string[];
  };
  websiteOpportunities: string[];
  suggestedWebsiteSections: string[];
  suggestedBookingFeatures: string[];
  personalizedOutreachAngle: string;
  generatedAt: string;
}

export interface LeadRecord {
  id: string;
  userId: string;
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
  isPremiumService: boolean;
  hasActivePublicProfile: boolean;
  instagramUrl: string;
  facebookUrl: string;
  googlePlaceId: string;
  googleMapsUrl: string;
  rating: number;
  reviewCount: number;
  leadScore: number;
  source: LeadSource;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string;
  status: LeadStatus;
  notes: string;
  tags: string;
  lastContactedAt: string;
  nextFollowUpAt: string;
  aiResearchJson: string;
  createdAt: string;
  updatedAt: string;
  lat?: number;
  lng?: number;
}

export interface MessageRecord {
  id: string;
  userId: string;
  leadId: string;
  leadBusinessName: string;
  platform: OutreachPlatform;
  messageBody: string;
  language: MessageLanguage;
  tone: MessageStyle;
  status: MessageStatus;
  approvedAt: string;
  sentAt: string;
  replyNotes: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityRecord {
  id: string;
  userId: string;
  leadId: string;
  activityType: string;
  description: string;
  createdAt: string;
}

export interface FollowupRecord {
  id: string;
  userId: string;
  leadId: string;
  leadBusinessName: string;
  scheduledAt: string;
  status: 'pending' | 'completed' | 'cancelled';
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  userId: string;
  fullName: string;
  agencyName: string;
  dailyTarget: number;
  defaultCity: string;
  defaultCategory: string;
  researchPriority: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScoreReason {
  key: string;
  label: string;
  points: number;
  maxPoints: number;
  met: boolean;
  explanation: string;
}

export interface LeadScoreBreakdown {
  totalScore: number;
  priority: 'High Priority' | 'Medium Priority' | 'Low Priority';
  reasons: ScoreReason[];
}
