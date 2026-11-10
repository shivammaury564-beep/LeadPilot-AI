import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../../server';

function startTestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}

test('API Security: Unauthorized requests to protected endpoints are rejected with 401', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const protectedEndpoints: Array<{ method: string; path: string }> = [
      { method: 'GET', path: '/api/crm/workspace' },
      { method: 'POST', path: '/api/crm/leads' },
      { method: 'POST', path: '/api/crm/messages' },
      { method: 'POST', path: '/api/crm/followups' },
      { method: 'PUT', path: '/api/crm/profile' },
      { method: 'GET', path: '/api/crm/export' },
      { method: 'POST', path: '/api/places/search-text' },
      { method: 'POST', path: '/api/places/search-nearby' },
      { method: 'GET', path: '/api/places/details/ChIJ_test' },
      { method: 'POST', path: '/api/ai/research' },
      { method: 'POST', path: '/api/ai/generate-dms' },
      { method: 'POST', path: '/api/extension/capture' },
    ];

    for (const ep of protectedEndpoints) {
      const res = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json' },
        body: ep.method === 'POST' || ep.method === 'PUT' ? JSON.stringify({}) : undefined,
      });
      assert.equal(
        res.status,
        401,
        `Expected 401 Unauthorized for unauthenticated ${ep.method} ${ep.path}, got ${res.status}`
      );
    }

    // Also test forged/invalid Bearer token
    const invalidTokenRes = await fetch(`${baseUrl}/api/crm/workspace`, {
      headers: { Authorization: 'Bearer forged.invalid.token' },
    });
    assert.equal(invalidTokenRes.status, 401);
  } finally {
    await close();
  }
});

test('API Security: /api/integrations/status never leaks raw API keys or service-role secrets', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/integrations/status`);
    assert.equal(res.status, 200);
    const bodyText = await res.text();
    const data = JSON.parse(bodyText);

    assert.equal(typeof data.googlePlaces?.configured, 'boolean');
    assert.equal(data.googlePlaces?.mapsBrowserKey, undefined);
    assert.ok(!bodyText.includes('AIza'));
    assert.ok(!bodyText.includes('service_role'));
  } finally {
    await close();
  }
});

test('Authentication, Cross-User Data Isolation (RLS), Duplicate Detection, and Opt-Out Lock', async () => {
  const { baseUrl, close } = await startTestServer();
  try {
    const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const userAEmail = `tenant_a_${uniqueSuffix}@agency-test.io`;
    const userBEmail = `tenant_b_${uniqueSuffix}@agency-test.io`;

    // 1. Register User A
    const regARes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: userAEmail,
        password: 'SecurePasswordA!123',
        fullName: 'Tenant A Founder',
        agencyName: 'Alpha Web Agency',
      }),
    });
    assert.equal(regARes.status, 201);
    const sessionA = await regARes.json();
    assert.ok(sessionA.accessToken);
    const headersA = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionA.accessToken}`,
    };

    // 2. Register User B
    const regBRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: userBEmail,
        password: 'SecurePasswordB!123',
        fullName: 'Tenant B Founder',
        agencyName: 'Beta Digital Studio',
      }),
    });
    assert.equal(regBRes.status, 201);
    const sessionB = await regBRes.json();
    assert.ok(sessionB.accessToken);
    const headersB = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sessionB.accessToken}`,
    };

    // 3. User A creates a high-priority lead
    const createLeadRes = await fetch(`${baseUrl}/api/crm/leads`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        businessName: 'Celeste Luxury Salon',
        category: 'Premium salons',
        city: 'Mumbai',
        phone: '+91 98209 55443',
        websiteStatus: 'missing_verified',
        verificationStatus: 'verified',
        instagramUrl: 'https://instagram.com/celesteluxurysalon',
        googlePlaceId: `ChIJ_celeste_${uniqueSuffix}`,
        rating: 4.8,
        reviewCount: 95,
      }),
    });
    assert.equal(createLeadRes.status, 201);
    const createdLeadData = await createLeadRes.json();
    const leadAId: string = createdLeadData.lead.id;
    assert.equal(createdLeadData.lead.leadScore, 90);

    // 3b. Updating lead fields recalculates leadScore in the database
    const updateScoreRes = await fetch(`${baseUrl}/api/crm/leads/${encodeURIComponent(leadAId)}`, {
      method: 'PUT',
      headers: headersA,
      body: JSON.stringify({
        rating: 4.2,
        reviewCount: 30,
      }),
    });
    assert.equal(updateScoreRes.status, 200);
    const updatedLeadData = await updateScoreRes.json();
    assert.equal(updatedLeadData.lead.leadScore, 70);

    // 4. Duplicate lead detection blocks User A from re-adding the same lead (409 Conflict)
    const dupRes = await fetch(`${baseUrl}/api/crm/leads`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        businessName: 'Celeste Salon Different Name',
        category: 'Premium salons',
        city: 'Mumbai',
        instagramUrl: '@celesteluxurysalon',
      }),
    });
    assert.equal(dupRes.status, 409);

    // 5. Cross-user data isolation: User B fetches workspace and sees 0 of User A's leads
    const workspaceBRes = await fetch(`${baseUrl}/api/crm/workspace`, {
      headers: headersB,
    });
    assert.equal(workspaceBRes.status, 200);
    const workspaceB = await workspaceBRes.json();
    assert.equal(workspaceB.leads.length, 0);

    // 6. Cross-user data isolation: User B cannot update, delete, or message User A's lead (403 Forbidden)
    const crossUpdateRes = await fetch(`${baseUrl}/api/crm/leads/${encodeURIComponent(leadAId)}`, {
      method: 'PUT',
      headers: headersB,
      body: JSON.stringify({ businessName: 'Hijacked By User B' }),
    });
    assert.equal(crossUpdateRes.status, 403);

    const crossDeleteRes = await fetch(`${baseUrl}/api/crm/leads/${encodeURIComponent(leadAId)}`, {
      method: 'DELETE',
      headers: headersB,
    });
    assert.equal(crossDeleteRes.status, 403);

    const crossMessageRes = await fetch(`${baseUrl}/api/crm/messages`, {
      method: 'POST',
      headers: headersB,
      body: JSON.stringify({
        leadId: leadAId,
        platform: 'instagram',
        messageBody: 'Unauthorized message attempt',
      }),
    });
    assert.equal(crossMessageRes.status, 403);

    // 7. Opt-Out workflow lock: User A marks lead as opted_out
    const optOutRes = await fetch(`${baseUrl}/api/crm/leads/${encodeURIComponent(leadAId)}`, {
      method: 'PUT',
      headers: headersA,
      body: JSON.stringify({ status: 'opted_out' }),
    });
    assert.equal(optOutRes.status, 200);

    // 8. Attempting to move opted-out lead back to 'contacted' is blocked with 409
    const illegalReentryRes = await fetch(
      `${baseUrl}/api/crm/leads/${encodeURIComponent(leadAId)}`,
      {
        method: 'PUT',
        headers: headersA,
        body: JSON.stringify({ status: 'contacted' }),
      }
    );
    assert.equal(illegalReentryRes.status, 409);

    // 9. Attempting to create an outreach draft for an opted-out lead is blocked with 409
    const illegalMsgRes = await fetch(`${baseUrl}/api/crm/messages`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        leadId: leadAId,
        platform: 'instagram',
        messageBody: 'Hi Celeste team!',
        status: 'draft',
      }),
    });
    assert.equal(illegalMsgRes.status, 409);

    // 10. Attempting to generate AI DMs for an opted-out lead is blocked with 409
    const illegalAiDmRes = await fetch(`${baseUrl}/api/ai/generate-dms`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        leadId: leadAId,
        leadStatus: 'opted_out',
        businessName: 'Celeste Luxury Salon',
      }),
    });
    assert.equal(illegalAiDmRes.status, 409);

    // 11. CSV Export for User A excludes the opted-out lead
    const csvExportRes = await fetch(`${baseUrl}/api/crm/export`, {
      headers: headersA,
    });
    assert.equal(csvExportRes.status, 200);
    const csvText = await csvExportRes.text();
    assert.ok(!csvText.includes('Celeste Luxury Salon'));

    // 12. Multi-Query Plan Endpoint generates deduplicated queries for 100 leads
    const planRes = await fetch(`${baseUrl}/api/places/query-plan`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        city: 'Mumbai',
        state: 'Maharashtra',
        country: 'India',
        categories: ['Premium salons', 'Spas'],
        targetCount: 100,
      }),
    });
    assert.equal(planRes.status, 200);
    const planData = await planRes.json();
    assert.equal(planData.maxPerPage, 20);
    assert.equal(planData.maxPerQueryAcrossPages, 60);
    assert.ok(Array.isArray(planData.queries) && planData.queries.length >= 4);

    // 13. Credential Encryption & Decryption Resilience (No unhandled "decryption failed" crash)
    const encRes = await fetch(`${baseUrl}/api/auth/credentials-verify`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ plainText: 'secret-agency-token-xyz' }),
    });
    assert.equal(encRes.status, 200);
    const encData = await encRes.json();
    assert.equal(encData.ok, true);
    assert.ok(encData.cipherText.startsWith('v1:'));

    const decRes = await fetch(`${baseUrl}/api/auth/credentials-verify`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({ cipherText: encData.cipherText }),
    });
    assert.equal(decRes.status, 200);
    const decData = await decRes.json();
    assert.equal(decData.ok, true);

    // Corrupted ciphertext returns clean 400 error message without crashing or overwriting
    const badDecRes = await fetch(`${baseUrl}/api/auth/credentials-verify`, {
      method: 'POST',
      headers: headersA,
      body: JSON.stringify({
        cipherText: 'v1:00112233445566778899aabb:00112233445566778899aabbccddeeff:deadbeef',
      }),
    });
    assert.equal(badDecRes.status, 400);
    const badDecData = await badDecRes.json();
    assert.equal(badDecData.ok, false);
    assert.equal(badDecData.code, 'DECRYPTION_FAILED');
  } finally {
    await close();
  }
});

