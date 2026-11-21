#!/usr/bin/env node
/**
 * Cloud Keep-Alive & Tactical Pulse (Node 22, zero dependencies).
 * Reads CK_RENDER_URL, DAEMON_API_KEY, DAEMON_SIGNING_KEY strictly from env secrets.
 */
import { createHmac, randomUUID } from 'node:crypto';

const BASE_URL = (process.env.CK_RENDER_URL || '').trim().replace(/\/$/, '');
const API_KEY = (process.env.DAEMON_API_KEY || '').trim();
const SIGNING_KEY = (process.env.DAEMON_SIGNING_KEY || '').trim();
const MODEL = (process.env.DAEMON_MODEL || 'gemini-3.8-flash').trim();

if (!BASE_URL) {
  console.error('[Pulse] Missing CK_RENDER_URL secret.');
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
        console.log(`[Pulse] Health OK (attempt ${attempt}) | version=${json.version ?? 'unknown'}`);
        return true;
      }
      console.warn(`[Pulse] Health HTTP ${res.status} (attempt ${attempt})`);
    } catch (err) {
      console.warn(`[Pulse] Health retry ${attempt}:`, err instanceof Error ? err.message : String(err));
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
  return false;
}

async function apiJson(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
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

async function sendTacticalOrder(rawOrder) {
  const now = Date.now();
  const body = {
    schema: 'ck.tactical.v1',
    id: `tac-${now}-${randomUUID().slice(0, 8)}`,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 90_000).toISOString(),
    daemonModel: MODEL,
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
    console.error('[Pulse] Server did not respond after retries.');
    process.exit(1);
  }

  if (!API_KEY || !SIGNING_KEY) {
    console.log('[Pulse] Health ping only (daemon secrets not configured).');
    return;
  }

  const hb = await apiJson('/api/daemon/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ model: MODEL }),
  });
  if (!hb.ok) {
    console.error(`[Pulse] Heartbeat failed HTTP ${hb.status}`);
    process.exit(1);
  }
  console.log(`[Pulse] Heartbeat OK (${MODEL})`);

  const snap = await apiJson('/api/daemon/snapshot');
  if (!snap.ok) {
    console.warn(`[Pulse] Snapshot HTTP ${snap.status}`);
    return;
  }

  const positions = snap.json.openShadowPositions || [];
  const hard = snap.json.hardLimits || {};
  const recentDecisions = snap.json.recentTacticalDecisions || [];
  console.log(
    `[Pulse] Snapshot OK | openShadow=${positions.length} | candidates=${(snap.json.candidateSignals || []).length} | killSwitch=${Boolean(hard.killSwitch)}`,
  );

  if (hard.killSwitch) return;

  // Protect gains: tighten trailing to 1.5c once a position is up >= +3.5c after 2 min grace (avoid duplicates)
  const recentlyAdjusted = new Set(
    recentDecisions
      .filter((d) => d.action === 'ADJUST_TP_TRAIL' && d.accepted && d.positionId)
      .map((d) => d.positionId),
  );

  for (const p of positions) {
    const gainCents = p.currentBidCents - p.avgEntryCents;
    if (p.ageSec >= 130 && gainCents >= 3.5 && !recentlyAdjusted.has(p.id)) {
      const res = await sendTacticalOrder({
        action: 'ADJUST_TP_TRAIL',
        positionId: p.id,
        pHat: Math.min(0.95, Math.max(0.05, p.pHatAtEntry)),
        confidence: 0.78,
        newTrailDistanceCents: 1.5,
        rationaleFr: `Gain latent +${gainCents.toFixed(1)}¢ confirmé (>2 min) : resserrement automatique du trailing à 1,5¢ pour sécuriser le profit.`,
      });
      console.log(`[Pulse] ADJUST_TP_TRAIL on ${p.id} -> HTTP ${res.status}`);
    }
  }
}

void main();
