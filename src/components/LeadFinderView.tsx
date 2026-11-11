import React, { useRef, useState } from 'react';
import {
  APIProvider,
  Map as GoogleMap,
  AdvancedMarker,
  InfoWindow,
} from '@vis.gl/react-google-maps';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  MapPin,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
} from 'lucide-react';
import {
  BUSINESS_CATEGORIES,
  LeadRecord,
  WebsiteStatus,
} from '../types/leadpilot';
import {
  buildDiscoveryQueryPlan,
  calculateLeadScore,
  detectDuplicateLead,
  matchesWebsiteFilterGroup,
  normalizeGooglePlaceId,
  safeParseHttpResponse,
  validateAndNormalizePlaceRecord,
  WebsiteFilterOption,
} from '../utils/scoringAndCrm';
import { authenticatedFetch } from '../lib/supabase';

interface LeadFinderViewProps {
  existingLeads: LeadRecord[];
  mapsBrowserKey: string;
  placesConfigured: boolean;
  onSaveLead: (lead: Partial<LeadRecord>) => Promise<{ saved: boolean; lead?: LeadRecord; message: string }>;
  onSelectLeadForResearch: (lead: LeadRecord) => void;
}

export interface DiscoveryTelemetry {
  isRunning: boolean;
  cancelled: boolean;
  currentQueryIndex: number;
  totalQueriesPlanned: number;
  currentQueryText: string;
  pagesFetched: number;
  totalDiscovered: number;
  withWebsiteCount: number;
  verifiedNoWebsiteCount: number;
  needsVerificationCount: number;
  duplicatesRemovedCount: number;
  qualifiedSavedCount: number;
}

export const LeadFinderView: React.FC<LeadFinderViewProps> = ({
  existingLeads,
  mapsBrowserKey,
  placesConfigured,
  onSaveLead,
  onSelectLeadForResearch,
}) => {
  const [searchMode, setSearchMode] = useState<'text' | 'nearby'>('text');

  // Search Filter Settings (Requirement #3 Defaults)
  const [city, setCity] = useState('Mumbai');
  const [state, setState] = useState('Maharashtra');
  const [country, setCountry] = useState('India');
  const [category, setCategory] = useState<string>('Premium salons');
  const [additionalCategories, setAdditionalCategories] = useState<string[]>([]);
  const [keyword, setKeyword] = useState('');
  // Default Website Filter MUST be "No Website – Verified" ('missing_verified')
  const [websiteFilter, setWebsiteFilter] = useState<WebsiteFilterOption>('missing_verified');
  const [minRating, setMinRating] = useState<number>(4.0);
  const [minReviews, setMinReviews] = useState<number>(5);
  const [dailyTarget, setDailyTarget] = useState<number>(100);
  // Maximum Results Dropdown: 20 Leads, 50 Leads, 100 Leads (default 100)
  const [maxResults, setMaxResults] = useState<number>(100);

  // Nearby search coordinates
  const [latitude, setLatitude] = useState<number>(19.076);
  const [longitude, setLongitude] = useState<number>(72.8777);
  const [radiusMeters, setRadiusMeters] = useState<number>(5000);

  const [results, setResults] = useState<Array<Partial<LeadRecord> & { leadScore: number }>>([]);
  const [nextPageToken, setNextPageToken] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [selectedMarkerIdx, setSelectedMarkerIdx] = useState<number | null>(null);
  const [inspectingPlace, setInspectingPlace] = useState<Record<string, any> | null>(null);
  const [loadingDetailsId, setLoadingDetailsId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<DiscoveryTelemetry>({
    isRunning: false,
    cancelled: false,
    currentQueryIndex: 0,
    totalQueriesPlanned: 5,
    currentQueryText: 'Ready to run multi-query discovery',
    pagesFetched: 0,
    totalDiscovered: 0,
    withWebsiteCount: 0,
    verifiedNoWebsiteCount: 0,
    needsVerificationCount: 0,
    duplicatesRemovedCount: 0,
    qualifiedSavedCount: 0,
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  const toggleAdditionalCategory = (cat: string) => {
    setAdditionalCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const handleCancelDiscovery = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const computeTelemetryCounts = (
    items: Array<Partial<LeadRecord> & { leadScore: number }>,
    duplicatesRemoved: number,
    qualifiedSaved: number,
    meta: Pick<
      DiscoveryTelemetry,
      'isRunning' | 'cancelled' | 'currentQueryIndex' | 'totalQueriesPlanned' | 'currentQueryText' | 'pagesFetched'
    >
  ): DiscoveryTelemetry => {
    let withWebsiteCount = 0;
    let verifiedNoWebsiteCount = 0;
    let needsVerificationCount = 0;

    for (const item of items) {
      if (matchesWebsiteFilterGroup(item, 'has_website')) {
        withWebsiteCount += 1;
      } else if (matchesWebsiteFilterGroup(item, 'missing_verified')) {
        verifiedNoWebsiteCount += 1;
      } else {
        needsVerificationCount += 1;
      }
    }

    return {
      ...meta,
      totalDiscovered: items.length,
      withWebsiteCount,
      verifiedNoWebsiteCount,
      needsVerificationCount,
      duplicatesRemovedCount: duplicatesRemoved,
      qualifiedSavedCount: qualifiedSaved,
    };
  };

  const fetchDirectPlaceDetailsBrowser = async (
    placeId: string,
    apiKey: string,
    signal?: AbortSignal
  ): Promise<Record<string, any> | null> => {
    const cleanId = normalizeGooglePlaceId(placeId);
    if (!cleanId || !apiKey) return null;
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
    try {
      const res = await fetch(
        `https://places.googleapis.com/v1/places/${encodeURIComponent(cleanId)}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': fields,
            'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
          },
          signal,
        }
      );
      const parsed = await safeParseHttpResponse<Record<string, any>>(
        res,
        'Google Place Details (New)'
      );
      if (parsed.ok && parsed.data && typeof parsed.data.id === 'string') {
        return parsed.data;
      }
      return null;
    } catch {
      return null;
    }
  };

  const requestPlacesSearchTextPage = async (
    payload: {
      city: string;
      state: string;
      country: string;
      category: string;
      keyword?: string;
      customQuery?: string;
      minRating: number;
      minReviews: number;
      maxResults: number;
      pageToken: string;
      verifyMissingWebsites: boolean;
    },
    signal: AbortSignal
  ): Promise<{
    ok: boolean;
    quotaExceeded: boolean;
    pageTokenExhausted?: boolean;
    places: Array<Partial<LeadRecord> & { leadScore: number }>;
    nextPageToken: string;
    errorMessage?: string;
  }> => {
    const res = await authenticatedFetch('/api/places/search-text', {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
    });

    const parsed = await safeParseHttpResponse<Record<string, any>>(
      res,
      'Google Places Text Search API'
    );

    // If /api/places/search-text returned a 404 plain-text page (e.g. "The page could not be found" on static hosting)
    // and a browser Maps key is available, execute the official Places API (New) Text Search directly.
    if (parsed.isNotFoundPage && mapsBrowserKey.trim()) {
      const locationParts = [payload.city, payload.state, payload.country]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', ');
      const textQuery =
        payload.customQuery?.trim() ||
        (locationParts
          ? `${payload.keyword?.trim() || payload.category} in ${locationParts}`
          : payload.keyword?.trim() || payload.category);

      const directBody: Record<string, unknown> = {
        textQuery,
        pageSize: Math.min(20, Math.max(1, payload.maxResults || 20)),
      };
      if (payload.minRating > 0) {
        directBody.minRating = Math.min(5, Math.max(0, payload.minRating));
      }
      if (payload.pageToken.trim()) {
        directBody.pageToken = payload.pageToken.trim();
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

      const directRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': mapsBrowserKey.trim(),
          'X-Goog-FieldMask': fieldMask,
          'X-Goog-Maps-Solution-ID': 'gmp_mcp_codeassist_v1_aistudio',
        },
        body: JSON.stringify(directBody),
        signal,
      });

      const directParsed = await safeParseHttpResponse<Record<string, any>>(
        directRes,
        'Google Places API (New)'
      );

      if (directParsed.isQuotaExceeded) {
        return {
          ok: false,
          quotaExceeded: true,
          places: [],
          nextPageToken: '',
          errorMessage: directParsed.errorMessage || 'Google Maps Platform quota reached.',
        };
      }

      if (!directParsed.ok) {
        if (payload.pageToken && directParsed.status === 400) {
          return {
            ok: true,
            quotaExceeded: false,
            pageTokenExhausted: true,
            places: [],
            nextPageToken: '',
          };
        }
        return {
          ok: false,
          quotaExceeded: false,
          places: [],
          nextPageToken: '',
          errorMessage:
            directParsed.errorMessage || 'Failed to query Google Places Text Search (New).',
        };
      }

      const rawPlaces: Record<string, any>[] = Array.isArray(directParsed.data?.places)
        ? directParsed.data!.places
        : [];
      const detailsMap = new Map<string, Record<string, any>>();
      if (payload.verifyMissingWebsites && rawPlaces.length > 0) {
        const candidates = rawPlaces.filter((p) => {
          const hasWeb =
            typeof p?.websiteUri === 'string' && /^https?:\/\/.+/i.test(p.websiteUri.trim());
          return !hasWeb;
        });
        const batchDetails = await Promise.all(
          candidates.map(async (p) => {
            const pid = typeof p?.id === 'string' ? p.id : '';
            if (!pid) return null;
            const det = await fetchDirectPlaceDetailsBrowser(pid, mapsBrowserKey.trim(), signal);
            return det ? { pid, det } : null;
          })
        );
        for (const item of batchDetails) {
          if (item) detailsMap.set(item.pid, item.det);
        }
      }

      const normalized = rawPlaces
        .map((p) => {
          const pid = typeof p?.id === 'string' ? p.id : '';
          const det = pid ? detailsMap.get(pid) || null : null;
          return validateAndNormalizePlaceRecord(p, {
            city: payload.city,
            state: payload.state,
            country: payload.country,
            category: payload.category,
            placeDetails: det,
            independentVerificationConfirmed: Boolean(det),
          });
        })
        .filter((x): x is NonNullable<typeof x> => Boolean(x));

      return {
        ok: true,
        quotaExceeded: false,
        places: normalized,
        nextPageToken:
          typeof directParsed.data?.nextPageToken === 'string'
            ? directParsed.data.nextPageToken
            : '',
      };
    }

    if (parsed.isQuotaExceeded || parsed.status === 429) {
      return {
        ok: false,
        quotaExceeded: true,
        places: [],
        nextPageToken: '',
        errorMessage: parsed.errorMessage || 'Google Maps Platform quota reached.',
      };
    }

    if (!parsed.ok || !parsed.data) {
      return {
        ok: false,
        quotaExceeded: false,
        places: [],
        nextPageToken: '',
        errorMessage:
          parsed.errorMessage || 'Failed to search Google Places Text Search API.',
      };
    }

    return {
      ok: true,
      quotaExceeded: false,
      pageTokenExhausted: Boolean(parsed.data.pageTokenExhausted),
      places: Array.isArray(parsed.data.places) ? parsed.data.places : [],
      nextPageToken:
        typeof parsed.data.nextPageToken === 'string' ? parsed.data.nextPageToken : '',
    };
  };

  const handleRunSearch = async (e?: React.FormEvent, manualPageToken = '') => {
    if (e) e.preventDefault();

    // 1. Validate the search form
    if (searchMode === 'text' && !city.trim() && !keyword.trim()) {
      setFeedback({ type: 'error', text: 'Please enter a City or Search Keyword to discover leads.' });
      return;
    }
    if (minRating < 0 || minRating > 5) {
      setFeedback({ type: 'error', text: 'Minimum rating must be between 0.0 and 5.0.' });
      return;
    }
    if (minReviews < 0) {
      setFeedback({ type: 'error', text: 'Minimum reviews must be 0 or greater.' });
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setFeedback(null);

    try {
      // Nearby Search single-request path
      if (searchMode === 'nearby') {
        const res = await authenticatedFetch('/api/places/search-nearby', {
          method: 'POST',
          body: JSON.stringify({
            latitude,
            longitude,
            radiusMeters,
            includedTypes: ['beauty_salon', 'spa', 'dentist', 'gym', 'restaurant', 'lodging'],
            maxResults: Math.min(20, maxResults),
            city,
            category,
          }),
          signal: controller.signal,
        });
        const parsedNearby = await safeParseHttpResponse<Record<string, any>>(
          res,
          'Google Places Nearby Search API'
        );

        if (parsedNearby.isQuotaExceeded || parsedNearby.status === 429) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          setFeedback({
            type: 'error',
            text: parsedNearby.errorMessage || 'Google Maps Platform quota reached.',
          });
          setLoading(false);
          return;
        }
        if (!parsedNearby.ok || !parsedNearby.data) {
          throw new Error(
            parsedNearby.errorMessage || 'Failed to search Google Places Nearby.'
          );
        }

        const fetched: Array<Partial<LeadRecord> & { leadScore: number }> = Array.isArray(
          parsedNearby.data.places
        )
          ? parsedNearby.data.places
          : [];
        setResults(fetched);
        setNextPageToken('');
        setTelemetry(
          computeTelemetryCounts(fetched, 0, 0, {
            isRunning: false,
            cancelled: false,
            currentQueryIndex: 1,
            totalQueriesPlanned: 1,
            currentQueryText: `Nearby Search (${latitude.toFixed(3)}, ${longitude.toFixed(3)})`,
            pagesFetched: 1,
          })
        );
        setFeedback({
          type: 'success',
          text: `Discovered ${fetched.length} nearby businesses via Google Places API (New).`,
        });
        setLoading(false);
        return;
      }

      // Manual single next-page fetch if triggered via "Load Next Page" button
      if (manualPageToken) {
        const pageRes = await requestPlacesSearchTextPage(
          {
            city,
            state,
            country,
            category,
            keyword,
            minRating,
            minReviews,
            maxResults: 20,
            pageToken: manualPageToken,
            verifyMissingWebsites: true,
          },
          controller.signal
        );
        if (pageRes.quotaExceeded) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          setFeedback({
            type: 'error',
            text: pageRes.errorMessage || 'Google Maps Platform quota reached.',
          });
          setLoading(false);
          return;
        }
        if (!pageRes.ok) {
          throw new Error(pageRes.errorMessage || 'Failed to fetch next page from Google Places.');
        }
        const fetched = pageRes.places;
        const existingPlaceIds = new Set(
          results.map((r) => normalizeGooglePlaceId(r.googlePlaceId)).filter(Boolean)
        );
        const dedupedNew = fetched.filter((item: Partial<LeadRecord>) => {
          const pid = normalizeGooglePlaceId(item.googlePlaceId);
          return pid && !existingPlaceIds.has(pid);
        });
        const combined = [...results, ...dedupedNew];
        setResults(combined);
        setNextPageToken(pageRes.nextPageToken || '');
        setLoading(false);
        return;
      }

      // 2. Automatic Multi-Query + Pagination Discovery Engine (up to 20, 50, or 100 unique leads)
      // Google Places Text Search returns max 20 results/page and up to 60 across pages per query.
      const activeCategories = Array.from(new Set([category, ...additionalCategories]));
      const queryPlan = buildDiscoveryQueryPlan({
        city,
        state,
        country,
        categories: activeCategories,
        category,
        keyword,
        targetCount: maxResults,
      });

      const seenPlaceIds = new Set<string>();
      const crmPlaceIds = new Set<string>(
        existingLeads
          .map((l) => normalizeGooglePlaceId(l.googlePlaceId))
          .filter(Boolean)
      );

      let accumulated: Array<Partial<LeadRecord> & { leadScore: number }> = [];
      let duplicatesRemoved = 0;
      let qualifiedSaved = 0;
      let pagesFetched = 0;
      let lastNextPageToken = '';

      setResults([]);
      setTelemetry({
        isRunning: true,
        cancelled: false,
        currentQueryIndex: 1,
        totalQueriesPlanned: queryPlan.length,
        currentQueryText: queryPlan[0]?.query || `${category} in ${city}`,
        pagesFetched: 0,
        totalDiscovered: 0,
        withWebsiteCount: 0,
        verifiedNoWebsiteCount: 0,
        needsVerificationCount: 0,
        duplicatesRemovedCount: 0,
        qualifiedSavedCount: 0,
      });

      outerLoop: for (let qIdx = 0; qIdx < queryPlan.length; qIdx++) {
        if (controller.signal.aborted) break;
        if (accumulated.length >= maxResults) break;

        const planned = queryPlan[qIdx];
        let currentPageToken = '';
        // Up to 3 pages per query (max 60 results per query)
        for (let pageNum = 0; pageNum < 3; pageNum++) {
          if (controller.signal.aborted) break outerLoop;
          if (accumulated.length >= maxResults) break outerLoop;

          // When fetching page 2 or 3 with nextPageToken, wait briefly for Google Places token readiness
          if (pageNum > 0 && currentPageToken) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            if (controller.signal.aborted) break outerLoop;
          }

          setTelemetry(
            computeTelemetryCounts(accumulated, duplicatesRemoved, qualifiedSaved, {
              isRunning: true,
              cancelled: false,
              currentQueryIndex: qIdx + 1,
              totalQueriesPlanned: queryPlan.length,
              currentQueryText: `${planned.query}${pageNum > 0 ? ` (Page ${pageNum + 1})` : ''}`,
              pagesFetched,
            })
          );

          const pageResult = await requestPlacesSearchTextPage(
            {
              city,
              state,
              country,
              category: planned.category,
              customQuery: planned.query,
              minRating,
              minReviews,
              maxResults: 20,
              pageToken: currentPageToken,
              verifyMissingWebsites: true,
            },
            controller.signal
          );

          if (pageResult.quotaExceeded) {
            window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
            setFeedback({
              type: 'error',
              text: pageResult.errorMessage || 'Google Maps Platform quota reached.',
            });
            break outerLoop;
          }

          if (!pageResult.ok) {
            // If a secondary page token or sub-query fails after we already have results, advance cleanly
            if (accumulated.length > 0) {
              break;
            }
            throw new Error(pageResult.errorMessage || 'Failed to search Google Places.');
          }

          if (pageResult.pageTokenExhausted) {
            break;
          }

          pagesFetched += 1;
          const pagePlaces = pageResult.places;

          const newlyEligibleToSave: Array<Partial<LeadRecord> & { leadScore: number }> = [];

          for (const item of pagePlaces) {
            if (accumulated.length >= maxResults) break;

            const pid = normalizeGooglePlaceId(item.googlePlaceId);
            if (!pid) continue;

            // Deduplicate by Google Place ID across pages/queries
            if (seenPlaceIds.has(pid)) {
              duplicatesRemoved += 1;
              continue;
            }
            seenPlaceIds.add(pid);

            const isAlreadyInCrm = crmPlaceIds.has(pid);
            if (isAlreadyInCrm) {
              duplicatesRemoved += 1;
            }

            accumulated.push(item);

            // Check if eligible to auto-save to Supabase/CRM
            const meetsRatingAndReviews =
              (item.rating || 0) >= minRating && (item.reviewCount || 0) >= minReviews;
            const matchesSelectedWebsiteFilter = matchesWebsiteFilterGroup(item, websiteFilter);

            if (meetsRatingAndReviews && matchesSelectedWebsiteFilter && !isAlreadyInCrm) {
              newlyEligibleToSave.push(item);
            }
          }

          // Save eligible leads to Supabase / CRM database
          for (const eligibleLead of newlyEligibleToSave) {
            if (controller.signal.aborted) break;
            const saveRes = await onSaveLead(eligibleLead);
            if (saveRes.saved) {
              qualifiedSaved += 1;
              const savedPid = normalizeGooglePlaceId(eligibleLead.googlePlaceId);
              if (savedPid) crmPlaceIds.add(savedPid);
            } else {
              duplicatesRemoved += 1;
            }
          }

          setResults([...accumulated]);
          lastNextPageToken = pageResult.nextPageToken || '';
          setNextPageToken(lastNextPageToken);

          setTelemetry(
            computeTelemetryCounts(accumulated, duplicatesRemoved, qualifiedSaved, {
              isRunning: true,
              cancelled: false,
              currentQueryIndex: qIdx + 1,
              totalQueriesPlanned: queryPlan.length,
              currentQueryText: planned.query,
              pagesFetched,
            })
          );

          if (!lastNextPageToken || pagePlaces.length === 0) {
            break;
          }
          currentPageToken = lastNextPageToken;
        }
      }

      const wasCancelled = controller.signal.aborted;
      const finalTelemetry = computeTelemetryCounts(
        accumulated,
        duplicatesRemoved,
        qualifiedSaved,
        {
          isRunning: false,
          cancelled: wasCancelled,
          currentQueryIndex: queryPlan.length,
          totalQueriesPlanned: queryPlan.length,
          currentQueryText: wasCancelled ? 'Discovery cancelled by user' : 'Discovery complete',
          pagesFetched,
        }
      );
      setTelemetry(finalTelemetry);

      setFeedback({
        type: wasCancelled ? 'info' : 'success',
        text: wasCancelled
          ? `Discovery stopped: ${finalTelemetry.totalDiscovered} unique businesses discovered (${finalTelemetry.verifiedNoWebsiteCount} verified no-website, ${finalTelemetry.needsVerificationCount} unverified, ${finalTelemetry.qualifiedSavedCount} saved to CRM).`
          : `Discovery complete across ${pagesFetched} page(s): ${finalTelemetry.totalDiscovered} unique businesses found (${finalTelemetry.withWebsiteCount} with websites, ${finalTelemetry.verifiedNoWebsiteCount} verified no-website, ${finalTelemetry.needsVerificationCount} unverified), ${finalTelemetry.duplicatesRemovedCount} duplicates removed, and ${finalTelemetry.qualifiedSavedCount} qualified leads saved to Supabase CRM.`,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setFeedback({
          type: 'info',
          text: 'Lead discovery was cancelled.',
        });
      } else {
        setFeedback({
          type: 'error',
          text: err.message || 'Google Places API search failed.',
        });
      }
      setTelemetry((prev) => ({
        ...prev,
        isRunning: false,
        cancelled: err?.name === 'AbortError',
      }));
    } finally {
      setLoading(false);
    }
  };

  const handleInspectPlaceDetails = async (placeId?: string) => {
    if (!placeId) return;
    setLoadingDetailsId(placeId);
    try {
      const res = await authenticatedFetch(`/api/places/details/${encodeURIComponent(placeId)}`);
      const parsed = await safeParseHttpResponse<Record<string, any>>(
        res,
        'Google Place Details API'
      );

      let placeData: Record<string, any> | null = null;
      if (parsed.isNotFoundPage && mapsBrowserKey.trim()) {
        placeData = await fetchDirectPlaceDetailsBrowser(placeId, mapsBrowserKey.trim());
      } else {
        if (parsed.isQuotaExceeded || parsed.status === 429) {
          window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
          setFeedback({ type: 'error', text: 'Google Maps Platform quota reached.' });
          return;
        }
        if (!parsed.ok || !parsed.data?.place) {
          throw new Error(parsed.errorMessage || 'Place details request failed.');
        }
        placeData = parsed.data.place;
      }

      if (!placeData) {
        throw new Error('Could not retrieve Place Details for this business.');
      }

      setInspectingPlace(placeData);

      // Update the item's verification status from Place Details
      const hasDetailsWebsite =
        typeof placeData.websiteUri === 'string' &&
        /^https?:\/\/.+/i.test(placeData.websiteUri.trim());
      const hasDetailsPhone = Boolean(
        (typeof placeData.internationalPhoneNumber === 'string' &&
          placeData.internationalPhoneNumber.trim()) ||
          (typeof placeData.nationalPhoneNumber === 'string' &&
            placeData.nationalPhoneNumber.trim())
      );
      const isOperational =
        String(placeData.businessStatus || 'OPERATIONAL').toUpperCase() === 'OPERATIONAL';

      setResults((prev) => {
        const nextList = prev.map((item) => {
          if (normalizeGooglePlaceId(item.googlePlaceId) !== normalizeGooglePlaceId(placeId)) {
            return item;
          }
          const nextWebsiteStatus: WebsiteStatus = hasDetailsWebsite
            ? 'modern_verified'
            : isOperational && (hasDetailsPhone || Boolean(item.phone?.trim()))
            ? 'missing_verified'
            : 'unverified';
          const updated: Partial<LeadRecord> = {
            ...item,
            websiteUrl: hasDetailsWebsite ? placeData!.websiteUri.trim() : '',
            websiteStatus: nextWebsiteStatus,
            verificationStatus: nextWebsiteStatus === 'unverified' ? 'needs_review' : 'verified',
            lastVerifiedAt: new Date().toISOString(),
          };
          const { totalScore } = calculateLeadScore(updated);
          return { ...updated, leadScore: totalScore };
        });

        setTelemetry((prevTel) =>
          computeTelemetryCounts(
            nextList,
            prevTel.duplicatesRemovedCount,
            prevTel.qualifiedSavedCount,
            {
              isRunning: prevTel.isRunning,
              cancelled: prevTel.cancelled,
              currentQueryIndex: prevTel.currentQueryIndex,
              totalQueriesPlanned: prevTel.totalQueriesPlanned,
              currentQueryText: prevTel.currentQueryText,
              pagesFetched: prevTel.pagesFetched,
            }
          )
        );
        return nextList;
      });
    } catch (err: any) {
      setFeedback({ type: 'error', text: err.message });
    } finally {
      setLoadingDetailsId(null);
    }
  };

  const handleUpdateResultWebsiteStatus = (
    googlePlaceId: string | undefined,
    fallbackIndex: number,
    newStatus: WebsiteStatus
  ) => {
    setResults((prev) => {
      const nextList = prev.map((item, idx) => {
        const matches = googlePlaceId
          ? normalizeGooglePlaceId(item.googlePlaceId) === normalizeGooglePlaceId(googlePlaceId)
          : idx === fallbackIndex;
        if (!matches) return item;
        const updated: Partial<LeadRecord> = {
          ...item,
          websiteStatus: newStatus,
          verificationStatus: newStatus === 'unverified' ? 'needs_review' : 'verified',
          hasOnlineBooking: newStatus === 'modern_verified' ? true : item.hasOnlineBooking,
          lastVerifiedAt: new Date().toISOString(),
        };
        const { totalScore } = calculateLeadScore(updated);
        return { ...updated, leadScore: totalScore };
      });

      if (telemetry) {
        setTelemetry(
          computeTelemetryCounts(
            nextList,
            telemetry.duplicatesRemovedCount,
            telemetry.qualifiedSavedCount,
            {
              isRunning: telemetry.isRunning,
              cancelled: telemetry.cancelled,
              currentQueryIndex: telemetry.currentQueryIndex,
              totalQueriesPlanned: telemetry.totalQueriesPlanned,
              currentQueryText: telemetry.currentQueryText,
              pagesFetched: telemetry.pagesFetched,
            }
          )
        );
      }
      return nextList;
    });
  };

  const handleToggleResultVerification = (
    googlePlaceId: string | undefined,
    fallbackIndex: number,
    field: 'missingBookingVerified' | 'premiumVerified',
    checked: boolean
  ) => {
    setResults((prev) =>
      prev.map((item, idx) => {
        const matches = googlePlaceId
          ? normalizeGooglePlaceId(item.googlePlaceId) === normalizeGooglePlaceId(googlePlaceId)
          : idx === fallbackIndex;
        if (!matches) return item;

        const existingTags = (item.tags || '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

        let nextTags = [...existingTags];
        let nextHasOnlineBooking = item.hasOnlineBooking;
        let nextIsPremium = item.isPremiumService;

        if (field === 'missingBookingVerified') {
          nextTags = nextTags.filter((t) => t !== 'booking-verified' && t !== 'no-booking');
          if (checked) {
            nextTags.push('booking-verified');
            nextHasOnlineBooking = false;
          }
        } else if (field === 'premiumVerified') {
          nextTags = nextTags.filter((t) => t !== 'premium-verified');
          if (checked) {
            nextTags.push('premium-verified');
            nextIsPremium = true;
          } else {
            nextIsPremium = false;
          }
        }

        const updated: Partial<LeadRecord> = {
          ...item,
          hasOnlineBooking: nextHasOnlineBooking,
          isPremiumService: nextIsPremium,
          tags: nextTags.join(','),
          lastVerifiedAt: new Date().toISOString(),
        };
        const { totalScore } = calculateLeadScore(updated);
        return { ...updated, leadScore: totalScore };
      })
    );
  };

  const handleSaveSingle = async (item: Partial<LeadRecord>) => {
    const res = await onSaveLead(item);
    if (res.saved && telemetry) {
      setTelemetry({
        ...telemetry,
        qualifiedSavedCount: telemetry.qualifiedSavedCount + 1,
      });
    }
    setFeedback({
      type: res.saved ? 'success' : 'error',
      text: res.message,
    });
  };

  // Strict Website Filter & Rating/Review threshold matching
  // Only show verified no-website businesses when "No Website – Verified" ('missing_verified') is selected.
  const filteredResults = results.filter((r) => {
    if (!matchesWebsiteFilterGroup(r, websiteFilter)) return false;
    if ((r.rating || 0) < minRating) return false;
    if ((r.reviewCount || 0) < minReviews) return false;
    return true;
  });

  const handleSaveAllFiltered = async () => {
    let savedCount = 0;
    let skippedCount = 0;
    for (const item of filteredResults) {
      const res = await onSaveLead(item);
      if (res.saved) savedCount++;
      else skippedCount++;
    }
    if (savedCount > 0 && telemetry) {
      setTelemetry({
        ...telemetry,
        qualifiedSavedCount: telemetry.qualifiedSavedCount + savedCount,
      });
    }
    setFeedback({
      type: savedCount > 0 ? 'success' : 'info',
      text: `Saved ${savedCount} new leads to CRM (${skippedCount} duplicates skipped).`,
    });
  };

  const mapCenter =
    filteredResults.find((r) => typeof r.lat === 'number' && typeof r.lng === 'number')
      ? {
          lat: Number(filteredResults[0].lat),
          lng: Number(filteredResults[0].lng),
        }
      : { lat: latitude, lng: longitude };

  return (
    <div className="space-y-6">
      {/* Compliance & Discovery Mode Bar */}
      <section className="rounded-xl border border-slate-800/80 bg-[#111827] p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>Google Places API (New)</span>
              <span aria-hidden="true">·</span>
              <span>Multi-Query + Pagination (Max 20/page, 60/query)</span>
              <span aria-hidden="true">·</span>
              <span>Place Details Website Verification</span>
            </div>
            <h2 className="text-lg font-semibold text-white">
              Local Business Lead Discovery Engine
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Search Mode Toggle */}
            <div className="flex items-center gap-1 rounded-lg bg-slate-900 p-1 border border-slate-800">
              <button
                type="button"
                onClick={() => setSearchMode('text')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  searchMode === 'text'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Text Search (New)
              </button>
              <button
                type="button"
                onClick={() => setSearchMode('nearby')}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                  searchMode === 'nearby'
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Nearby Search (New)
              </button>
            </div>

            <span
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap ${
                placesConfigured
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              }`}
            >
              {placesConfigured ? 'Live Google Places API Connected' : 'Places API Key Required'}
            </span>
          </div>
        </div>

        {/* Discovery Form */}
        <form onSubmit={(e) => handleRunSearch(e)} className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label htmlFor="finder-city" className="block text-xs font-medium text-slate-300 mb-1">
              City *
            </label>
            <input
              id="finder-city"
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="e.g., Mumbai, Pune, Bengaluru"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="finder-state" className="block text-xs font-medium text-slate-300 mb-1">
              State
            </label>
            <input
              id="finder-state"
              type="text"
              value={state}
              onChange={(e) => setState(e.target.value)}
              placeholder="e.g., Maharashtra, Karnataka"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="finder-country" className="block text-xs font-medium text-slate-300 mb-1">
              Country
            </label>
            <input
              id="finder-country"
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="India"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="finder-category" className="block text-xs font-medium text-slate-300 mb-1">
              Business Category
            </label>
            <select
              id="finder-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
            >
              {BUSINESS_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="finder-keyword" className="block text-xs font-medium text-slate-300 mb-1">
              Search Keyword (Optional)
            </label>
            <input
              id="finder-keyword"
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="e.g., Bridal studio, Implant clinic"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {searchMode === 'nearby' && (
            <>
              <div>
                <label htmlFor="finder-lat" className="block text-xs font-medium text-slate-300 mb-1">
                  Latitude
                </label>
                <input
                  id="finder-lat"
                  type="number"
                  step="0.0001"
                  value={latitude}
                  onChange={(e) => setLatitude(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="finder-lng" className="block text-xs font-medium text-slate-300 mb-1">
                  Longitude
                </label>
                <input
                  id="finder-lng"
                  type="number"
                  step="0.0001"
                  value={longitude}
                  onChange={(e) => setLongitude(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="finder-radius" className="block text-xs font-medium text-slate-300 mb-1">
                  Radius (Meters)
                </label>
                <input
                  id="finder-radius"
                  type="number"
                  min={500}
                  max={50000}
                  value={radiusMeters}
                  onChange={(e) => setRadiusMeters(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
                />
              </div>
            </>
          )}

          <div>
            <label htmlFor="finder-website-status" className="block text-xs font-medium text-slate-300 mb-1">
              Website Status
            </label>
            <select
              id="finder-website-status"
              value={websiteFilter}
              onChange={(e) => setWebsiteFilter(e.target.value as WebsiteFilterOption)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-white focus:border-blue-500 focus:outline-none"
            >
              <option value="missing_verified">No Website – Verified</option>
              <option value="has_website">Has Website</option>
              <option value="unverified">Unverified – Needs Review</option>
              <option value="all">All Discovered</option>
            </select>
          </div>

          <div>
            <label htmlFor="finder-min-rating" className="block text-xs font-medium text-slate-300 mb-1">
              Minimum Rating
            </label>
            <select
              id="finder-min-rating"
              value={minRating}
              onChange={(e) => setMinRating(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
            >
              <option value={0}>Any Rating</option>
              <option value={3.5}>3.5★ and above</option>
              <option value={4.0}>4.0★ and above</option>
              <option value={4.3}>4.3★ and above</option>
              <option value={4.5}>4.5★ and above (+10 score)</option>
            </select>
          </div>

          <div>
            <label htmlFor="finder-min-reviews" className="block text-xs font-medium text-slate-300 mb-1">
              Minimum Reviews
            </label>
            <input
              id="finder-min-reviews"
              type="number"
              min={0}
              value={minReviews}
              onChange={(e) => setMinReviews(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="finder-daily-target" className="block text-xs font-medium text-slate-300 mb-1">
              Daily Target
            </label>
            <input
              id="finder-daily-target"
              type="number"
              min={10}
              max={500}
              value={dailyTarget}
              onChange={(e) => setDailyTarget(Math.max(1, Number(e.target.value) || 100))}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="finder-max-results" className="block text-xs font-medium text-slate-300 mb-1">
              Maximum Results
            </label>
            <select
              id="finder-max-results"
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-xs text-white focus:border-blue-500 focus:outline-none"
            >
              <option value={20}>20 Leads</option>
              <option value={50}>50 Leads</option>
              <option value={100}>100 Leads</option>
            </select>
          </div>

          {/* Multi-Category Selector Row + Action Buttons */}
          <div className="sm:col-span-2 lg:col-span-4 flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] font-medium text-slate-400 mr-1">
              Multi-Category Expansion:
            </span>
            {BUSINESS_CATEGORIES.slice(0, 7).map((cat) => {
              const isPrimary = cat === category;
              const isExtra = additionalCategories.includes(cat);
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    if (!isPrimary) toggleAdditionalCategory(cat);
                  }}
                  className={`rounded-md border px-2 py-1 text-[11px] transition-colors whitespace-nowrap ${
                    isPrimary
                      ? 'border-blue-500/60 bg-blue-600/20 text-blue-300 font-medium'
                      : isExtra
                      ? 'border-violet-500/50 bg-violet-500/15 text-violet-300'
                      : 'border-slate-800 bg-slate-900/70 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {cat}
                  {isPrimary ? ' (Primary)' : isExtra ? ' ✓' : ' +'}
                </button>
              );
            })}
          </div>

          <div className="flex items-end gap-2">
            {loading ? (
              <button
                type="button"
                onClick={handleCancelDiscovery}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-500 whitespace-nowrap"
              >
                <Square className="h-3.5 w-3.5" />
                Stop Discovery
              </button>
            ) : (
              <button
                type="submit"
                disabled={loading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-50 whitespace-nowrap"
              >
                <Search className="h-3.5 w-3.5" />
                Run Lead Discovery
              </button>
            )}
          </div>
        </form>

        {/* Live Search Progress & 6 Discovery Telemetry Metrics */}
        {telemetry && (
          <div className="mt-5 rounded-xl border border-slate-800 bg-slate-900/70 p-4 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-xs">
                {telemetry.isRunning ? (
                  <Loader2 className="h-4 w-4 animate-spin text-blue-400 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                )}
                <span className="font-semibold text-white">
                  {telemetry.isRunning
                    ? `Running Multi-Query Discovery (Query ${telemetry.currentQueryIndex} of ${telemetry.totalQueriesPlanned} · ${telemetry.pagesFetched} page(s) fetched)`
                    : telemetry.cancelled
                    ? `Discovery Stopped (${telemetry.pagesFetched} page(s) fetched)`
                    : telemetry.pagesFetched > 0
                    ? `Discovery Complete (${telemetry.pagesFetched} page(s) fetched across ${telemetry.totalQueriesPlanned} planned queries)`
                    : `Discovery Telemetry Ready (${telemetry.totalQueriesPlanned} planned queries)`}
                </span>
              </div>
              <span className="font-mono text-xs text-slate-400 truncate max-w-md">
                {telemetry.currentQueryText}
              </span>
            </div>

            {/* Progress Bar */}
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-emerald-500 transition-all duration-300"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(
                      telemetry.isRunning ? 12 : telemetry.pagesFetched > 0 ? 100 : 0,
                      Math.round((telemetry.totalDiscovered / Math.max(1, maxResults)) * 100)
                    )
                  )}%`,
                }}
              />
            </div>

            {/* 6 Required Telemetry Counters */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 pt-1">
              <div className="rounded-lg border border-slate-800/90 bg-[#111827] p-2.5">
                <div className="text-[11px] text-slate-400">Total Discovered</div>
                <div className="mt-0.5 font-mono text-base font-bold text-white tabular-nums">
                  {telemetry.totalDiscovered}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/90 bg-[#111827] p-2.5">
                <div className="text-[11px] text-slate-400">With Websites</div>
                <div className="mt-0.5 font-mono text-base font-bold text-blue-400 tabular-nums">
                  {telemetry.withWebsiteCount}
                </div>
              </div>

              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                <div className="text-[11px] text-amber-300">Unverified</div>
                <div className="mt-0.5 font-mono text-base font-bold text-amber-400 tabular-nums">
                  {telemetry.needsVerificationCount}
                </div>
              </div>

              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                <div className="text-[11px] text-emerald-300">Verified No Website</div>
                <div className="mt-0.5 font-mono text-base font-bold text-emerald-400 tabular-nums">
                  {telemetry.verifiedNoWebsiteCount}
                </div>
              </div>

              <div className="rounded-lg border border-slate-800/90 bg-[#111827] p-2.5">
                <div className="text-[11px] text-slate-400">Duplicates Removed</div>
                <div className="mt-0.5 font-mono text-base font-bold text-slate-300 tabular-nums">
                  {telemetry.duplicatesRemovedCount}
                </div>
              </div>

              <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-2.5">
                <div className="text-[11px] text-violet-300">Qualified Saved</div>
                <div className="mt-0.5 font-mono text-base font-bold text-violet-400 tabular-nums">
                  {telemetry.qualifiedSavedCount}
                </div>
              </div>
            </div>
          </div>
        )}

        {feedback && (
          <div
            className={`mt-4 flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-xs ${
              feedback.type === 'error'
                ? 'border-red-500/40 bg-red-500/10 text-red-200'
                : feedback.type === 'success'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                : 'border-blue-500/40 bg-blue-500/10 text-blue-200'
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
              className="text-xs underline opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}
      </section>

      {/* Interactive Google Map & Compliance Notice */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 rounded-xl border border-slate-800/80 bg-[#111827] overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-800/80 px-5 py-3">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-blue-400" />
              <h3 className="text-sm font-semibold text-white">
                Interactive Prospect Map ({filteredResults.length} matches)
              </h3>
            </div>
            <span className="text-xs text-slate-400">
              Powered by Google Maps Platform
            </span>
          </div>

          <div className="h-[340px] w-full bg-slate-900 relative">
            {mapsBrowserKey ? (
              <APIProvider apiKey={mapsBrowserKey}>
                <GoogleMap
                  mapId="DEMO_MAP_ID"
                  internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
                  defaultCenter={mapCenter}
                  center={mapCenter}
                  defaultZoom={12}
                  gestureHandling="greedy"
                  className="h-full w-full"
                >
                  {filteredResults.map((place, idx) =>
                    typeof place.lat === 'number' && typeof place.lng === 'number' ? (
                      <AdvancedMarker
                        key={place.googlePlaceId || idx}
                        position={{ lat: place.lat, lng: place.lng }}
                        onClick={() => setSelectedMarkerIdx(idx)}
                      />
                    ) : null
                  )}

                  {selectedMarkerIdx !== null &&
                    filteredResults[selectedMarkerIdx] &&
                    typeof filteredResults[selectedMarkerIdx].lat === 'number' &&
                    typeof filteredResults[selectedMarkerIdx].lng === 'number' && (
                      <InfoWindow
                        position={{
                          lat: Number(filteredResults[selectedMarkerIdx].lat),
                          lng: Number(filteredResults[selectedMarkerIdx].lng),
                        }}
                        onCloseClick={() => setSelectedMarkerIdx(null)}
                      >
                        <div className="p-1 text-slate-900 max-w-[220px] space-y-1">
                          <p className="text-xs font-bold">
                            {filteredResults[selectedMarkerIdx].businessName}
                          </p>
                          <p className="text-[11px] text-slate-600">
                            {filteredResults[selectedMarkerIdx].address}
                          </p>
                          <p className="text-[11px] font-mono font-semibold text-blue-700">
                            Score: {filteredResults[selectedMarkerIdx].leadScore}/100 ·{' '}
                            {filteredResults[selectedMarkerIdx].rating}★
                          </p>
                        </div>
                      </InfoWindow>
                    )}
                </GoogleMap>
              </APIProvider>
            ) : (
              <div className="flex h-full flex-col items-center justify-center p-6 text-center">
                <Globe className="h-8 w-8 text-blue-400 mb-2" />
                <p className="text-sm font-medium text-white">
                  Interactive Coordinate Preview ({mapCenter.lat.toFixed(4)}, {mapCenter.lng.toFixed(4)})
                </p>
                <p className="mt-1 max-w-md text-xs text-slate-400">
                  Run Lead Discovery above to plot discovered businesses and inspect their Google Maps URIs and Place IDs.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Google Maps Platform Terms & Verification Guardrails */}
        <div className="rounded-xl border border-slate-800/80 bg-[#111827] p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-emerald-400">
              <ShieldCheck className="h-4 w-4" />
              <h3 className="text-sm font-semibold text-white">
                Place Details Website Verification
              </h3>
            </div>
            <ul className="space-y-2 text-xs text-slate-400 leading-relaxed">
              <li>
                1. <strong className="text-slate-200">Place Details (New) Check:</strong> Queries <code className="font-mono text-slate-300">websiteUri</code> via Place Details FieldMask before classifying any business as <strong className="text-emerald-300">No Website – Verified</strong>.
              </li>
              <li>
                2. <strong className="text-slate-200">Multi-Query Pagination:</strong> Google Places returns up to 20 leads/page (60/query). LeadPilot runs multiple relevant queries + <code className="font-mono text-slate-300">nextPageToken</code> to reach up to 100 unique leads.
              </li>
              <li>
                3. <strong className="text-slate-200">Duplicate Protection:</strong> Automatically deduplicates across pages, queries, and existing Supabase CRM records by <code className="font-mono text-slate-300">google_place_id</code>.
              </li>
            </ul>
          </div>

          {inspectingPlace && (
            <div className="rounded-lg border border-blue-500/30 bg-slate-900 p-3.5 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-blue-300">
                  Place Details Inspector
                </span>
                <button
                  type="button"
                  onClick={() => setInspectingPlace(null)}
                  className="text-[11px] text-slate-400 hover:text-white"
                >
                  Close
                </button>
              </div>
              <p className="text-xs font-medium text-white">
                {inspectingPlace.displayName?.text || inspectingPlace.id}
              </p>
              <p className="text-[11px] text-slate-400">{inspectingPlace.formattedAddress}</p>
              <p className="font-mono text-[11px] text-slate-300">
                Place ID: {inspectingPlace.id}
              </p>
              <p className="text-[11px] text-slate-300">
                Website URI: {inspectingPlace.websiteUri || 'None registered (Verified No Website)'}
              </p>
              <p className="text-[11px] text-slate-300">
                Status: {inspectingPlace.businessStatus || 'OPERATIONAL'}
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Discovered Results Table */}
      <section className="rounded-xl border border-slate-800/80 bg-[#111827] overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-800/80 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Discovered Business Prospects ({filteredResults.length} matching filter / {results.length} total unique)
            </h3>
            <p className="text-xs text-slate-400">
              Showing filter:{' '}
              <span className="font-medium text-slate-200">
                {websiteFilter === 'missing_verified'
                  ? 'No Website – Verified'
                  : websiteFilter === 'has_website'
                  ? 'Has Website'
                  : websiteFilter === 'unverified'
                  ? 'Unverified – Needs Review'
                  : 'All Discovered'}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {results.length > 0 && filteredResults.length === 0 && websiteFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setWebsiteFilter('all')}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
              >
                Show All {results.length} Discovered
              </button>
            )}
            {nextPageToken && !loading && (
              <button
                type="button"
                disabled={loading}
                onClick={() => handleRunSearch(undefined, nextPageToken)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 whitespace-nowrap"
              >
                Load Next Page
              </button>
            )}
            {filteredResults.length > 0 && (
              <button
                type="button"
                onClick={handleSaveAllFiltered}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5" />
                Save All {filteredResults.length} to CRM
              </button>
            )}
          </div>
        </div>

        {loading && results.length === 0 ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-12 w-full animate-pulse rounded-lg bg-slate-800/60" />
            ))}
          </div>
        ) : filteredResults.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-slate-300">
              {results.length > 0
                ? `0 of ${results.length} discovered businesses match the current "${
                    websiteFilter === 'missing_verified'
                      ? 'No Website – Verified'
                      : websiteFilter === 'has_website'
                      ? 'Has Website'
                      : 'Unverified – Needs Review'
                  }" filter (Min ${minRating}★, ${minReviews}+ reviews).`
                : 'No discovered businesses loaded yet. Click "Run Lead Discovery" above to query Google Places API (New).'}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => handleRunSearch()}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
              >
                <Search className="h-3.5 w-3.5" />
                Discover Leads in {city || 'Mumbai'}
              </button>
              {results.length > 0 && websiteFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setWebsiteFilter('all')}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
                >
                  View All {results.length} Discovered Leads
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] font-medium text-slate-400">
                  <th className="py-3 px-4">Business & Place ID</th>
                  <th className="py-3 px-4">Address, Phone & Maps</th>
                  <th className="py-3 px-4 text-right">Rating / Reviews</th>
                  <th className="py-3 px-4">Official Website & Verification</th>
                  <th className="py-3 px-4 text-right">Lead Score</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-xs">
                {filteredResults.map((item, idx) => {
                  const dup = detectDuplicateLead(item, existingLeads);
                  const scoreBreakdown = calculateLeadScore(item);
                  const displayScore = scoreBreakdown.totalScore;
                  const missingBookingReason = scoreBreakdown.reasons.find(
                    (r) => r.key === 'online_booking'
                  );
                  const premiumReason = scoreBreakdown.reasons.find(
                    (r) => r.key === 'premium_services'
                  );
                  return (
                    <tr key={item.googlePlaceId || idx} className="hover:bg-slate-800/30">
                      <td className="py-3 px-4">
                        <div className="font-medium text-white">{item.businessName}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                          <span>{item.category}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{item.googlePlaceId || 'manual'}</span>
                        </div>
                      </td>

                      <td className="py-3 px-4 max-w-[260px]">
                        <div className="truncate text-slate-300">{item.address || item.city}</div>
                        {item.phone && (
                          <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                            {item.phone}
                          </div>
                        )}
                        <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                          {item.googleMapsUrl && (
                            <a
                              href={item.googleMapsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-blue-400 hover:underline"
                            >
                              Google Maps <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {item.googlePlaceId && (
                            <button
                              type="button"
                              onClick={() => handleInspectPlaceDetails(item.googlePlaceId)}
                              className="text-slate-400 hover:text-white underline"
                            >
                              {loadingDetailsId === item.googlePlaceId ? 'Verifying...' : 'Place Details'}
                            </button>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4 text-right font-mono tabular-nums">
                        <div className="text-white">{(item.rating || 0).toFixed(1)}★</div>
                        <div className="text-[11px] text-slate-400">
                          {(item.reviewCount || 0).toLocaleString()} reviews
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div className="space-y-1.5">
                          {item.websiteUrl ? (
                            <a
                              href={item.websiteUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-blue-400 hover:underline truncate max-w-[200px]"
                            >
                              {item.websiteUrl}
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                          ) : item.websiteStatus === 'missing_verified' ? (
                            <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                              No Website – Verified (Place Details)
                            </span>
                          ) : (
                            <span className="text-amber-300">
                              Unverified – Needs Review
                            </span>
                          )}
                          <div>
                            <select
                              aria-label={`Verify website status for ${item.businessName}`}
                              value={item.websiteStatus || 'unverified'}
                              onChange={(e) =>
                                handleUpdateResultWebsiteStatus(
                                  item.googlePlaceId,
                                  idx,
                                  e.target.value as WebsiteStatus
                                )
                              }
                              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 focus:border-blue-500 focus:outline-none"
                            >
                              <option value="missing_verified">No Website – Verified (+30 pts)</option>
                              <option value="modern_verified">Has Website (0 pts)</option>
                              <option value="outdated_verified">Has Outdated Website (+20 pts)</option>
                              <option value="unverified">Unverified – Needs Review (0 pts)</option>
                            </select>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 pt-0.5 text-[11px] text-slate-400">
                            <label className="inline-flex items-center gap-1.5 cursor-pointer hover:text-slate-200">
                              <input
                                type="checkbox"
                                checked={Boolean(missingBookingReason?.met)}
                                onChange={(e) =>
                                  handleToggleResultVerification(
                                    item.googlePlaceId,
                                    idx,
                                    'missingBookingVerified',
                                    e.target.checked
                                  )
                                }
                                className="rounded border-slate-700 bg-slate-900 text-blue-600"
                              />
                              <span>Verify No Booking (+15)</span>
                            </label>
                            <label className="inline-flex items-center gap-1.5 cursor-pointer hover:text-slate-200">
                              <input
                                type="checkbox"
                                checked={Boolean(premiumReason?.met)}
                                onChange={(e) =>
                                  handleToggleResultVerification(
                                    item.googlePlaceId,
                                    idx,
                                    'premiumVerified',
                                    e.target.checked
                                  )
                                }
                                className="rounded border-slate-700 bg-slate-900 text-blue-600"
                              />
                              <span>Verify Premium (+10)</span>
                            </label>
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-4 text-right font-mono tabular-nums min-w-[230px]">
                        <div>
                          <span
                            className={`text-sm font-semibold ${
                              displayScore >= 75
                                ? 'text-emerald-400'
                                : displayScore >= 55
                                ? 'text-amber-400'
                                : 'text-slate-400'
                            }`}
                          >
                            {displayScore}/100
                          </span>
                          <span className="ml-1.5 font-sans text-[11px] text-slate-400">
                            ({scoreBreakdown.priority})
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap justify-end gap-1 font-sans">
                          {scoreBreakdown.reasons.map((r) => (
                            <span
                              key={r.key}
                              title={r.explanation}
                              className={`rounded border px-1.5 py-0.5 text-[10px] ${
                                r.met
                                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                                  : 'border-slate-800 bg-slate-900/60 text-slate-500'
                              }`}
                            >
                              {r.label}: {r.met ? `+${r.points}` : '0'}
                            </span>
                          ))}
                        </div>
                      </td>

                      <td className="py-3 px-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {dup.isDuplicate ? (
                            <span className="text-[11px] text-emerald-400 font-medium">
                              Saved in CRM
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleSaveSingle(item)}
                              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500 whitespace-nowrap"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              Save Lead
                            </button>
                          )}
                          {dup.matchedLead && (
                            <button
                              type="button"
                              onClick={() => onSelectLeadForResearch(dup.matchedLead!)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700 whitespace-nowrap"
                            >
                              <Sparkles className="h-3 w-3 text-violet-400" />
                              Research
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
