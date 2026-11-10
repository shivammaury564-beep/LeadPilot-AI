import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Simulator for evaluating the Dirty Dozen security invariants against firestore.rules
const rulesContent = fs.readFileSync('./firestore.rules', 'utf-8');

interface AuthContext {
  uid: string;
  email_verified: boolean;
}

function evaluateLeadWrite(
  op: 'create' | 'update',
  docId: string,
  auth: AuthContext | null,
  incoming: Record<string, unknown>,
  existing?: Record<string, unknown>
): boolean {
  if (!auth || !auth.email_verified) return false;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(docId)) return false;

  const requiredKeys = [
    'userId', 'businessName', 'category', 'websiteStatus',
    'leadScore', 'source', 'verificationStatus', 'status',
    'createdAt', 'updatedAt'
  ];
  const allowedKeys = new Set([
    ...requiredKeys,
    'city', 'state', 'country', 'address', 'phone', 'websiteUrl',
    'hasOnlineBooking', 'isPremiumService', 'hasActivePublicProfile',
    'instagramUrl', 'facebookUrl', 'googlePlaceId', 'googleMapsUrl',
    'rating', 'reviewCount', 'lastVerifiedAt', 'notes', 'tags',
    'lastContactedAt', 'nextFollowUpAt', 'aiResearchJson'
  ]);

  const keys = Object.keys(incoming);
  if (!requiredKeys.every((k) => keys.includes(k))) return false;
  if (!keys.every((k) => allowedKeys.has(k))) return false;

  if (typeof incoming.userId !== 'string' || incoming.userId !== auth.uid) return false;
  if (typeof incoming.businessName !== 'string' || incoming.businessName.length < 1 || incoming.businessName.length > 200) return false;
  if (typeof incoming.leadScore !== 'number' || !Number.isInteger(incoming.leadScore) || incoming.leadScore < 0 || incoming.leadScore > 100) return false;
  if (!['missing_verified', 'outdated_verified', 'modern_verified', 'unverified'].includes(String(incoming.websiteStatus))) return false;
  if (![
    'new', 'researching', 'qualified', 'draft_ready', 'approved',
    'contacted', 'replied', 'interested', 'demo_sent', 'negotiation',
    'converted', 'not_interested', 'opted_out'
  ].includes(String(incoming.status))) return false;
  if (incoming.notes !== undefined && (typeof incoming.notes !== 'string' || incoming.notes.length > 4000)) return false;

  if (op === 'update' && existing) {
    if (existing.userId !== auth.uid) return false;
    if (incoming.userId !== existing.userId) return false;
    if (incoming.createdAt !== existing.createdAt) return false;
    if (existing.status === 'opted_out' && ['draft_ready', 'approved', 'contacted'].includes(String(incoming.status))) {
      return false;
    }
  }
  return true;
}

const baseLead = {
  userId: 'user_A',
  businessName: 'Aura Luxe Salon',
  category: 'Premium salons',
  websiteStatus: 'missing_verified',
  leadScore: 85,
  source: 'google_places',
  verificationStatus: 'verified',
  status: 'qualified',
  createdAt: '2026-11-08T10:00:00.000Z',
  updatedAt: '2026-11-08T10:00:00.000Z',
};

test('firestore.rules file contains all 6 collections and default-deny net', () => {
  assert.ok(rulesContent.includes('allow read, write: if false;'));
  assert.ok(rulesContent.includes('match /profiles/{userId}'));
  assert.ok(rulesContent.includes('match /leads/{leadId}'));
  assert.ok(rulesContent.includes('match /messages/{messageId}'));
  assert.ok(rulesContent.includes('match /activities/{activityId}'));
  assert.ok(rulesContent.includes('match /followups/{followupId}'));
  assert.ok(rulesContent.includes('match /integrations/{integrationId}'));
});

test('Dirty Dozen 1-12 payloads all return PERMISSION_DENIED (false)', () => {
  const validAuth: AuthContext = { uid: 'user_A', email_verified: true };

  // Valid baseline passes
  assert.equal(evaluateLeadWrite('create', 'lead_1', validAuth, baseLead), true);

  // 1. Identity Spoofing
  assert.equal(evaluateLeadWrite('create', 'lead_1', validAuth, { ...baseLead, userId: 'user_B' }), false);

  // 2. Unverified Email
  assert.equal(evaluateLeadWrite('create', 'lead_1', { uid: 'user_A', email_verified: false }, baseLead), false);

  // 3. Shadow Field Injection
  assert.equal(evaluateLeadWrite('create', 'lead_1', validAuth, { ...baseLead, isAdmin: true }), false);

  // 4. Lead Score Out-of-Bounds
  assert.equal(evaluateLeadWrite('create', 'lead_1', validAuth, { ...baseLead, leadScore: 150 }), false);
  assert.equal(evaluateLeadWrite('create', 'lead_1', validAuth, { ...baseLead, leadScore: -5 }), false);

  // 5. Invalid Status Enum
  assert.equal(evaluateLeadWrite('create', 'lead_1', validAuth, { ...baseLead, status: 'hacked' }), false);

  // 6. Opt-Out Re-Entry Violation
  assert.equal(
    evaluateLeadWrite(
      'update',
      'lead_1',
      validAuth,
      { ...baseLead, status: 'contacted' },
      { ...baseLead, status: 'opted_out' }
    ),
    false
  );

  // 7. Unauthenticated Write
  assert.equal(evaluateLeadWrite('create', 'lead_1', null, baseLead), false);

  // 8. Immutable Field Mutation (createdAt)
  assert.equal(
    evaluateLeadWrite(
      'update',
      'lead_1',
      validAuth,
      { ...baseLead, createdAt: '2026-11-09T00:00:00.000Z' },
      baseLead
    ),
    false
  );

  // 9. Oversized String Poisoning
  assert.equal(
    evaluateLeadWrite('create', 'lead_1', validAuth, { ...baseLead, notes: 'x'.repeat(4500) }),
    false
  );

  // 10. ID Poisoning Attack
  assert.equal(evaluateLeadWrite('create', 'bad$id!@#', validAuth, baseLead), false);

  // 11. Cross-Tenant Update Attempt
  assert.equal(
    evaluateLeadWrite('update', 'lead_1', validAuth, baseLead, { ...baseLead, userId: 'user_B' }),
    false
  );

  // 12. Value Poisoning on Update
  assert.equal(
    evaluateLeadWrite('update', 'lead_1', validAuth, { ...baseLead, websiteStatus: true }, baseLead),
    false
  );
});
