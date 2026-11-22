#!/usr/bin/env node
/**
 * CaptainKrabs 24/7 Cloud Keep-Alive (0 $ API LLM externe · Node 22, zéro dépendance).
 *
 * Rôle unique :
 * 1. Réveille Render (/api/health) toutes les 5 min pour empêcher la mise en veille Render Free.
 * 2. Envoie un heartbeat non destructif (`{}`) qui préserve le modèle et la source `antigravity-bridge`.
 * 3. Protège mécaniquement les gains latents (+3,5¢ après 2 min -> trailing 1,5¢).
 *
 * Aucun appel API LLM externe (Gemini / OpenAI / Neon AI Gateway) :
 * toutes les décisions IA (vetos wording, entrées tactiques, Conseil Stratège) sont prises
 * directement par Antigravity via le Pont Antigravity (`antigravity-bridge`).
 */
import { createHmac, randomUUID } from 'node:crypto';

const BASE_URL = (process.env.CK_RENDER_URL || '').trim().replace(/\/$/, '');
const API_KEY = (process.env.DAEMON_API_KEY || '').trim();
const SIGNING_KEY = (process.env.DAEMON_SIGNING_KEY || '').trim();

if (!BASE_URL) {
  console.error('[KeepAlive] Missing CK_RENDER_URL secret.');
  process.exit(1);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function signHmac(body) {
  const clean = { ...body };
  delete clean.signature;
  return createHmac('sha256', SIGNING_KEY).update(canonicalJson(clean)).digest('hex');
}

async function wakeHealth() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const json = await res.json().catch(() => ({}));
        console.log(`[KeepAlive] Health OK (attempt ${attempt}) | version=${json.version ?? 'unknown'}`);
        return true;
      }
      console.warn(`[KeepAlive] Health HTTP ${res.status} (attempt ${attempt})`);
    } catch (err) {
      console.warn(`[KeepAlive] Health retry ${attempt}:`, err instanceof Error ? err.message : String(err));
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
  return false;
}

async function apiJson(routePath, opts = {}) {
  const res = await fetch(`${BASE_URL}${routePath}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-daemon-api-key': API_KEY,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, ok: res.ok, json };
}

async function sendTacticalOrder(rawOrder, daemonModel) {
  const now = Date.now();
  const body = {
    schema: 'ck.tactical.v1',
    id: `ka-${now}-${randomUUID().slice(0, 8)}`,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 90_000).toISOString(),
    daemonModel,
    ...rawOrder,
  };
  const signed = { ...body, signature: signHmac(body) };
  return apiJson('/api/daemon/tactical-orders', {
    method: 'POST',
    body: JSON.stringify(signed),
  });
}

async function main() {
  const awake = await wakeHealth();
  if (!awake) {
    console.error('[KeepAlive] Server did not respond after retries.');
    process.exit(1);
  }

  if (!API_KEY || !SIGNING_KEY) {
    console.log('[KeepAlive] Health ping only (daemon secrets not configured).');
    return;
  }

  // Heartbeat non destructif : ne remplace jamais model/source d'antigravity-bridge
  const hb = await apiJson('/api/daemon/heartbeat', {
    method: 'POST',
    body: '{}',
  });
  if (!hb.ok) {
    console.error(`[KeepAlive] Heartbeat HTTP ${hb.status}`);
    process.exit(1);
  }
  const d = hb.json?.daemon || {};
  console.log(
    `[KeepAlive] Wake OK | model=${d.model ?? 'gemini-3.8-flash'} · source=${d.source ?? 'antigravity-bridge'} | externalLlmApi=OFF`,
  );

  const snap = await apiJson('/api/daemon/snapshot');
  if (!snap.ok) return;

  const positions = snap.json.openShadowPositions || [];
  const hard = snap.json.hardLimits || {};
  const recentDecisions = snap.json.recentTacticalDecisions || [];
  console.log(
    `[KeepAlive] Snapshot OK | openShadow=${positions.length} | karpathyLessons=${(snap.json.karpathyLessons || []).length} | lock=${snap.json.strategistLock?.independentClosedTrades ?? 0}/${snap.json.strategistLock?.minRequiredTrades ?? 30} | killSwitch=${Boolean(hard.killSwitch)}`,
  );

  if (hard.killSwitch) return;

  // Protection mécanique uniquement (0 appel API LLM)
  const recentlyAdjusted = new Set(
    recentDecisions
      .filter((dec) => dec.action === 'ADJUST_TP_TRAIL' && dec.accepted && dec.positionId)
      .map((dec) => dec.positionId),
  );
  for (const p of positions) {
    const gainCents = p.currentBidCents - p.avgEntryCents;
    if (p.ageSec >= 130 && gainCents >= 3.5 && !recentlyAdjusted.has(p.id)) {
      const res = await sendTacticalOrder(
        {
          action: 'ADJUST_TP_TRAIL',
          positionId: p.id,
          pHat: Math.min(0.95, Math.max(0.05, p.pHatAtEntry)),
          confidence: 0.78,
          newTrailDistanceCents: 1.5,
          rationaleFr: `Gain latent +${gainCents.toFixed(1)}¢ confirmé (>2 min) : resserrement mécanique du trailing à 1,5¢.`,
        },
        d.model || 'gemini-3.8-flash',
      );
      console.log(`[KeepAlive] ADJUST_TP_TRAIL on ${p.id} -> HTTP ${res.status}`);
    }
  }
}

void main();
