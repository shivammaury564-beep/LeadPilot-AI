import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';
import {
  buildDiscoveryQueryPlan,
  calculateLeadScore,
  canLeadEnterOutreach,
  generateCsvContent,
  isPremiumCategory,
  matchesWebsiteFilterGroup,
  validateAiDmVariationsJson,
  validateAiResearchJson,
  validateAndNormalizePlaceRecord,
} from './src/utils/scoringAndCrm.ts';
import { LeadRecord, LeadStatus } from './src/types/leadpilot.ts';
import {
  AuthenticatedRequest,
  completeFollowupForUser,
  createFollowupForUser,
  createMessageForUser,
  decryptCredential,
  deleteLeadForUser,
  encryptCredential,
  getAuthSecretStatus,
  getDefaultFounderSession,
  getProfileForUser,
  getSupabaseConfig,
  listWorkspaceDataForUser,
  loginUserAccount,
  registerUserAccount,
  requireAuth,
  saveOrUpdateLeadForUser,
  secureLog,
  updateProfileForUser,
} from './src/server/authAndDb.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();
const PORT = Number(process.env.PORT) || 3000;

// -----------------------------------------------------------------------------
// 1. Security Headers, Request Size Limit & Structured Request Logging
// -----------------------------------------------------------------------------
app.use(express.json({ limit: '250kb' }));

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.path.startsWith('/api/')) {
    const startMs = Date.now();
    res.on('finish', () => {
      const authReq = req as AuthenticatedRequest;
      secureLog('INFO', 'api_request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        userId: authReq.user?.id || 'anonymous',
        durationMs: Date.now() - startMs,
      });
    });
  }
  next();
});

// Handle malformed JSON payloads cleanly
app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload in request body.' });
  }
  return next(err);
});

// -----------------------------------------------------------------------------
// 2. Sliding-Window Rate Limiter (General API + Stricter AI/Places Quota Guard)
// -----------------------------------------------------------------------------
interface RateBucket {
  count: number;
  resetAt: number;
}
const generalBuckets: Record<string, RateBucket> = {};
const externalApiBuckets: Record<string, RateBucket> = {};

function createRateLimiter(
  store: Record<string, RateBucket>,
  maxRequests: number,
  windowMs: number
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    const clientKey =
      authReq.user?.id ||
      String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local');
    const now = Date.now();
    const bucket = store[clientKey];

    if (!bucket || now > bucket.resetAt) {
      store[clientKey] = { count: 1, resetAt: now + windowMs };
      return next();
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: `Rate limit exceeded (${maxRequests} requests/${Math.round(windowMs / 1000)}s). Please wait ${retryAfterSec}s.`,
        retryAfterSec,
      });
    }
    return next();
  };
}

app.use('/api', createRateLimiter(generalBuckets, 300, 60_000));
app.use('/api/places', createRateLimiter(externalApiBuckets, 180, 60_000));
app.use('/api/ai', createRateLimiter(externalApiBuckets, 40, 60_000));

// Track daily API usage counters in memory for transparency
const apiUsageStats = {
  placesRequestsToday: 0,
  geminiRequestsToday: 0,
  lastResetDate: new Date().toISOString().slice(0, 10),
};

function trackUsage(type: 'places' | 'gemini') {
  const today = new Date().toISOString().slice(0, 10);
  if (apiUsageStats.lastResetDate !== today) {
    apiUsageStats.placesRequestsToday = 0;
    apiUsageStats.geminiRequestsToday = 0;
    apiUsageStats.lastResetDate = today;
  }
  if (type === 'places') apiUsageStats.placesRequestsToday += 1;
  if (type === 'gemini') apiUsageStats.geminiRequestsToday += 1;
}

function getMapsApiKey(): string {
  return (
    process.env.GOOGLE_MAPS_PLATFORM_KEY ||
    process.env.VITE_GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    ''
  ).trim();
}

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// -----------------------------------------------------------------------------
// 3. Public Authentication & Runtime Status Endpoints (Zero Secret Exposure)
// -----------------------------------------------------------------------------
app.get('/api/integrations/status', (_req: Request, res: Response) => {
  const mapsKey = getMapsApiKey();
  const geminiKey = (process.env.GEMINI_API_KEY || '').trim();
  const metaToken = (process.env.META_GRAPH_ACCESS_TOKEN || '').trim();
  const supaCfg = getSupabaseConfig();
  const secretStatus = getAuthSecretStatus();

  // SECURITY: Never return raw API keys, service-role keys, or tokens in JSON responses.
  res.json({
    googlePlaces: {
      configured: Boolean(mapsKey && mapsKey !== 'MY_GOOGLE_MAPS_API_KEY'),
      endpoint: 'https://places.googleapis.com/v1/places:searchText',
      placeDetailsEndpoint: 'https://places.googleapis.com/v1/places/{placeId}',
      maxPerPage: 20,
      maxPerQueryAcrossPages: 60,
      attributionId: 'gmp_mcp_codeassist_v1_aistudio',
    },
    geminiAi: {
      configured: Boolean(geminiKey && geminiKey !== 'MY_GEMINI_API_KEY'),
      model: 'gemini-3.8-flash',
    },
    supabaseDb: {
      configured: supaCfg.isConfigured,
      mode: supaCfg.isConfigured
        ? 'Supabase PostgreSQL + Auth RLS Connected'
        : 'Local RLS Relational Engine Active (Set SUPABASE_URL & SUPABASE_ANON_KEY for remote Supabase)',
    },
    authSecret: {
      valid: secretStatus.valid,
      source: secretStatus.source,
      message: secretStatus.message,
    },
    metaGraph: {
      configured: Boolean(metaToken && metaToken !== 'MY_META_ACCESS_TOKEN'),
      mode:
        metaToken && metaToken !== 'MY_META_ACCESS_TOKEN'
          ? 'authorized_graph_api'
          : 'manual_compliant_workflow',
      notice:
        'Official Meta Graph API requires approved App Review permissions (instagram_basic, pages_read_engagement). Manual compliant research workflow is active.',
    },
    usage: apiUsageStats,
  });
});

app.post(
  '/api/auth/credentials-verify',
  requireAuth,
  (req: AuthenticatedRequest, res: Response) => {
    const { cipherText, plainText } = req.body || {};
    if (typeof cipherText === 'string' && cipherText.trim()) {
      const dec = decryptCredential(cipherText);
      if (!dec.ok) {
        return res.status(400).json({
          ok: false,
          code: dec.code,
          error: dec.error,
        });
      }
      return res.json({
        ok: true,
        usedFallbackKey: dec.usedFallbackKey,
        message: 'Encrypted credential verified successfully.',
      });
    }
    if (typeof plainText === 'string' && plainText.trim()) {
      const enc = encryptCredential(plainText);
      if (!enc.ok) {
        return res.status(400).json({
          ok: false,
          code: enc.code,
          error: enc.error,
        });
      }
      return res.json({
        ok: true,
        cipherText: enc.cipherText,
        message: 'Credential encrypted safely with AES-256-GCM.',
      });
    }
    return res.status(400).json({
      ok: false,
      error: 'Provide either plainText to encrypt or cipherText to verify.',
    });
  }
);

app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const { email = '', password = '', fullName = '', agencyName = '' } = req.body || {};
    const result = await registerUserAccount({ email, password, fullName, agencyName });
    return res.status(201).json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Registration failed.' });
  }
});

app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { email = '', password = '' } = req.body || {};
    const result = await loginUserAccount({ email, password });
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(401).json({ error: err.message || 'Authentication failed.' });
  }
});

app.post('/api/auth/session', async (_req: Request, res: Response) => {
  try {
    const session = await getDefaultFounderSession();
    return res.status(200).json(session);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to initialize session.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const profile = await getProfileForUser(req.user!);
    return res.json({ user: req.user, profile });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to load user profile.' });
  }
});

// -----------------------------------------------------------------------------
// 4. Protected CRM Database Endpoints (Enforces JWT Auth + Per-User RLS)
// -----------------------------------------------------------------------------
app.get('/api/crm/workspace', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const data = await listWorkspaceDataForUser(req.user!);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Failed to fetch CRM workspace.' });
  }
});

app.put('/api/crm/profile', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updated = await updateProfileForUser(req.user!, req.body || {});
    return res.json({ profile: updated });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to update profile.' });
  }
});

app.post('/api/crm/leads', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await saveOrUpdateLeadForUser(req.user!, req.body || {});
    return res.status(result.status).json(result);
  } catch (err: any) {
    return res.status(400).json({ saved: false, message: err.message || 'Failed to save lead.' });
  }
});

app.put('/api/crm/leads/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const leadId = String(req.params.id || '').trim();
    if (!leadId) {
      return res.status(400).json({ saved: false, message: 'Lead ID is required.' });
    }
    const result = await saveOrUpdateLeadForUser(req.user!, req.body || {}, leadId);
    return res.status(result.status).json(result);
  } catch (err: any) {
    return res.status(400).json({ saved: false, message: err.message || 'Failed to update lead.' });
  }
});

app.delete('/api/crm/leads/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const leadId = String(req.params.id || '').trim();
    if (!leadId) {
      return res.status(400).json({ deleted: false, message: 'Lead ID is required.' });
    }
    const result = await deleteLeadForUser(req.user!, leadId);
    return res.status(result.status).json(result);
  } catch (err: any) {
    return res.status(400).json({ deleted: false, message: err.message || 'Failed to delete lead.' });
  }
});

app.post('/api/crm/leads/bulk-tag', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ids, tag } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || typeof tag !== 'string' || !tag.trim()) {
      return res.status(400).json({ error: 'Valid lead IDs array and non-empty tag are required.' });
    }
    const cleanTag = tag.trim().slice(0, 60);
    const { leads } = await listWorkspaceDataForUser(req.user!);
    let updatedCount = 0;

    for (const id of ids) {
      const target = leads.find((l) => l.id === id);
      if (!target) continue;
      const existingTags = target.tags
        ? target.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [];
      if (!existingTags.includes(cleanTag)) {
        existingTags.push(cleanTag);
      }
      const resUpdate = await saveOrUpdateLeadForUser(
        req.user!,
        { ...target, tags: existingTags.join(', ') },
        target.id
      );
      if (resUpdate.saved) updatedCount++;
    }

    return res.json({ updatedCount, tag: cleanTag });
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to apply bulk tags.' });
  }
});

app.post('/api/crm/messages', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await createMessageForUser(req.user!, req.body || {});
    if (!result.saved) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(result.status).json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to save message.' });
  }
});

app.post('/api/crm/followups', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await createFollowupForUser(req.user!, req.body || {});
    if (!result.saved) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.status(result.status).json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err.message || 'Failed to schedule follow-up.' });
  }
});

app.patch(
  '/api/crm/followups/:id/complete',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const fupId = String(req.params.id || '').trim();
      const result = await completeFollowupForUser(req.user!, fupId);
      if (!result.updated) {
        return res.status(result.status).json({ error: result.error });
      }
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || 'Failed to complete follow-up.' });
    }
  }
);

app.get('/api/crm/export', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { leads } = await listWorkspaceDataForUser(req.user!);
    const csv = generateCsvContent(leads);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leadpilot-leads.csv"');
    return res.send(csv);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'CSV export failed.' });
  }
});

// -----------------------------------------------------------------------------
// 5. Protected Google Places API (New) Endpoints with Response Validation
// -----------------------------------------------------------------------------
// Helper: sleep for backoff / nextPageToken readiness
const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Fetch Place Details (New) with retry handling to verify websiteUri
async function fetchPlaceDetailsForVerification(
  placeId: string,
  apiKey: string
): Promise<Record<string, any> | null> {
  const cleanId = String(placeId || '').trim().replace(/^places\//i, '');
  if (!cleanId || !/^[a-zA-Z0-9_\-]+$/.test(cleanId)) return null;

  const fields = [
    'id',
    'displayName',
    'formattedAddress',
    'googleMapsUri',
    'rating',
    'userRatingCount',
    'websiteUri',
    'internationalPhoneNumber',
    'nationalPhoneNumber',
    'businessStatus',
    'location',
    'editorialSummary',
  ].join(',');

  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(cleanId)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      trackUsage('places');
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fields,
          'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
        },
      });

      if (response.status === 429) {
        return null;
      }
      if (response.status >= 500 && attempt === 0) {
        await sleepMs(400);
        continue;
      }
      if (!response.ok) {
        return null;
      }
      const data = (await response.json()) as Record<string, any>;
      if (data && typeof data.id === 'string') {
        return data;
      }
      return null;
    } catch {
      if (attempt === 0) {
        await sleepMs(400);
      }
    }
  }
  return null;
}

app.post(
  '/api/places/query-plan',
  requireAuth,
  (req: AuthenticatedRequest, res: Response) => {
    const {
      city = 'Mumbai',
      state = 'Maharashtra',
      country = 'India',
      categories = [],
      category = 'Premium salons',
      keyword = '',
      targetCount = 100,
    } = req.body || {};

    const plan = buildDiscoveryQueryPlan({
      city: String(city || ''),
      state: String(state || ''),
      country: String(country || 'India'),
      categories: Array.isArray(categories) ? categories : undefined,
      category: String(category || 'Premium salons'),
      keyword: String(keyword || ''),
      targetCount: Number(targetCount) || 100,
    });

    return res.json({
      queries: plan,
      maxPerPage: 20,
      maxPerQueryAcrossPages: 60,
    });
  }
);

app.post(
  '/api/places/search-text',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        city = '',
        state = '',
        country = 'India',
        category = 'Premium salons',
        keyword = '',
        customQuery = '',
        minRating = 0,
        minReviews = 0,
        maxResults = 20,
        pageToken = '',
        verifyMissingWebsites = true,
      } = req.body || {};

      const cleanCity = typeof city === 'string' ? city.trim().slice(0, 100) : '';
      const cleanState = typeof state === 'string' ? state.trim().slice(0, 100) : '';
      const cleanCountry =
        typeof country === 'string' && country.trim() ? country.trim().slice(0, 100) : 'India';
      const cleanCategory =
        typeof category === 'string' && category.trim()
          ? category.trim().slice(0, 100)
          : 'Premium salons';
      const cleanKeyword = typeof keyword === 'string' ? keyword.trim().slice(0, 120) : '';
      const cleanCustomQuery =
        typeof customQuery === 'string' ? customQuery.trim().slice(0, 240) : '';

      if (!cleanCity && !cleanKeyword && !cleanCustomQuery) {
        return res.status(400).json({
          error: 'Please provide at least a City or Search Keyword.',
        });
      }

      const apiKey = getMapsApiKey();
      if (!apiKey || apiKey === 'MY_GOOGLE_MAPS_API_KEY') {
        return res.status(503).json({
          error:
            'Google Maps Platform API key (GOOGLE_MAPS_PLATFORM_KEY) is not configured on the server.',
          missingKey: true,
        });
      }

      const locationParts = [cleanCity, cleanState, cleanCountry].filter(Boolean).join(', ');
      const queryParts =
        cleanCustomQuery ||
        (locationParts
          ? `${cleanKeyword || cleanCategory} in ${locationParts}`
          : cleanKeyword || cleanCategory);

      // Google Places Text Search (New) supports a maximum of 20 results per page.
      // Never pretend one API request can return more than 20 results.
      const pageSize = Math.min(20, Math.max(1, Number(maxResults) || 20));
      const requestBody: Record<string, unknown> = {
        textQuery: queryParts,
        pageSize,
      };

      const parsedMinRating = Number(minRating);
      if (Number.isFinite(parsedMinRating) && parsedMinRating > 0) {
        requestBody.minRating = Math.min(5.0, Math.max(0, parsedMinRating));
      }
      const cleanPageToken =
        typeof pageToken === 'string' ? pageToken.trim().slice(0, 400) : '';
      if (cleanPageToken) {
        requestBody.pageToken = cleanPageToken;
      }

      const fieldMask = [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.googleMapsUri',
        'places.rating',
        'places.userRatingCount',
        'places.websiteUri',
        'places.internationalPhoneNumber',
        'places.nationalPhoneNumber',
        'places.businessStatus',
        'places.location',
        'places.primaryTypeDisplayName',
        'nextPageToken',
      ].join(',');

      let response: globalThis.Response | null = null;
      let data: Record<string, any> = {};

      // Retry loop for transient 5xx errors or nextPageToken warm-up delay
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await sleepMs(attempt * 1200);
        }
        trackUsage('places');
        response = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': fieldMask,
            'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
          },
          body: JSON.stringify(requestBody),
        });

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          if (attempt < 2 && response.status >= 500) continue;
          return res.status(502).json({
            error: `Unexpected non-JSON response from Google Places API (status ${response.status}).`,
          });
        }

        data = (await response.json()) as Record<string, any>;

        if (response.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED') {
          return res.status(429).json({
            error: 'Google Maps Platform quota reached.',
            quotaExceeded: true,
          });
        }

        // If pageToken was just issued, Google Places may return 400 INVALID_ARGUMENT if queried <1.5s after token creation
        if (cleanPageToken && response.status === 400 && attempt < 2) {
          continue;
        }
        if (response.status >= 500 && attempt < 2) {
          continue;
        }
        break;
      }

      if (!response || !response.ok) {
        if (cleanPageToken && response?.status === 400) {
          return res.status(200).json({
            places: [],
            nextPageToken: '',
            queryExecuted: queryParts,
            verifiedDetailsCount: 0,
            pageTokenExhausted: true,
          });
        }
        return res.status(response?.status || 500).json({
          error: data?.error?.message || `Places API Text Search failed (${response?.status}).`,
        });
      }

      const rawPlaces: Record<string, any>[] = Array.isArray(data?.places) ? data.places : [];
      const parsedMinReviews = Math.max(0, Number(minReviews) || 0);

      // Independently verify candidates missing websiteUri via Place Details (New) with bounded concurrency
      const detailsMap = new Map<string, Record<string, any>>();
      if (verifyMissingWebsites !== false) {
        const candidatesToVerify = rawPlaces.filter((p) => {
          const hasSearchWeb =
            typeof p?.websiteUri === 'string' && /^https?:\/\/.+/i.test(p.websiteUri.trim());
          if (hasSearchWeb) return false;
          const rRating = typeof p?.rating === 'number' ? p.rating : 0;
          const rReviews = typeof p?.userRatingCount === 'number' ? p.userRatingCount : 0;
          return rRating >= (Number.isFinite(parsedMinRating) ? parsedMinRating : 0) && rReviews >= parsedMinReviews;
        });

        const CONCURRENCY = 5;
        for (let i = 0; i < candidatesToVerify.length; i += CONCURRENCY) {
          const batch = candidatesToVerify.slice(i, i + CONCURRENCY);
          const batchDetails = await Promise.all(
            batch.map(async (p) => {
              const pid = typeof p.id === 'string' ? p.id : '';
              if (!pid) return null;
              const det = await fetchPlaceDetailsForVerification(pid, apiKey);
              return det ? { pid, det } : null;
            })
          );
          for (const item of batchDetails) {
            if (item) {
              detailsMap.set(item.pid, item.det);
            }
          }
        }
      }

      const validatedPlaces = rawPlaces
        .map((p: Record<string, any>) => {
          const pid = typeof p?.id === 'string' ? p.id : '';
          const placeDetails = pid ? detailsMap.get(pid) || null : null;
          return validateAndNormalizePlaceRecord(p, {
            city: cleanCity,
            state: cleanState,
            country: cleanCountry,
            category: cleanCategory,
            placeDetails,
            independentVerificationConfirmed: Boolean(placeDetails),
          });
        })
        .filter(Boolean);

      return res.json({
        places: validatedPlaces,
        nextPageToken: typeof data?.nextPageToken === 'string' ? data.nextPageToken : '',
        queryExecuted: queryParts,
        verifiedDetailsCount: detailsMap.size,
      });
    } catch (error: any) {
      secureLog('ERROR', 'places_search_text_error', { error: error.message });
      return res.status(500).json({
        error: error.message || 'Internal server error during Places Text Search.',
      });
    }
  }
);

app.post(
  '/api/places/search-nearby',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        latitude,
        longitude,
        radiusMeters = 5000,
        includedTypes = ['beauty_salon'],
        maxResults = 10,
        city = '',
        category = 'Premium salons',
      } = req.body || {};

      const lat = Number(latitude);
      const lng = Number(longitude);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180
      ) {
        return res.status(400).json({
          error: 'Valid latitude (-90..90) and longitude (-180..180) coordinates are required.',
        });
      }

      const apiKey = getMapsApiKey();
      if (!apiKey || apiKey === 'MY_GOOGLE_MAPS_API_KEY') {
        return res.status(503).json({
          error: 'Google Maps Platform API key is not configured on the server.',
          missingKey: true,
        });
      }

      trackUsage('places');

      const fieldMask = [
        'places.id',
        'places.displayName',
        'places.formattedAddress',
        'places.googleMapsUri',
        'places.rating',
        'places.userRatingCount',
        'places.websiteUri',
        'places.internationalPhoneNumber',
        'places.location',
      ].join(',');

      const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fieldMask,
          'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
        },
        body: JSON.stringify({
          includedTypes:
            Array.isArray(includedTypes) && includedTypes.length > 0
              ? includedTypes.slice(0, 10)
              : ['beauty_salon'],
          maxResultCount: Math.min(20, Math.max(1, Number(maxResults) || 10)),
          locationRestriction: {
            circle: {
              center: { latitude: lat, longitude: lng },
              radius: Math.min(50000, Math.max(100, Number(radiusMeters) || 5000)),
            },
          },
        }),
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return res.status(502).json({
          error: `Unexpected non-JSON response from Google Places Nearby Search (${response.status}).`,
        });
      }

      const data = (await response.json()) as Record<string, any>;

      if (response.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED') {
        return res.status(429).json({
          error: 'Google Maps Platform quota reached.',
          quotaExceeded: true,
        });
      }

      if (!response.ok) {
        return res.status(response.status).json({
          error: data?.error?.message || `Places API Nearby Search failed (${response.status}).`,
        });
      }

      const rawPlaces = Array.isArray(data?.places) ? data.places : [];
      const validatedPlaces = rawPlaces
        .map((p: unknown) =>
          validateAndNormalizePlaceRecord(p, {
            city: typeof city === 'string' ? city : '',
            category: typeof category === 'string' ? category : 'Premium salons',
          })
        )
        .filter(Boolean);

      return res.json({ places: validatedPlaces });
    } catch (error: any) {
      secureLog('ERROR', 'places_search_nearby_error', { error: error.message });
      return res.status(500).json({ error: error.message || 'Nearby search failed.' });
    }
  }
);

app.get(
  '/api/places/details/:placeId',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const placeId = String(req.params.placeId || '').trim();
      if (!placeId || placeId.length > 200 || !/^[a-zA-Z0-9_\-]+$/.test(placeId)) {
        return res.status(400).json({ error: 'Valid Google Place ID is required.' });
      }

      const apiKey = getMapsApiKey();
      if (!apiKey || apiKey === 'MY_GOOGLE_MAPS_API_KEY') {
        return res.status(503).json({
          error: 'Google Maps Platform API key is not configured.',
          missingKey: true,
        });
      }

      trackUsage('places');

      const fields = [
        'id',
        'displayName',
        'formattedAddress',
        'googleMapsUri',
        'rating',
        'userRatingCount',
        'websiteUri',
        'internationalPhoneNumber',
        'regularOpeningHours',
        'businessStatus',
        'location',
      ].join(',');

      const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': fields,
          'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
        },
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return res.status(502).json({
          error: `Unexpected non-JSON response from Place Details API (${response.status}).`,
        });
      }

      const data = (await response.json()) as Record<string, any>;
      if (response.status === 429 || data?.error?.status === 'RESOURCE_EXHAUSTED') {
        return res.status(429).json({
          error: 'Google Maps Platform quota reached.',
          quotaExceeded: true,
        });
      }
      if (!response.ok) {
        return res.status(response.status).json({
          error: data?.error?.message || `Failed to fetch Place Details (${response.status}).`,
        });
      }

      if (!data || typeof data.id !== 'string') {
        return res.status(502).json({ error: 'Invalid Place Details payload returned by upstream.' });
      }

      return res.json({ place: data });
    } catch (error: any) {
      secureLog('ERROR', 'places_details_error', { error: error.message });
      return res.status(500).json({ error: error.message || 'Place details lookup failed.' });
    }
  }
);

// -----------------------------------------------------------------------------
// 6. Protected Gemini AI Endpoints with Strict Structured JSON Validation
// -----------------------------------------------------------------------------
app.post('/api/ai/research', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      businessName = '',
      category = '',
      city = '',
      websiteUrl = '',
      websiteStatus = 'unverified',
      rating = 0,
      reviewCount = 0,
      instagramUrl = '',
      facebookUrl = '',
      notes = '',
    } = req.body || {};

    const cleanName = typeof businessName === 'string' ? businessName.trim().slice(0, 200) : '';
    if (!cleanName) {
      return res.status(400).json({ error: 'Business name is required for AI research.' });
    }

    const ai = getGeminiClient();
    if (!ai) {
      return res.status(503).json({
        error:
          'GEMINI_API_KEY is not configured on the server. Configure GEMINI_API_KEY in Secrets to run AI Business Research.',
      });
    }

    trackUsage('gemini');

    const prompt = `Analyze the following verified business prospect for a website development agency.
STRICT COMPLIANCE RULES:
1. NEVER invent or hallucinate business facts, prices, specific staff names, customer reviews, or website problems that are not in the input.
2. Strictly separate verified facts (from the input data) from AI strategic suggestions.
3. If websiteStatus is "unverified", explicitly state that website presence is unverified and do NOT claim they have no website.

Verified Input Data:
- Business Name: ${cleanName}
- Category: ${String(category || 'Not specified').slice(0, 100)}
- City: ${String(city || 'Not specified').slice(0, 100)}
- Website URL: ${String(websiteUrl || 'None recorded').slice(0, 500)}
- Website Verification Status: ${String(websiteStatus || 'unverified').slice(0, 40)}
- Public Rating: ${Number(rating) || 'Not recorded'} (${Number(reviewCount) || 0} reviews)
- Instagram URL: ${String(instagramUrl || 'None recorded').slice(0, 500)}
- Facebook URL: ${String(facebookUrl || 'None recorded').slice(0, 500)}
- User Research Notes: ${String(notes || 'None provided').slice(0, 2000)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        systemInstruction:
          'You are a senior B2B website strategy consultant for web development agencies. Produce accurate, ethical, non-hallucinated business research in structured JSON.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            businessOverview: { type: Type.STRING },
            targetCustomers: { type: Type.ARRAY, items: { type: Type.STRING } },
            mainServices: { type: Type.ARRAY, items: { type: Type.STRING } },
            brandPositioning: { type: Type.STRING },
            onlinePresenceAssessment: {
              type: Type.OBJECT,
              properties: {
                verifiedFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
                unverifiedAreas: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['verifiedFacts', 'unverifiedAreas'],
            },
            websiteOpportunities: { type: Type.ARRAY, items: { type: Type.STRING } },
            suggestedWebsiteSections: { type: Type.ARRAY, items: { type: Type.STRING } },
            suggestedBookingFeatures: { type: Type.ARRAY, items: { type: Type.STRING } },
            personalizedOutreachAngle: { type: Type.STRING },
          },
          required: [
            'businessOverview',
            'targetCustomers',
            'mainServices',
            'brandPositioning',
            'onlinePresenceAssessment',
            'websiteOpportunities',
            'suggestedWebsiteSections',
            'suggestedBookingFeatures',
            'personalizedOutreachAngle',
          ],
        },
      },
    });

    const research = validateAiResearchJson(response.text ?? '');
    return res.json({ research, mode: 'gemini_live' });
  } catch (error: any) {
    secureLog('ERROR', 'gemini_research_error', { error: error.message });
    return res.status(502).json({
      error: error.message || 'Failed to generate AI business research.',
    });
  }
});

app.post(
  '/api/ai/generate-dms',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        leadId = '',
        leadStatus = 'new',
        businessName = '',
        category = '',
        city = '',
        websiteStatus = 'unverified',
        rating = 0,
        reviewCount = 0,
        platform = 'instagram',
        tone = 'Friendly',
        language = 'English',
        notes = '',
        agencyName = 'Northstar Web Studio',
      } = req.body || {};

      const cleanName = typeof businessName === 'string' ? businessName.trim().slice(0, 200) : '';
      if (!cleanName) {
        return res
          .status(400)
          .json({ error: 'Business name is required to generate outreach messages.' });
      }

      // Check Opt-Out status from request AND from database if leadId is provided
      const statusCheck = canLeadEnterOutreach(leadStatus as LeadStatus);
      if (!statusCheck.allowed) {
        return res.status(409).json({ error: statusCheck.error });
      }

      if (leadId && typeof leadId === 'string') {
        const { leads } = await listWorkspaceDataForUser(req.user!);
        const matched = leads.find((l) => l.id === leadId);
        if (matched && matched.status === 'opted_out') {
          return res.status(409).json({
            error:
              'Compliance Lock: Opted-out leads cannot enter outreach workflows or have DMs generated.',
          });
        }
      }

      const ai = getGeminiClient();
      if (!ai) {
        return res.status(503).json({
          error:
            'GEMINI_API_KEY is not configured on the server. Configure GEMINI_API_KEY in Secrets to generate AI outreach drafts.',
        });
      }

      trackUsage('gemini');

      const prompt = `Generate exactly 3 distinct, natural, non-spammy first-contact outreach messages for a web development agency reaching out to a verified prospect.
STRICT COMPLIANCE RULES:
- Never claim the business has a broken or missing website unless Website Status is "missing_verified" or "outdated_verified".
- Do not invent fake facts or prices.
- Keep the tone respectful, consultative, and low-pressure (offering a free custom demo preview).

Prospect Details:
- Business Name: ${cleanName}
- Category: ${String(category || 'Local business').slice(0, 100)}
- City: ${String(city || '').slice(0, 100)}
- Website Verification Status: ${String(websiteStatus || 'unverified').slice(0, 40)}
- Public Rating: ${Number(rating) ? `${Number(rating)} stars (${Number(reviewCount) || 0} reviews)` : 'Not specified'}
- Research Notes: ${String(notes || 'None').slice(0, 1500)}
- Target Platform: ${String(platform || 'instagram').slice(0, 30)}
- Style / Tone: ${String(tone || 'Friendly').slice(0, 40)}
- Language: ${String(language || 'English').slice(0, 30)}
- Sender Agency: ${String(agencyName || 'Northstar Web Studio').slice(0, 120)}`;

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          systemInstruction:
            'You are an expert B2B agency outreach copywriter. Return a JSON object containing an array of 3 personalized outreach message variations.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              variations: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['variations'],
          },
        },
      });

      const variations = validateAiDmVariationsJson(response.text ?? '');
      return res.json({ variations, mode: 'gemini_live' });
    } catch (error: any) {
      secureLog('ERROR', 'gemini_generate_dms_error', { error: error.message });
      return res.status(502).json({
        error: error.message || 'Failed to generate outreach drafts.',
      });
    }
  }
);

// -----------------------------------------------------------------------------
// 7. Chrome Extension Manifest V3 Companion Architecture & Protected Endpoint
// -----------------------------------------------------------------------------
app.get('/api/extension/manifest', (_req: Request, res: Response) => {
  res.json({
    manifestVersion: 3,
    manifestJson: {
      manifest_version: 3,
      name: 'LeadPilot AI — Agency Companion',
      version: '1.0.0',
      description:
        'Save eligible public business profiles to LeadPilot AI CRM, view transparent lead scores, and draft personalized outreach.',
      permissions: ['sidePanel', 'storage', 'activeTab'],
      host_permissions: [`${process.env.APP_URL || 'http://localhost:3000'}/*`],
      side_panel: {
        default_path: 'sidepanel.html',
      },
      action: {
        default_title: 'Open LeadPilot AI Side Panel',
      },
      background: {
        service_worker: 'service-worker.js',
        type: 'module',
      },
    },
    authentication: 'Bearer JWT required in Authorization header for all capture/AI endpoints',
    endpoints: {
      verifyAndScoreLead: 'POST /api/extension/capture',
      saveLeadToCrm: 'POST /api/crm/leads',
      aiResearchSummary: 'POST /api/ai/research',
      aiDraftMessages: 'POST /api/ai/generate-dms',
    },
    compliancePolicy:
      'Uses Manifest V3 sidePanel API with explicit user invocation only. Does not scrape protected DOMs or automate unsolicited platform messaging.',
  });
});

app.post(
  '/api/extension/capture',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        businessName = '',
        category = 'Premium salons',
        city = '',
        phone = '',
        websiteUrl = '',
        websiteStatus = 'unverified',
        instagramUrl = '',
        facebookUrl = '',
        notes = '',
        persistToCrm = false,
      } = req.body || {};

      const cleanName = typeof businessName === 'string' ? businessName.trim().slice(0, 200) : '';
      if (!cleanName) {
        return res
          .status(400)
          .json({ error: 'businessName is required for Chrome Extension capture.' });
      }

      const cleanCategory =
        typeof category === 'string' && category.trim()
          ? category.trim().slice(0, 100)
          : 'Premium salons';
      const cleanWebStatus = [
        'missing_verified',
        'outdated_verified',
        'modern_verified',
        'unverified',
      ].includes(websiteStatus)
        ? websiteStatus
        : 'unverified';

      const candidate: Partial<LeadRecord> = {
        businessName: cleanName,
        category: cleanCategory,
        city: typeof city === 'string' ? city.trim().slice(0, 100) : '',
        phone: typeof phone === 'string' ? phone.trim().slice(0, 60) : '',
        websiteUrl: typeof websiteUrl === 'string' ? websiteUrl.trim().slice(0, 500) : '',
        websiteStatus: cleanWebStatus,
        instagramUrl: typeof instagramUrl === 'string' ? instagramUrl.trim().slice(0, 500) : '',
        facebookUrl: typeof facebookUrl === 'string' ? facebookUrl.trim().slice(0, 500) : '',
        hasActivePublicProfile: true,
        isPremiumService: isPremiumCategory(cleanCategory),
        hasOnlineBooking: false,
        verificationStatus: cleanWebStatus !== 'unverified' ? 'verified' : 'needs_review',
        source: 'chrome_extension',
        notes: typeof notes === 'string' ? notes.trim().slice(0, 2000) : '',
      };

      const breakdown = calculateLeadScore(candidate);

      if (persistToCrm) {
        const savedResult = await saveOrUpdateLeadForUser(req.user!, candidate);
        return res.status(savedResult.status).json({
          status: savedResult.saved ? 'saved_to_crm' : 'duplicate_or_rejected',
          saved: savedResult.saved,
          message: savedResult.message,
          lead: savedResult.lead || { ...candidate, leadScore: breakdown.totalScore },
          scoreBreakdown: breakdown,
        });
      }

      return res.json({
        status: 'ready_for_crm',
        lead: {
          ...candidate,
          leadScore: breakdown.totalScore,
        },
        scoreBreakdown: breakdown,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Extension capture failed.' });
    }
  }
);

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    secureLog('INFO', 'server_started', { url: `http://0.0.0.0:${PORT}` });
  });
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule && process.env.LEADPILOT_SKIP_LISTEN !== '1') {
  startServer();
}
