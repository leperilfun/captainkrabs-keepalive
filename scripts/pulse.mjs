#!/usr/bin/env node
/**
 * CaptainKrabs 24/7 Cloud Keep-Alive & Autonomous LLM Tactical Pilot (Node 22, zero dependencies).
 *
 * 1. Every 5 min : wakes Render /api/health + sends /api/daemon/heartbeat + locks trailing gains.
 * 2. Every 10 min (or manual dispatch) when GEMINI_API_KEY or NEON_AI_GATEWAY_TOKEN is set:
 *    - Fetches exact Polymarket Gamma resolution rules for open Shadow positions + top candidates.
 *    - Calls Gemini Flash (Google AI Studio free tier OR Neon AI Gateway) with strict JSON schema.
 *    - Validates & signs up to 2 high-conviction HMAC-SHA256 tactical orders (VETO_ENTRY, CLOSE_POSITION,
 *      ADJUST_TP_TRAIL, OPEN_SHADOW) and submits them to Render.
 */
import { createHmac, randomUUID } from 'node:crypto';

const BASE_URL = (process.env.CK_RENDER_URL || '').trim().replace(/\/$/, '');
const API_KEY = (process.env.DAEMON_API_KEY || '').trim();
const SIGNING_KEY = (process.env.DAEMON_SIGNING_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const NEON_GW_URL = (process.env.NEON_AI_GATEWAY_BASE_URL || '').trim().replace(/\/$/, '');
const NEON_GW_TOKEN = (process.env.NEON_AI_GATEWAY_TOKEN || '').trim();
const LLM_MODEL = (process.env.LLM_MODEL || 'gemini-2.5-flash').trim();
const FORCE_LLM = process.env.FORCE_LLM === 'true';

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

async function sendTacticalOrder(rawOrder, daemonModel) {
  const now = Date.now();
  const body = {
    schema: 'ck.tactical.v1',
    id: `tac-${now}-${randomUUID().slice(0, 8)}`,
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

async function fetchGammaRules(conditionIds) {
  const rules = new Map();
  const unique = [...new Set(conditionIds.filter(Boolean))].slice(0, 10);
  await Promise.all(
    unique.map(async (cid) => {
      try {
        const r = await fetch(`https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(cid)}`, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) return;
        const arr = await r.json();
        const m = Array.isArray(arr) ? arr[0] : arr;
        if (m) {
          rules.set(cid, {
            eventId: m.events?.[0]?.id ?? null,
            endDate: m.endDate ?? null,
            description: String(m.description || '').slice(0, 420),
          });
        }
      } catch {
        // ignore single gamma failure
      }
    }),
  );
  return rules;
}

async function callTacticalLlm(promptText) {
  if (GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(LLM_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: 0.15,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 512 },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Gemini API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const textPart = [...parts].reverse().find((p) => typeof p?.text === 'string' && !p.thought) || parts[0];
    const rawText = String(textPart?.text || '{}')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    return { providerModel: LLM_MODEL, parsed: JSON.parse(rawText) };
  }

  if (NEON_GW_URL && NEON_GW_TOKEN) {
    const gwModel = process.env.NEON_LLM_MODEL || 'gemini-3-flash';
    const res = await fetch(`${NEON_GW_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${NEON_GW_TOKEN}`,
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: gwModel,
        temperature: 0.15,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: promptText }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Neon AI Gateway HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const rawText = data?.choices?.[0]?.message?.content || '{}';
    return { providerModel: `neon/${gwModel}`, parsed: JSON.parse(rawText) };
  }

  return null;
}

async function runAutonomousLlmPilot(snap, activeModelName) {
  const hasLlmKey = Boolean(GEMINI_API_KEY || (NEON_GW_URL && NEON_GW_TOKEN));
  if (!hasLlmKey) {
    console.log('[Pulse] LLM 24/7 prêt mais en attente : ajoutez le secret GEMINI_API_KEY (gratuit) ou NEON_AI_GATEWAY_TOKEN.');
    return;
  }

  // En cron toutes les 5 min, n'appeler le LLM qu'une fois sur deux (~10 min) sauf déclenchement manuel
  const minuteUtc = new Date().getUTCMinutes();
  if (!FORCE_LLM && minuteUtc % 10 >= 5) {
    console.log('[Pulse] Cycle intermédiaire 5 min (prochain audit LLM complet dans 5 min).');
    return;
  }

  const positions = snap.openShadowPositions || [];
  const activeVetoIds = new Set((snap.activeVetos || []).map((v) => v.conditionId));
  const openConds = new Set(positions.map((p) => p.conditionId));
  const candidates = (snap.candidateSignals || [])
    .filter((c) => !activeVetoIds.has(c.conditionId) && !openConds.has(c.conditionId))
    .slice(0, 10);

  const allCids = [...positions.map((p) => p.conditionId), ...candidates.map((c) => c.conditionId)];
  const gammaMap = await fetchGammaRules(allCids);

  const brief = {
    nowUtc: new Date().toISOString(),
    openShadowPositions: positions.map((p) => ({
      id: p.id,
      pocket: p.pocket,
      conditionId: p.conditionId,
      question: p.question,
      category: p.category,
      avgEntryCents: p.avgEntryCents,
      currentBidCents: p.currentBidCents,
      takeProfitCents: p.takeProfitCents,
      stopLossCents: p.stopLossCents,
      unrealizedPnlUsd: p.unrealizedPnlUsd,
      ageSec: p.ageSec,
      rules: gammaMap.get(p.conditionId) || null,
    })),
    candidateSignals: candidates.map((c) => ({
      conditionId: c.conditionId,
      tokenId: c.tokenId,
      question: c.question,
      category: c.category,
      bestBidCents: c.bestBidCents,
      bestAskCents: c.bestAskCents,
      spreadCents: c.spreadCents,
      edgeNetCents: c.edgeNetCents,
      pHat: c.pHat,
      confidence: c.confidence,
      sources: c.sources,
      rules: gammaMap.get(c.conditionId) || null,
    })),
    recentCatalysts: (snap.recentCatalysts || []).slice(0, 5).map((r) => `[${r.source}] ${r.title}`),
    karpathyLessons: (snap.karpathyLessons || []).slice(0, 10).map((l) => ({
      source: l.source,
      category: l.category,
      titleFr: l.titleFr,
      lessonFr: l.lessonFr,
    })),
  };

  const prompt = `Tu es le Pilote IA Tactique de CaptainKrabs V4 sur Polymarket (portefeuille Shadow mode Data-Max : maximiser les données propres sans jamais compromettre la rigueur).
Règles strictes :
1. Zéro sur-trading absurde : n'émets un ordre QUE s'il a un vrai edge propre ou protège une position. Sinon renvoie "orders": [].
2. Priorité #1 — Pièges de wording & litiges UMA : si un candidat ou une position ouverte a une faute de syntaxe ambiguë, une clause piège (ex: "rejoin" alors que la personne n'est jamais partie), ou un critère subjectif dangereux -> émets VETO_ENTRY (sur un candidat) ou CLOSE_POSITION (sur une position ouverte avec ageSec >= 130).
3. Priorité #2 — Mémoire Karpathy active : lis impérativement \`karpathyLessons\` (leçons distillées V3 + vetos + rollbacks passés) et ne répète JAMAIS une erreur documentée (sport à volatilité extrême, carnet peu liquide, spreads larges, pièges récurrents).
4. Priorité #3 — Protection des positions ouvertes (uniquement si ageSec >= 130) : ne ferme pas sur du bruit mineur (-1¢). Ne fais ADJUST_TP_TRAIL ou CLOSE_POSITION que si une nouvelle majeure ou un piège réel le justifie.
5. Priorité #4 — Opportunités propres (OPEN_SHADOW en MAKER_GTC uniquement) : dès que les règles Gamma sont 100 % objectives, hors sport explosif, ask entre 8¢ et 90¢, spread <= 3.5¢, edgeNetCents >= 2.0, et AUCUN eventId déjà présent dans openShadowPositions -> saisis l'opportunité en alternant POCHE_A_MAKER et POCHE_B_CONVICTION pour maximiser la collecte Shadow.
6. Maximum 3 ordres par cycle. Toutes les justifications ("rationaleFr") en français clair (max 160 caractères).

Données live JSON :
${JSON.stringify(brief)}

Réponds STRICTEMENT avec cet objet JSON :
{
  "summaryFr": "résumé court en 1 phrase",
  "orders": [
    {
      "action": "VETO_ENTRY" | "CLOSE_POSITION" | "ADJUST_TP_TRAIL" | "OPEN_SHADOW",
      "positionId": "obligatoire si CLOSE_POSITION ou ADJUST_TP_TRAIL",
      "conditionId": "obligatoire si VETO_ENTRY ou OPEN_SHADOW",
      "tokenId": "obligatoire si OPEN_SHADOW",
      "pocket": "POCHE_A_MAKER" | "POCHE_B_CONVICTION",
      "side": "BUY",
      "orderType": "MAKER_GTC",
      "newTrailDistanceCents": 1.5,
      "pHat": 0.55,
      "confidence": 0.80,
      "rationaleFr": "explication claire en français"
    }
  ]
}`;

  const llmRes = await callTacticalLlm(prompt);
  if (!llmRes) return;

  const summary = typeof llmRes.parsed?.summaryFr === 'string' ? llmRes.parsed.summaryFr : 'Audit terminé.';
  const rawOrders = Array.isArray(llmRes.parsed?.orders) ? llmRes.parsed.orders.slice(0, 3) : [];
  console.log(`[Pulse LLM ${llmRes.providerModel}] ${summary} | proposedOrders=${rawOrders.length}`);

  const validPosIds = new Set(positions.map((p) => p.id));
  const candByCond = new Map(candidates.map((c) => [c.conditionId, c]));

  for (const o of rawOrders) {
    if (!o || typeof o !== 'object') continue;
    const action = o.action;
    const pHat = Math.min(0.98, Math.max(0.02, Number(o.pHat ?? 0.5)));
    const confidence = Math.min(0.99, Math.max(0.5, Number(o.confidence ?? 0.75)));
    const rationaleFr = String(o.rationaleFr || 'Décision IA tactique').slice(0, 220);

    let cleanOrder = null;
    if (action === 'VETO_ENTRY' && typeof o.conditionId === 'string' && !activeVetoIds.has(o.conditionId)) {
      cleanOrder = { action, conditionId: o.conditionId, pHat, confidence, rationaleFr };
    } else if (action === 'CLOSE_POSITION' && typeof o.positionId === 'string' && validPosIds.has(o.positionId)) {
      cleanOrder = { action, positionId: o.positionId, pHat, confidence, rationaleFr };
    } else if (action === 'ADJUST_TP_TRAIL' && typeof o.positionId === 'string' && validPosIds.has(o.positionId)) {
      cleanOrder = {
        action,
        positionId: o.positionId,
        newTrailDistanceCents: Math.min(8, Math.max(1, Number(o.newTrailDistanceCents ?? 1.5))),
        pHat,
        confidence,
        rationaleFr,
      };
    } else if (action === 'OPEN_SHADOW' && typeof o.conditionId === 'string' && candByCond.has(o.conditionId)) {
      const cand = candByCond.get(o.conditionId);
      const pocket = o.pocket === 'POCHE_B_CONVICTION' ? 'POCHE_B_CONVICTION' : 'POCHE_A_MAKER';
      cleanOrder = {
        action,
        pocket,
        conditionId: cand.conditionId,
        tokenId: cand.tokenId,
        side: 'BUY',
        orderType: 'MAKER_GTC',
        pHat,
        confidence,
        rationaleFr,
      };
    }

    if (!cleanOrder) continue;
    const res = await sendTacticalOrder(cleanOrder, llmRes.providerModel || activeModelName);
    console.log(
      `[Pulse LLM] ${cleanOrder.action} -> HTTP ${res.status} | executed=${Boolean(res.json?.executed)} | ${res.json?.detailFr || res.json?.reasonFr || ''}`,
    );
  }
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

  const activeModel = GEMINI_API_KEY
    ? LLM_MODEL
    : NEON_GW_URL && NEON_GW_TOKEN
      ? `neon/${process.env.NEON_LLM_MODEL || 'gemini-3-flash'}`
      : 'gemini-3.8-flash';

  const hb = await apiJson('/api/daemon/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ model: activeModel, source: 'github-cloud-24x7' }),
  });
  if (!hb.ok) {
    console.error(`[Pulse] Heartbeat failed HTTP ${hb.status}`);
    process.exit(1);
  }
  console.log(
    `[Pulse] Heartbeat OK (${activeModel} · github-cloud-24x7) | brainSync=${hb.json?.brainSync?.lastSuccessAt || (hb.json?.brainSync?.configured ? 'pending' : 'off')}`,
  );

  const snap = await apiJson('/api/daemon/snapshot');
  if (!snap.ok) {
    console.warn(`[Pulse] Snapshot HTTP ${snap.status}`);
    return;
  }

  const positions = snap.json.openShadowPositions || [];
  const hard = snap.json.hardLimits || {};
  const recentDecisions = snap.json.recentTacticalDecisions || [];
  console.log(
    `[Pulse] Snapshot OK | openShadow=${positions.length} | candidates=${(snap.json.candidateSignals || []).length} | activeVetos=${(snap.json.activeVetos || []).length} | karpathyLessons=${(snap.json.karpathyLessons || []).length} | killSwitch=${Boolean(hard.killSwitch)}`,
  );

  if (hard.killSwitch) return;

  // 1. Protection mécanique rapide : resserrer le trailing à 1,5¢ dès +3,5¢ de gain (> 2 min)
  const recentlyAdjusted = new Set(
    recentDecisions
      .filter((d) => d.action === 'ADJUST_TP_TRAIL' && d.accepted && d.positionId)
      .map((d) => d.positionId),
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
          rationaleFr: `Gain latent +${gainCents.toFixed(1)}¢ confirmé (>2 min) : resserrement automatique du trailing à 1,5¢ pour sécuriser le profit.`,
        },
        activeModel,
      );
      console.log(`[Pulse] ADJUST_TP_TRAIL on ${p.id} -> HTTP ${res.status}`);
    }
  }

  // 2. Pilote IA LLM autonome 24/7 (lecture Gamma + vetos wording + décisions tactiques)
  try {
    await runAutonomousLlmPilot(snap.json, activeModel);
  } catch (err) {
    console.error('[Pulse LLM] Non-fatal error:', err instanceof Error ? err.message : String(err));
  }
}

void main();
