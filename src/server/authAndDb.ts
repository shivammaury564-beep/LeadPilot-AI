import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Request, Response, NextFunction } from 'express';
import {
  ActivityRecord,
  FollowupRecord,
  LeadRecord,
  MessageRecord,
  UserProfile,
} from '../types/leadpilot.ts';
import {
  calculateLeadScore,
  canLeadEnterOutreach,
  canTransitionLeadStatus,
  detectDuplicateLead,
  hasVerifiedPremiumService,
  isPremiumCategory,
  recalculateLeadRecord,
} from '../utils/scoringAndCrm.ts';
import {
  INITIAL_DEMO_ACTIVITIES,
  INITIAL_DEMO_FOLLOWUPS,
  INITIAL_DEMO_LEADS,
  INITIAL_DEMO_MESSAGES,
  INITIAL_DEMO_PROFILE,
} from '../utils/demoData.ts';

// =============================================================================
// 1. SECURE STRUCTURED LOGGER (Redacts Secrets, Tokens, Passwords, API Keys)
// =============================================================================
const SENSITIVE_KEY_PATTERN = /password|token|secret|apikey|api_key|authorization|cookie|service_role/i;

export function redactSensitiveData(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    if (input.startsWith('Bearer ')) return 'Bearer [REDACTED]';
    return input;
  }
  if (Array.isArray(input)) {
    return input.map(redactSensitiveData);
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitiveData(v);
      }
    }
    return out;
  }
  return input;
}

export function secureLog(
  level: 'INFO' | 'WARN' | 'ERROR',
  event: string,
  meta: Record<string, unknown> = {}
) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(redactSensitiveData(meta) as Record<string, unknown>),
  };
  if (level === 'ERROR') {
    console.error(JSON.stringify(entry));
  } else if (level === 'WARN') {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// =============================================================================
// 2. SUPABASE CONFIGURATION & CLIENT FACTORY
// =============================================================================
export function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  const isConfigured =
    Boolean(url && anonKey) &&
    !url.includes('your-project-ref') &&
    anonKey !== 'your-supabase-anon-public-key' &&
    /^https?:\/\/.+/i.test(url);

  return {
    url,
    anonKey,
    serviceRoleKey:
      serviceRoleKey && serviceRoleKey !== 'your-supabase-service-role-secret-key'
        ? serviceRoleKey
        : '',
    isConfigured,
  };
}

export function createRlsSupabaseClient(accessToken?: string): SupabaseClient | null {
  const cfg = getSupabaseConfig();
  if (!cfg.isConfigured) return null;

  return createClient(cfg.url, cfg.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    global: accessToken
      ? {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      : undefined,
  });
}

// =============================================================================
// 3. CRYPTOGRAPHIC TOKEN, CREDENTIAL ENCRYPTION & PASSWORD UTILITIES
// =============================================================================
const DATA_DIR = path.join(process.cwd(), '.data');
const SECRET_FILE_PATH = path.join(DATA_DIR, 'auth_token_secret.key');
const PLACEHOLDER_SECRETS = new Set([
  'replace-with-32-byte-random-hex-secret',
  'my_auth_token_secret',
  'your-auth-token-secret',
  'changeme',
  'default',
]);

const LEGACY_DERIVED_SECRET = crypto
  .createHash('sha256')
  .update(`leadpilot-rls-${process.cwd()}`)
  .digest('hex');

function loadOrCreatePersistedSecret(): string {
  try {
    if (fs.existsSync(SECRET_FILE_PATH)) {
      const existing = fs.readFileSync(SECRET_FILE_PATH, 'utf8').trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_FILE_PATH, generated, { encoding: 'utf8', mode: 0o600 });
    return generated;
  } catch {
    return LEGACY_DERIVED_SECRET;
  }
}

export function getAuthSecretStatus(overrideSecret?: string): {
  valid: boolean;
  source: 'env' | 'persisted_keystore' | 'legacy_derived' | 'invalid';
  activeSecret: string;
  fallbackSecrets: string[];
  message: string;
} {
  if (overrideSecret !== undefined) {
    const trimmedOverride = overrideSecret.trim();
    if (
      !trimmedOverride ||
      trimmedOverride.length < 16 ||
      PLACEHOLDER_SECRETS.has(trimmedOverride.toLowerCase())
    ) {
      return {
        valid: false,
        source: 'invalid',
        activeSecret: '',
        fallbackSecrets: [],
        message:
          'AUTH_TOKEN_SECRET is missing, too short (minimum 16 characters), or set to a placeholder value. Please configure a strong 32-byte hex secret.',
      };
    }
    return {
      valid: true,
      source: 'env',
      activeSecret: trimmedOverride,
      fallbackSecrets: [LEGACY_DERIVED_SECRET],
      message: 'AUTH_TOKEN_SECRET is valid and active.',
    };
  }

  const rawEnv = (process.env.AUTH_TOKEN_SECRET || '').trim();
  const isEnvValid =
    rawEnv.length >= 16 && !PLACEHOLDER_SECRETS.has(rawEnv.toLowerCase());

  const persisted = loadOrCreatePersistedSecret();
  if (isEnvValid) {
    return {
      valid: true,
      source: 'env',
      activeSecret: rawEnv,
      fallbackSecrets: Array.from(new Set([persisted, LEGACY_DERIVED_SECRET])),
      message: 'AUTH_TOKEN_SECRET loaded from environment.',
    };
  }

  return {
    valid: true,
    source: persisted !== LEGACY_DERIVED_SECRET ? 'persisted_keystore' : 'legacy_derived',
    activeSecret: persisted,
    fallbackSecrets: [LEGACY_DERIVED_SECRET],
    message:
      rawEnv && PLACEHOLDER_SECRETS.has(rawEnv.toLowerCase())
        ? 'AUTH_TOKEN_SECRET in environment was a placeholder; using persistent local keystore secret (.data/auth_token_secret.key).'
        : 'Using persistent local keystore secret (.data/auth_token_secret.key).',
  };
}

function deriveAesKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a sensitive credential using AES-256-GCM (`v1:<iv_hex>:<auth_tag_hex>:<cipher_hex>`).
 * Never logs or exposes raw credentials.
 */
export function encryptCredential(
  plainText: string,
  secretOverride?: string
): { ok: true; cipherText: string } | { ok: false; error: string; code: string } {
  const cleanPlain = typeof plainText === 'string' ? plainText.trim() : '';
  if (!cleanPlain) {
    return {
      ok: false,
      code: 'EMPTY_CREDENTIAL',
      error: 'Cannot encrypt an empty credential value.',
    };
  }

  const secretStatus = getAuthSecretStatus(secretOverride);
  if (!secretStatus.valid || !secretStatus.activeSecret) {
    return {
      ok: false,
      code: 'INVALID_AUTH_SECRET',
      error: secretStatus.message,
    };
  }

  try {
    const key = deriveAesKey(secretStatus.activeSecret);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(cleanPlain, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ok: true,
      cipherText: `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`,
    };
  } catch {
    return {
      ok: false,
      code: 'ENCRYPTION_ERROR',
      error: 'Failed to encrypt credential with the configured AUTH_TOKEN_SECRET.',
    };
  }
}

/**
 * Safely decrypts an AES-256-GCM (`v1:iv:tag:cipher`) or legacy AES-256-CBC (`iv:cipher`) payload.
 * Tries active secret first, then fallback secrets when no explicit override is forced.
 * Never throws an unhandled "decryption failed" exception and never overwrites credentials.
 */
export function decryptCredential(
  cipherPayload: string,
  secretOverride?: string
):
  | { ok: true; plainText: string; usedFallbackKey: boolean }
  | { ok: false; error: string; code: 'INVALID_AUTH_SECRET' | 'MALFORMED_CIPHERTEXT' | 'DECRYPTION_FAILED' } {
  const raw = typeof cipherPayload === 'string' ? cipherPayload.trim() : '';
  if (!raw) {
    return {
      ok: false,
      code: 'MALFORMED_CIPHERTEXT',
      error: 'Encrypted credential payload is empty.',
    };
  }

  const secretStatus = getAuthSecretStatus(secretOverride);
  if (!secretStatus.valid || !secretStatus.activeSecret) {
    return {
      ok: false,
      code: 'INVALID_AUTH_SECRET',
      error: secretStatus.message,
    };
  }

  const candidateSecrets =
    secretOverride !== undefined
      ? [secretStatus.activeSecret]
      : [secretStatus.activeSecret, ...secretStatus.fallbackSecrets];

  const parts = raw.split(':');

  // Format 1: v1:<iv_hex>:<tag_hex>:<cipher_hex> (AES-256-GCM)
  if (parts.length === 4 && parts[0] === 'v1') {
    const [, ivHex, tagHex, encryptedHex] = parts;
    if (!ivHex || !tagHex || !encryptedHex) {
      return {
        ok: false,
        code: 'MALFORMED_CIPHERTEXT',
        error: 'Encrypted credential has malformed v1 AES-GCM segments.',
      };
    }

    for (let i = 0; i < candidateSecrets.length; i++) {
      try {
        const key = deriveAesKey(candidateSecrets[i]);
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(tagHex, 'hex');
        const encrypted = Buffer.from(encryptedHex, 'hex');
        if (iv.length !== 12 || authTag.length !== 16) {
          return {
            ok: false,
            code: 'MALFORMED_CIPHERTEXT',
            error: 'Encrypted credential IV or authentication tag length is invalid.',
          };
        }
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
          'utf8'
        );
        return {
          ok: true,
          plainText: decrypted,
          usedFallbackKey: i > 0,
        };
      } catch {
        // Try next fallback key if available
      }
    }

    return {
      ok: false,
      code: 'DECRYPTION_FAILED',
      error:
        'Credential decryption failed: AUTH_TOKEN_SECRET does not match the key used to encrypt this credential, or the ciphertext was corrupted. Existing stored credentials were preserved and not overwritten.',
    };
  }

  // Format 2: Legacy <iv_hex>:<cipher_hex> (AES-256-CBC)
  if (parts.length === 2) {
    const [ivHex, encryptedHex] = parts;
    for (let i = 0; i < candidateSecrets.length; i++) {
      try {
        const key = deriveAesKey(candidateSecrets[i]);
        const iv = Buffer.from(ivHex, 'hex');
        const encrypted = Buffer.from(encryptedHex, 'hex');
        if (iv.length !== 16) continue;
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
          'utf8'
        );
        return {
          ok: true,
          plainText: decrypted,
          usedFallbackKey: i > 0,
        };
      } catch {
        // Try next key
      }
    }

    return {
      ok: false,
      code: 'DECRYPTION_FAILED',
      error:
        'Legacy credential decryption failed: AUTH_TOKEN_SECRET does not match the encryption key. Existing credentials were preserved.',
    };
  }

  return {
    ok: false,
    code: 'MALFORMED_CIPHERTEXT',
    error: 'Unrecognized encrypted credential format. Expected v1:<iv>:<tag>:<ciphertext>.',
  };
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  agencyName: string;
  accessToken: string;
  authProvider: 'supabase' | 'local_rls';
}

export function hashPassword(password: string, salt?: string): string {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, useSalt, 64).toString('hex');
  return `${useSalt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = (storedHash || '').split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(key, 'hex');
  const b = Buffer.from(derived, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function issueAccessToken(payload: {
  sub: string;
  email: string;
  fullName: string;
  agencyName: string;
  exp?: number;
}): string {
  const secretInfo = getAuthSecretStatus();
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = payload.exp || Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 days
  const body = Buffer.from(
    JSON.stringify({
      sub: payload.sub,
      email: payload.email,
      fullName: payload.fullName,
      agencyName: payload.agencyName,
      iat: Math.floor(Date.now() / 1000),
      exp,
    })
  ).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secretInfo.activeSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyAccessToken(token: string): {
  sub: string;
  email: string;
  fullName: string;
  agencyName: string;
} | null {
  try {
    const parts = (token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const secretInfo = getAuthSecretStatus();
    const candidateSecrets = [secretInfo.activeSecret, ...secretInfo.fallbackSecrets];

    const sigBuf = Buffer.from(sig);
    let verified = false;
    for (const candidateSecret of candidateSecrets) {
      if (!candidateSecret) continue;
      const expectedSig = crypto
        .createHmac('sha256', candidateSecret)
        .update(`${header}.${body}`)
        .digest('base64url');
      const expBuf = Buffer.from(expectedSig);
      if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
        verified = true;
        break;
      }
    }
    if (!verified) return null;

    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!decoded.sub || !decoded.email) return null;
    if (typeof decoded.exp === 'number' && decoded.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      sub: String(decoded.sub),
      email: String(decoded.email),
      fullName: String(decoded.fullName || 'Agency Founder'),
      agencyName: String(decoded.agencyName || 'Northstar Web Studio'),
    };
  } catch {
    return null;
  }
}

// =============================================================================
// 4. PERSISTENT RELATIONAL STORE WITH STRICT PER-USER RLS ISOLATION
// =============================================================================
interface StoredUserAccount {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  agencyName: string;
  createdAt: string;
}

interface RelationalDatabaseState {
  users: StoredUserAccount[];
  profiles: Record<string, UserProfile>;
  leads: LeadRecord[];
  messages: MessageRecord[];
  activities: ActivityRecord[];
  followups: FollowupRecord[];
}

const DB_FILE_PATH = path.join(DATA_DIR, 'leadpilot_rls_store.json');

const DEFAULT_FOUNDER_ID = '00000000-0000-4000-8000-000000000001';
const DEFAULT_FOUNDER_EMAIL = 'founder@northstarstudio.in';

function createInitialDbState(): RelationalDatabaseState {
  const nowIso = new Date().toISOString();
  const founderProfile: UserProfile = {
    ...INITIAL_DEMO_PROFILE,
    userId: DEFAULT_FOUNDER_ID,
  };
  return {
    users: [
      {
        id: DEFAULT_FOUNDER_ID,
        email: DEFAULT_FOUNDER_EMAIL,
        passwordHash: hashPassword('LeadPilot#2026'),
        fullName: INITIAL_DEMO_PROFILE.fullName,
        agencyName: INITIAL_DEMO_PROFILE.agencyName,
        createdAt: nowIso,
      },
    ],
    profiles: {
      [DEFAULT_FOUNDER_ID]: founderProfile,
    },
    leads: INITIAL_DEMO_LEADS.map((l) => ({ ...l, userId: DEFAULT_FOUNDER_ID })),
    messages: INITIAL_DEMO_MESSAGES.map((m) => ({ ...m, userId: DEFAULT_FOUNDER_ID })),
    activities: INITIAL_DEMO_ACTIVITIES.map((a) => ({ ...a, userId: DEFAULT_FOUNDER_ID })),
    followups: INITIAL_DEMO_FOLLOWUPS.map((f) => ({ ...f, userId: DEFAULT_FOUNDER_ID })),
  };
}

let dbStateCache: RelationalDatabaseState | null = null;

function loadLocalDb(): RelationalDatabaseState {
  if (dbStateCache) return dbStateCache;
  try {
    if (fs.existsSync(DB_FILE_PATH)) {
      const raw = fs.readFileSync(DB_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as RelationalDatabaseState;
      if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.leads)) {
        let scoresUpdated = false;
        parsed.leads = parsed.leads.map((lead) => {
          const recalculated = recalculateLeadRecord(lead);
          if (recalculated.leadScore !== lead.leadScore) {
            scoresUpdated = true;
          }
          return recalculated;
        });
        dbStateCache = parsed;
        if (scoresUpdated) {
          saveLocalDb(dbStateCache);
        }
        return dbStateCache;
      }
    }
  } catch (err) {
    secureLog('WARN', 'Failed to read local DB file, initializing fresh store', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  dbStateCache = createInitialDbState();
  saveLocalDb(dbStateCache);
  return dbStateCache;
}

function saveLocalDb(state: RelationalDatabaseState) {
  dbStateCache = state;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    secureLog('WARN', 'Could not persist local DB to disk', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Row mappers between PostgreSQL snake_case and TypeScript camelCase
function mapDbRowToLead(row: Record<string, any>): LeadRecord {
  const aiJson =
    typeof row.ai_research_json === 'string'
      ? row.ai_research_json
      : row.ai_research_json
      ? JSON.stringify(row.ai_research_json)
      : '';
  const mapped: LeadRecord = {
    id: String(row.id),
    userId: String(row.user_id),
    businessName: String(row.business_name || ''),
    category: String(row.category || 'Premium salons'),
    city: String(row.city || ''),
    state: String(row.state || ''),
    country: String(row.country || ''),
    address: String(row.address || ''),
    phone: String(row.phone || ''),
    websiteUrl: String(row.website_url || ''),
    websiteStatus: row.website_status || 'unverified',
    hasOnlineBooking: Boolean(row.has_online_booking),
    isPremiumService: Boolean(row.is_premium_service),
    hasActivePublicProfile: row.has_active_public_profile !== false,
    instagramUrl: String(row.instagram_url || ''),
    facebookUrl: String(row.facebook_url || ''),
    googlePlaceId: String(row.google_place_id || ''),
    googleMapsUrl: String(row.google_maps_url || ''),
    rating: Number(row.rating || 0),
    reviewCount: Number(row.review_count || 0),
    leadScore: Number(row.lead_score || 0),
    source: row.source || 'manual',
    verificationStatus: row.verification_status || 'unverified',
    lastVerifiedAt: String(row.last_verified_at || ''),
    status: row.status || 'new',
    notes: String(row.notes || ''),
    tags: String(row.tags || ''),
    lastContactedAt: String(row.last_contacted_at || ''),
    nextFollowUpAt: String(row.next_follow_up_at || ''),
    aiResearchJson: aiJson,
    createdAt: String(row.created_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
    lat: typeof row.lat === 'number' ? row.lat : undefined,
    lng: typeof row.lng === 'number' ? row.lng : undefined,
  };
  return recalculateLeadRecord(mapped);
}

function mapLeadToDbRow(lead: LeadRecord): Record<string, unknown> {
  let parsedAi: unknown = null;
  if (lead.aiResearchJson) {
    try {
      parsedAi = JSON.parse(lead.aiResearchJson);
    } catch {
      parsedAi = null;
    }
  }
  return {
    id: lead.id,
    user_id: lead.userId,
    business_name: lead.businessName,
    category: lead.category,
    city: lead.city,
    state: lead.state,
    country: lead.country,
    address: lead.address,
    phone: lead.phone,
    website_url: lead.websiteUrl,
    website_status: lead.websiteStatus,
    has_online_booking: lead.hasOnlineBooking,
    is_premium_service: lead.isPremiumService,
    has_active_public_profile: lead.hasActivePublicProfile,
    instagram_url: lead.instagramUrl,
    facebook_url: lead.facebookUrl,
    google_place_id: lead.googlePlaceId,
    google_maps_url: lead.googleMapsUrl,
    rating: lead.rating,
    review_count: lead.reviewCount,
    lead_score: lead.leadScore,
    source: lead.source,
    verification_status: lead.verificationStatus,
    last_verified_at: lead.lastVerifiedAt || null,
    status: lead.status,
    notes: lead.notes,
    tags: lead.tags,
    last_contacted_at: lead.lastContactedAt || null,
    next_follow_up_at: lead.nextFollowUpAt || null,
    ai_research_json: parsedAi,
    lat: typeof lead.lat === 'number' ? lead.lat : null,
    lng: typeof lead.lng === 'number' ? lead.lng : null,
    created_at: lead.createdAt,
    updated_at: lead.updatedAt,
  };
}

// =============================================================================
// 5. AUTHENTICATION MIDDLEWARE (Protects Every Private API Route)
// =============================================================================
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = String(req.headers.authorization || '').trim();
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required. Provide a valid Authorization: Bearer <token> header.',
        code: 'UNAUTHORIZED',
      });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      return res.status(401).json({
        error: 'Authentication token is empty.',
        code: 'UNAUTHORIZED',
      });
    }

    // 1. First check local HMAC-signed session token
    const localVerified = verifyAccessToken(token);
    if (localVerified) {
      req.user = {
        id: localVerified.sub,
        email: localVerified.email,
        fullName: localVerified.fullName,
        agencyName: localVerified.agencyName,
        accessToken: token,
        authProvider: 'local_rls',
      };
      return next();
    }

    // 2. If Supabase is configured, verify via Supabase Auth JWT
    const supaClient = createRlsSupabaseClient(token);
    if (supaClient) {
      const { data, error } = await supaClient.auth.getUser(token);
      if (!error && data?.user) {
        req.user = {
          id: data.user.id,
          email: data.user.email || '',
          fullName: String(data.user.user_metadata?.full_name || 'Agency Founder'),
          agencyName: String(data.user.user_metadata?.agency_name || 'Northstar Web Studio'),
          accessToken: token,
          authProvider: 'supabase',
        };
        return next();
      }
    }

    return res.status(401).json({
      error: 'Invalid or expired authentication token.',
      code: 'INVALID_TOKEN',
    });
  } catch (err) {
    secureLog('ERROR', 'Authentication middleware failure', {
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(401).json({
      error: 'Authentication verification failed.',
      code: 'AUTH_ERROR',
    });
  }
}

// =============================================================================
// 6. AUTHENTICATION & USER SESSION OPERATIONS
// =============================================================================
export async function registerUserAccount(input: {
  email: string;
  password: string;
  fullName?: string;
  agencyName?: string;
}): Promise<{ accessToken: string; user: AuthenticatedUser; profile: UserProfile }> {
  const email = (input.email || '').trim().toLowerCase();
  const password = input.password || '';
  const fullName = (input.fullName || 'Agency Founder').trim().slice(0, 120);
  const agencyName = (input.agencyName || 'Northstar Web Studio').trim().slice(0, 160);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid email address is required.');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  const supaCfg = getSupabaseConfig();
  if (supaCfg.isConfigured) {
    const client = createRlsSupabaseClient()!;
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName, agency_name: agencyName },
      },
    });
    if (error) throw new Error(error.message);
    if (!data.user) throw new Error('Supabase registration did not return a user.');

    const token =
      data.session?.access_token ||
      issueAccessToken({ sub: data.user.id, email, fullName, agencyName });
    const nowIso = new Date().toISOString();
    const profile: UserProfile = {
      userId: data.user.id,
      fullName,
      agencyName,
      dailyTarget: 100,
      defaultCity: 'Mumbai',
      defaultCategory: 'Premium salons',
      researchPriority: 'missing_website',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    return {
      accessToken: token,
      user: {
        id: data.user.id,
        email,
        fullName,
        agencyName,
        accessToken: token,
        authProvider: 'supabase',
      },
      profile,
    };
  }

  // Local RLS Relational Store registration
  const db = loadLocalDb();
  if (db.users.some((u) => u.email === email)) {
    throw new Error('An account with this email address already exists.');
  }

  const userId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const newUser: StoredUserAccount = {
    id: userId,
    email,
    passwordHash: hashPassword(password),
    fullName,
    agencyName,
    createdAt: nowIso,
  };
  const newProfile: UserProfile = {
    userId,
    fullName,
    agencyName,
    dailyTarget: 100,
    defaultCity: 'Mumbai',
    defaultCategory: 'Premium salons',
    researchPriority: 'missing_website',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  db.users.push(newUser);
  db.profiles[userId] = newProfile;
  saveLocalDb(db);

  const accessToken = issueAccessToken({ sub: userId, email, fullName, agencyName });
  return {
    accessToken,
    user: {
      id: userId,
      email,
      fullName,
      agencyName,
      accessToken,
      authProvider: 'local_rls',
    },
    profile: newProfile,
  };
}

export async function loginUserAccount(input: {
  email: string;
  password: string;
}): Promise<{ accessToken: string; user: AuthenticatedUser; profile: UserProfile }> {
  const email = (input.email || '').trim().toLowerCase();
  const password = input.password || '';

  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  const supaCfg = getSupabaseConfig();
  if (supaCfg.isConfigured) {
    const client = createRlsSupabaseClient()!;
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.user || !data.session) {
      throw new Error(error?.message || 'Invalid email or password.');
    }
    const fullName = String(data.user.user_metadata?.full_name || 'Agency Founder');
    const agencyName = String(data.user.user_metadata?.agency_name || 'Northstar Web Studio');
    const authUser: AuthenticatedUser = {
      id: data.user.id,
      email: data.user.email || email,
      fullName,
      agencyName,
      accessToken: data.session.access_token,
      authProvider: 'supabase',
    };
    const profile = await getProfileForUser(authUser);
    return { accessToken: data.session.access_token, user: authUser, profile };
  }

  const db = loadLocalDb();
  const account = db.users.find((u) => u.email === email);
  if (!account || !verifyPassword(password, account.passwordHash)) {
    throw new Error('Invalid email or password.');
  }

  const accessToken = issueAccessToken({
    sub: account.id,
    email: account.email,
    fullName: account.fullName,
    agencyName: account.agencyName,
  });
  const authUser: AuthenticatedUser = {
    id: account.id,
    email: account.email,
    fullName: account.fullName,
    agencyName: account.agencyName,
    accessToken,
    authProvider: 'local_rls',
  };
  const profile = await getProfileForUser(authUser);
  return { accessToken, user: authUser, profile };
}

export async function getDefaultFounderSession(): Promise<{
  accessToken: string;
  user: AuthenticatedUser;
  profile: UserProfile;
}> {
  const db = loadLocalDb();
  const founder = db.users.find((u) => u.id === DEFAULT_FOUNDER_ID) || db.users[0];
  const accessToken = issueAccessToken({
    sub: founder.id,
    email: founder.email,
    fullName: founder.fullName,
    agencyName: founder.agencyName,
  });
  const authUser: AuthenticatedUser = {
    id: founder.id,
    email: founder.email,
    fullName: founder.fullName,
    agencyName: founder.agencyName,
    accessToken,
    authProvider: 'local_rls',
  };
  const profile = await getProfileForUser(authUser);
  return { accessToken, user: authUser, profile };
}

// =============================================================================
// 7. RLS-SCOPED DATABASE CRUD OPERATIONS (Enforces authUser.id === record.userId)
// =============================================================================
export async function getProfileForUser(authUser: AuthenticatedUser): Promise<UserProfile> {
  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      const { data } = await supa
        .from('profiles')
        .select('*')
        .eq('id', authUser.id)
        .maybeSingle();

      if (data) {
        return {
          userId: String(data.id),
          fullName: String(data.full_name || authUser.fullName),
          agencyName: String(data.agency_name || authUser.agencyName),
          dailyTarget: Number(data.daily_target || 100),
          defaultCity: String(data.default_city || 'Mumbai'),
          defaultCategory: String(data.default_category || 'Premium salons'),
          researchPriority: String(data.research_priority || 'missing_website'),
          createdAt: String(data.created_at),
          updatedAt: String(data.updated_at),
        };
      }
    }
  }

  const db = loadLocalDb();
  if (!db.profiles[authUser.id]) {
    const nowIso = new Date().toISOString();
    db.profiles[authUser.id] = {
      userId: authUser.id,
      fullName: authUser.fullName,
      agencyName: authUser.agencyName,
      dailyTarget: 100,
      defaultCity: 'Mumbai',
      defaultCategory: 'Premium salons',
      researchPriority: 'missing_website',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    saveLocalDb(db);
  }
  return db.profiles[authUser.id];
}

export async function updateProfileForUser(
  authUser: AuthenticatedUser,
  updates: Partial<UserProfile>
): Promise<UserProfile> {
  const existing = await getProfileForUser(authUser);
  const nowIso = new Date().toISOString();
  const nextProfile: UserProfile = {
    ...existing,
    fullName: String(updates.fullName ?? existing.fullName).trim().slice(0, 120) || 'Agency Founder',
    agencyName:
      String(updates.agencyName ?? existing.agencyName).trim().slice(0, 160) ||
      'Northstar Web Studio',
    dailyTarget: Math.min(500, Math.max(1, Number(updates.dailyTarget ?? existing.dailyTarget) || 100)),
    defaultCity: String(updates.defaultCity ?? existing.defaultCity).trim().slice(0, 100) || 'Mumbai',
    defaultCategory:
      String(updates.defaultCategory ?? existing.defaultCategory).trim().slice(0, 100) ||
      'Premium salons',
    researchPriority: String(updates.researchPriority ?? existing.researchPriority).slice(0, 40),
    userId: authUser.id,
    updatedAt: nowIso,
  };

  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      const { error } = await supa.from('profiles').upsert({
        id: authUser.id,
        full_name: nextProfile.fullName,
        agency_name: nextProfile.agencyName,
        daily_target: nextProfile.dailyTarget,
        default_city: nextProfile.defaultCity,
        default_category: nextProfile.defaultCategory,
        research_priority: nextProfile.researchPriority,
        updated_at: nowIso,
      });
      if (error) throw new Error(error.message);
      return nextProfile;
    }
  }

  const db = loadLocalDb();
  db.profiles[authUser.id] = nextProfile;
  saveLocalDb(db);
  return nextProfile;
}

export async function listWorkspaceDataForUser(authUser: AuthenticatedUser): Promise<{
  profile: UserProfile;
  leads: LeadRecord[];
  messages: MessageRecord[];
  activities: ActivityRecord[];
  followups: FollowupRecord[];
}> {
  const profile = await getProfileForUser(authUser);

  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      const [leadsRes, msgsRes, actsRes, fupsRes] = await Promise.all([
        supa.from('leads').select('*').eq('user_id', authUser.id).order('lead_score', { ascending: false }),
        supa.from('messages').select('*').eq('user_id', authUser.id).order('created_at', { ascending: false }),
        supa.from('activities').select('*').eq('user_id', authUser.id).order('created_at', { ascending: false }),
        supa.from('followups').select('*').eq('user_id', authUser.id).order('scheduled_at', { ascending: true }),
      ]);

      return {
        profile,
        leads: (leadsRes.data || []).map(mapDbRowToLead),
        messages: (msgsRes.data || []).map((r: any) => ({
          id: String(r.id),
          userId: String(r.user_id),
          leadId: String(r.lead_id),
          leadBusinessName: String(r.lead_business_name || ''),
          platform: r.platform,
          messageBody: String(r.message_body || ''),
          language: r.language || 'English',
          tone: r.tone || 'Friendly',
          status: r.status || 'draft',
          approvedAt: String(r.approved_at || ''),
          sentAt: String(r.sent_at || ''),
          replyNotes: String(r.reply_notes || ''),
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
        })),
        activities: (actsRes.data || []).map((r: any) => ({
          id: String(r.id),
          userId: String(r.user_id),
          leadId: String(r.lead_id),
          activityType: String(r.activity_type),
          description: String(r.description),
          createdAt: String(r.created_at),
        })),
        followups: (fupsRes.data || []).map((r: any) => ({
          id: String(r.id),
          userId: String(r.user_id),
          leadId: String(r.lead_id),
          leadBusinessName: String(r.lead_business_name || ''),
          scheduledAt: String(r.scheduled_at),
          status: r.status || 'pending',
          notes: String(r.notes || ''),
          createdAt: String(r.created_at),
          updatedAt: String(r.updated_at),
        })),
      };
    }
  }

  const db = loadLocalDb();
  // Strict RLS enforcement: filter every collection by userId === authUser.id
  return {
    profile,
    leads: db.leads.filter((l) => l.userId === authUser.id),
    messages: db.messages.filter((m) => m.userId === authUser.id),
    activities: db.activities.filter((a) => a.userId === authUser.id),
    followups: db.followups.filter((f) => f.userId === authUser.id),
  };
}

export async function saveOrUpdateLeadForUser(
  authUser: AuthenticatedUser,
  candidate: Partial<LeadRecord>,
  existingId?: string
): Promise<{ status: number; saved: boolean; lead?: LeadRecord; message: string }> {
  const { leads: userLeads } = await listWorkspaceDataForUser(authUser);

  const db = loadLocalDb();
  let existing: LeadRecord | undefined;

  if (existingId) {
    // Check if the record belongs to another user (Cross-User Isolation Check)
    const rawTarget = db.leads.find((l) => l.id === existingId);
    if (rawTarget && rawTarget.userId !== authUser.id) {
      return {
        status: 403,
        saved: false,
        message: 'Forbidden: Cross-user access denied by Row Level Security.',
      };
    }
    existing = userLeads.find((l) => l.id === existingId);
    if (!existing) {
      return { status: 404, saved: false, message: 'Lead record not found.' };
    }

    if (candidate.status) {
      const guard = canTransitionLeadStatus(existing.status, candidate.status);
      if (!guard.allowed) {
        return { status: 409, saved: false, message: guard.error! };
      }
    }
  }

  const businessName = String(candidate.businessName ?? existing?.businessName ?? '').trim();
  if (!businessName) {
    return { status: 400, saved: false, message: 'Business name is required.' };
  }

  const dup = detectDuplicateLead(candidate, userLeads, existingId);
  if (dup.isDuplicate) {
    return {
      status: 409,
      saved: false,
      lead: dup.matchedLead,
      message: dup.reason || 'Duplicate lead detected in CRM.',
    };
  }

  const nowIso = new Date().toISOString();
  const category = String(candidate.category ?? existing?.category ?? 'Premium salons')
    .trim()
    .slice(0, 100);
  const websiteStatus = (candidate.websiteStatus ??
    existing?.websiteStatus ??
    'unverified') as LeadRecord['websiteStatus'];

  const verificationStatus: LeadRecord['verificationStatus'] =
    candidate.verificationStatus ??
    existing?.verificationStatus ??
    (websiteStatus === 'unverified' ? 'unverified' : 'verified');

  const resolvedSource = (candidate.source ?? existing?.source ?? 'manual') as LeadRecord['source'];
  const resolvedNotes = String(candidate.notes ?? existing?.notes ?? '').trim().slice(0, 4000);
  const resolvedTags = String(candidate.tags ?? existing?.tags ?? '').trim().slice(0, 500);
  const resolvedAiJson = String(candidate.aiResearchJson ?? existing?.aiResearchJson ?? '').slice(
    0,
    15000
  );

  const merged: Omit<LeadRecord, 'id' | 'leadScore'> = {
    userId: authUser.id,
    businessName: businessName.slice(0, 200),
    category,
    city: String(candidate.city ?? existing?.city ?? '').trim().slice(0, 100),
    state: String(candidate.state ?? existing?.state ?? '').trim().slice(0, 100),
    country: String(candidate.country ?? existing?.country ?? '').trim().slice(0, 100),
    address: String(candidate.address ?? existing?.address ?? '').trim().slice(0, 400),
    phone: String(candidate.phone ?? existing?.phone ?? '').trim().slice(0, 60),
    websiteUrl: String(candidate.websiteUrl ?? existing?.websiteUrl ?? '').trim().slice(0, 500),
    websiteStatus,
    hasOnlineBooking: Boolean(candidate.hasOnlineBooking ?? existing?.hasOnlineBooking ?? false),
    isPremiumService:
      candidate.isPremiumService ??
      existing?.isPremiumService ??
      (resolvedSource === 'google_places'
        ? hasVerifiedPremiumService({
            businessName,
            category,
            source: resolvedSource,
            notes: resolvedNotes,
            tags: resolvedTags,
            aiResearchJson: resolvedAiJson,
            verificationStatus,
            websiteStatus,
          })
        : isPremiumCategory(category)),
    hasActivePublicProfile:
      candidate.hasActivePublicProfile ?? existing?.hasActivePublicProfile ?? true,
    instagramUrl: String(candidate.instagramUrl ?? existing?.instagramUrl ?? '')
      .trim()
      .slice(0, 500),
    facebookUrl: String(candidate.facebookUrl ?? existing?.facebookUrl ?? '').trim().slice(0, 500),
    googlePlaceId: String(candidate.googlePlaceId ?? existing?.googlePlaceId ?? '')
      .trim()
      .slice(0, 200),
    googleMapsUrl: String(candidate.googleMapsUrl ?? existing?.googleMapsUrl ?? '')
      .trim()
      .slice(0, 600),
    rating: Math.min(5, Math.max(0, Number(candidate.rating ?? existing?.rating ?? 0) || 0)),
    reviewCount: Math.max(
      0,
      Math.floor(Number(candidate.reviewCount ?? existing?.reviewCount ?? 0) || 0)
    ),
    source: resolvedSource,
    verificationStatus,
    lastVerifiedAt: String(candidate.lastVerifiedAt ?? existing?.lastVerifiedAt ?? nowIso).slice(
      0,
      60
    ),
    status: (candidate.status ?? existing?.status ?? 'new') as LeadRecord['status'],
    notes: resolvedNotes,
    tags: resolvedTags,
    lastContactedAt: String(candidate.lastContactedAt ?? existing?.lastContactedAt ?? '').slice(
      0,
      60
    ),
    nextFollowUpAt: String(candidate.nextFollowUpAt ?? existing?.nextFollowUpAt ?? '').slice(0, 60),
    aiResearchJson: resolvedAiJson,
    createdAt: existing?.createdAt || nowIso,
    updatedAt: nowIso,
    lat: candidate.lat ?? existing?.lat,
    lng: candidate.lng ?? existing?.lng,
  };

  const { totalScore } = calculateLeadScore(merged);
  const recordId = existingId || crypto.randomUUID();
  const fullRecord: LeadRecord = {
    id: recordId,
    ...merged,
    leadScore: totalScore,
  };

  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      const dbRow = mapLeadToDbRow(fullRecord);
      const { error } = await supa.from('leads').upsert(dbRow);
      if (error) {
        return { status: 400, saved: false, message: error.message };
      }
      return {
        status: existingId ? 200 : 201,
        saved: true,
        lead: fullRecord,
        message: existingId
          ? `Updated "${fullRecord.businessName}" (Score: ${fullRecord.leadScore}/100).`
          : `Saved "${fullRecord.businessName}" to CRM (Score: ${fullRecord.leadScore}/100).`,
      };
    }
  }

  if (existingId) {
    db.leads = db.leads.map((l) =>
      l.id === existingId && l.userId === authUser.id ? fullRecord : l
    );
  } else {
    db.leads.unshift(fullRecord);
  }
  saveLocalDb(db);

  return {
    status: existingId ? 200 : 201,
    saved: true,
    lead: fullRecord,
    message: existingId
      ? `Updated "${fullRecord.businessName}" (Score: ${fullRecord.leadScore}/100).`
      : `Saved "${fullRecord.businessName}" to CRM (Score: ${fullRecord.leadScore}/100).`,
  };
}

export async function deleteLeadForUser(
  authUser: AuthenticatedUser,
  leadId: string
): Promise<{ status: number; deleted: boolean; message: string }> {
  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      const { error, count } = await supa
        .from('leads')
        .delete({ count: 'exact' })
        .eq('id', leadId)
        .eq('user_id', authUser.id);
      if (error) return { status: 400, deleted: false, message: error.message };
      if (!count) return { status: 404, deleted: false, message: 'Lead not found or access denied.' };
      return { status: 200, deleted: true, message: 'Lead deleted.' };
    }
  }

  const db = loadLocalDb();
  const target = db.leads.find((l) => l.id === leadId);
  if (!target) {
    return { status: 404, deleted: false, message: 'Lead not found.' };
  }
  if (target.userId !== authUser.id) {
    return {
      status: 403,
      deleted: false,
      message: 'Forbidden: Cross-user deletion denied by Row Level Security.',
    };
  }

  db.leads = db.leads.filter((l) => !(l.id === leadId && l.userId === authUser.id));
  db.messages = db.messages.filter((m) => !(m.leadId === leadId && m.userId === authUser.id));
  db.activities = db.activities.filter((a) => !(a.leadId === leadId && a.userId === authUser.id));
  db.followups = db.followups.filter((f) => !(f.leadId === leadId && f.userId === authUser.id));
  saveLocalDb(db);

  return { status: 200, deleted: true, message: 'Lead deleted.' };
}

export async function createMessageForUser(
  authUser: AuthenticatedUser,
  msgInput: Omit<MessageRecord, 'id' | 'userId' | 'createdAt' | 'updatedAt'>
): Promise<{ status: number; saved: boolean; record?: MessageRecord; error?: string }> {
  const db = loadLocalDb();
  const parentLead =
    authUser.authProvider === 'supabase'
      ? (await listWorkspaceDataForUser(authUser)).leads.find((l) => l.id === msgInput.leadId)
      : db.leads.find((l) => l.id === msgInput.leadId);

  if (!parentLead) {
    return { status: 404, saved: false, error: 'Target lead not found.' };
  }
  if (parentLead.userId !== authUser.id) {
    return {
      status: 403,
      saved: false,
      error: 'Forbidden: Cannot create messages for another user’s lead.',
    };
  }

  // Enforce strict Opt-Out compliance lock
  const outreachGuard = canLeadEnterOutreach(parentLead.status, msgInput.status);
  if (!outreachGuard.allowed) {
    return { status: 409, saved: false, error: outreachGuard.error };
  }

  const nowIso = new Date().toISOString();
  const msgId = crypto.randomUUID();
  const record: MessageRecord = {
    id: msgId,
    userId: authUser.id,
    leadId: parentLead.id,
    leadBusinessName: String(msgInput.leadBusinessName || parentLead.businessName).slice(0, 200),
    platform: msgInput.platform || 'instagram',
    messageBody: String(msgInput.messageBody || '').trim().slice(0, 4000),
    language: msgInput.language || 'English',
    tone: msgInput.tone || 'Friendly',
    status: msgInput.status || 'draft',
    approvedAt:
      msgInput.status === 'approved' || msgInput.status === 'sent'
        ? msgInput.approvedAt || nowIso
        : '',
    sentAt:
      msgInput.status === 'sent' || msgInput.status === 'replied'
        ? msgInput.sentAt || nowIso
        : '',
    replyNotes: String(msgInput.replyNotes || '').trim().slice(0, 2000),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (!record.messageBody) {
    return { status: 400, saved: false, error: 'Message body cannot be empty.' };
  }

  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      const { error } = await supa.from('messages').insert({
        id: record.id,
        user_id: record.userId,
        lead_id: record.leadId,
        lead_business_name: record.leadBusinessName,
        platform: record.platform,
        message_body: record.messageBody,
        language: record.language,
        tone: record.tone,
        status: record.status,
        approved_at: record.approvedAt || null,
        sent_at: record.sentAt || null,
        reply_notes: record.replyNotes,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
      if (error) return { status: 400, saved: false, error: error.message };
    }
  } else {
    db.messages.unshift(record);
  }

  // Synchronously update parent lead status & log activity
  const nextLeadStatus: LeadRecord['status'] =
    record.status === 'opted_out'
      ? 'opted_out'
      : record.status === 'replied'
      ? 'interested'
      : record.status === 'sent'
      ? 'contacted'
      : record.status === 'approved'
      ? 'approved'
      : 'draft_ready';

  if (parentLead.status !== 'opted_out') {
    await saveOrUpdateLeadForUser(
      authUser,
      {
        ...parentLead,
        status: nextLeadStatus,
        lastContactedAt:
          record.status === 'sent' || record.status === 'replied'
            ? nowIso
            : parentLead.lastContactedAt,
      },
      parentLead.id
    );
  }

  const actRecord: ActivityRecord = {
    id: crypto.randomUUID(),
    userId: authUser.id,
    leadId: parentLead.id,
    activityType: `message_${record.status}`,
    description: `Outreach message (${record.platform.toUpperCase()}) marked as ${record.status}.`,
    createdAt: nowIso,
  };

  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      await supa.from('activities').insert({
        id: actRecord.id,
        user_id: actRecord.userId,
        lead_id: actRecord.leadId,
        activity_type: actRecord.activityType,
        description: actRecord.description,
        created_at: actRecord.createdAt,
      });
    }
  } else {
    db.activities.unshift(actRecord);
    saveLocalDb(db);
  }

  return { status: 201, saved: true, record };
}

export async function createFollowupForUser(
  authUser: AuthenticatedUser,
  input: {
    leadId: string;
    leadBusinessName: string;
    scheduledAt: string;
    notes: string;
  }
): Promise<{ status: number; saved: boolean; followup?: FollowupRecord; error?: string }> {
  const db = loadLocalDb();
  const parentLead =
    authUser.authProvider === 'supabase'
      ? (await listWorkspaceDataForUser(authUser)).leads.find((l) => l.id === input.leadId)
      : db.leads.find((l) => l.id === input.leadId);

  if (!parentLead) {
    return { status: 404, saved: false, error: 'Target lead not found.' };
  }
  if (parentLead.userId !== authUser.id) {
    return {
      status: 403,
      saved: false,
      error: 'Forbidden: Cannot schedule follow-ups for another user’s lead.',
    };
  }
  if (parentLead.status === 'opted_out') {
    return {
      status: 409,
      saved: false,
      error: 'Compliance Lock: Cannot schedule outreach follow-ups for an opted-out lead.',
    };
  }

  const nowIso = new Date().toISOString();
  const followup: FollowupRecord = {
    id: crypto.randomUUID(),
    userId: authUser.id,
    leadId: parentLead.id,
    leadBusinessName: String(input.leadBusinessName || parentLead.businessName).slice(0, 200),
    scheduledAt: String(input.scheduledAt || nowIso).slice(0, 60),
    status: 'pending',
    notes: String(input.notes || 'Scheduled follow-up check-in').trim().slice(0, 1000),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      const { error } = await supa.from('followups').insert({
        id: followup.id,
        user_id: followup.userId,
        lead_id: followup.leadId,
        lead_business_name: followup.leadBusinessName,
        scheduled_at: followup.scheduledAt,
        status: followup.status,
        notes: followup.notes,
        created_at: followup.createdAt,
        updated_at: followup.updatedAt,
      });
      if (error) return { status: 400, saved: false, error: error.message };
    }
  } else {
    db.followups.push(followup);
    saveLocalDb(db);
  }

  await saveOrUpdateLeadForUser(
    authUser,
    { ...parentLead, nextFollowUpAt: followup.scheduledAt },
    parentLead.id
  );

  return { status: 201, saved: true, followup };
}

export async function completeFollowupForUser(
  authUser: AuthenticatedUser,
  followupId: string
): Promise<{ status: number; updated: boolean; error?: string }> {
  const nowIso = new Date().toISOString();

  if (authUser.authProvider === 'supabase') {
    const supa = createRlsSupabaseClient(authUser.accessToken);
    if (supa) {
      const { error } = await supa
        .from('followups')
        .update({ status: 'completed', updated_at: nowIso })
        .eq('id', followupId)
        .eq('user_id', authUser.id);
      if (error) return { status: 400, updated: false, error: error.message };
      return { status: 200, updated: true };
    }
  }

  const db = loadLocalDb();
  const target = db.followups.find((f) => f.id === followupId);
  if (!target) {
    return { status: 404, updated: false, error: 'Follow-up not found.' };
  }
  if (target.userId !== authUser.id) {
    return { status: 403, updated: false, error: 'Forbidden: Cross-user access denied.' };
  }

  target.status = 'completed';
  target.updatedAt = nowIso;
  saveLocalDb(db);

  return { status: 200, updated: true };
}
