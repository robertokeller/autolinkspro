#!/usr/bin/env node
/**
 * smoke-coolify.mjs — Smoke test pós-deploy para ambiente Coolify.
 *
 * Uso:
 *   SERVICE_TOKEN=xxx \
 *   SMOKE_API_URL=https://api.seudominio.com \
 *   SMOKE_WA_URL=https://wa-api.seudominio.com \
 *   SMOKE_TG_URL=https://tg-api.seudominio.com \
 *   SMOKE_SHOPEE_URL=https://shopee-api.seudominio.com \
 *   SMOKE_MELI_URL=https://meli-api.seudominio.com \
 *   SMOKE_AMAZON_URL=https://amazon-api.seudominio.com \
 *   SMOKE_OPS_URL=https://ops-api.seudominio.com \
 *   SMOKE_WEB_URL=https://seudominio.com \
 *   SMOKE_WEBHOOK_SECRET=xxx \
 *   SMOKE_OPS_TOKEN=xxx \
 *   node scripts/smoke-coolify.mjs
 */

const TIMEOUT_MS = 10_000;

const {
  SERVICE_TOKEN,
  SMOKE_API_URL,
  SMOKE_WA_URL,
  SMOKE_TG_URL,
  SMOKE_SHOPEE_URL,
  SMOKE_MELI_URL,
  SMOKE_AMAZON_URL,
  SMOKE_OPS_URL,
  SMOKE_WEB_URL,
  SMOKE_WEBHOOK_SECRET,
  SMOKE_OPS_TOKEN,
  WEBHOOK_SECRET,
  OPS_CONTROL_TOKEN,
} = process.env;

const smokeWebhookSecret = String(SMOKE_WEBHOOK_SECRET || WEBHOOK_SECRET || "").trim();
const smokeOpsToken = String(SMOKE_OPS_TOKEN || OPS_CONTROL_TOKEN || "").trim();

if (!SMOKE_API_URL) {
  console.error('[smoke] SMOKE_API_URL is required');
  process.exit(1);
}

/**
 * Fetch with a hard timeout via AbortController.
 * clearTimeout ensures no timer leak if the request finishes early.
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check a simple GET /health endpoint.
 * Returns { ok, status, label }.
 */
async function checkHealth(label, url, options = {}) {
  try {
    const res = await fetchWithTimeout(url, options);
    const ok = res.status === 200;
    console.log(`[smoke] ${ok ? 'OK' : 'FAIL'} ${label} → ${res.status} ${url}`);
    return { ok, status: res.status, label };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timeout' : err.message;
    console.log(`[smoke] FAIL ${label} → ${msg} ${url}`);
    return { ok: false, status: null, label };
  }
}

/**
 * Check the RPC route on the API.
 * Accepts 200 (function executed) and 400 (function unknown / bad params) as proof
 * that the route exists and the API is up. Any other status (401, 404, 5xx) is a fail.
 */
async function checkRpc(label, baseUrl, token) {
  const url = `${baseUrl}/functions/v1/rpc`;
  if (!token) {
    console.log(`[smoke] SKIP ${label} → SERVICE_TOKEN not set`);
    return { ok: true, status: null, label };
  }
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: '__smoke_probe__' }),
    });
    // 200 = executed, 400 = unknown function — both prove the route exists
    const ok = res.status === 200 || res.status === 400;
    console.log(`[smoke] ${ok ? 'OK' : 'FAIL'} ${label} → ${res.status} ${url}`);
    return { ok, status: res.status, label };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'timeout' : err.message;
    console.log(`[smoke] FAIL ${label} → ${msg} ${url}`);
    return { ok: false, status: null, label };
  }
}

async function main() {
  console.log('[smoke] Starting post-deploy smoke tests…\n');

  const checks = await Promise.all([
    checkHealth('api       /health', `${SMOKE_API_URL}/health`),
    checkHealth('whatsapp  /health', `${SMOKE_WA_URL ?? ''}/health`),
    checkHealth('telegram  /health', `${SMOKE_TG_URL ?? ''}/health`),
    checkHealth('shopee    /health', `${SMOKE_SHOPEE_URL ?? ''}/health`),
    checkHealth(
      'amazon    /health',
      `${SMOKE_AMAZON_URL ?? ''}/health`,
      smokeWebhookSecret ? { headers: { 'x-webhook-secret': smokeWebhookSecret } } : {},
    ),
    checkHealth(
      'meli      /health',
      `${SMOKE_MELI_URL ?? ''}/api/meli/health`,
      smokeWebhookSecret ? { headers: { 'x-webhook-secret': smokeWebhookSecret } } : {},
    ),
    checkHealth(
      'ops       /health',
      `${SMOKE_OPS_URL ?? ''}/health`,
      smokeOpsToken ? { headers: { 'x-ops-token': smokeOpsToken } } : {},
    ),
    checkHealth('web       /        ', `${SMOKE_WEB_URL ?? ''}/`),
    checkRpc('api       /rpc   ', SMOKE_API_URL, SERVICE_TOKEN),
  ]);

  console.log('');

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    console.log('[smoke] All checks passed ✓');
    process.exit(0);
  } else {
    console.error(`[smoke] ${failed.length} check(s) FAILED:`);
    failed.forEach((c) => console.error(`  - ${c.label.trim()}`));
    process.exit(1);
  }
}

main();
