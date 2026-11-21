#!/usr/bin/env node
/**
 * CaptainKrabs V4 — Conseil Stratège Autonome 24/7 (Vitesse 3, toutes les 6 h sur GitHub Actions).
 *
 * - Vérifie le verrou anti-oscillation serveur (`strategistLock.unlocked` : >= 30 marchés indépendants & >= 6h).
 * - Si le verrou est actif : n'appelle PAS le LLM (0 gaspillage de tokens), journalise la progression X/30.
 * - Si le verrou est déverrouillé :
 *   1. Compare Poche A & Poche B vs les 5 pistes R&D, l'attribution PnL et les scores Brier.
 *   2. Interroge Gemini 2.5 Flash en mode réflexion approfondie (`thinkingBudget: 2048`) pour identifier
 *      au maximum 1 directive ambitieuse et disciplinée (MUTATE_GENOME OFAT dans GENOME_MAX_DELTA, PROMOTE R&D,
 *      REALLOCATE_POCKETS, SET_POLICY, LAUNCH_EXPERIMENT ou HOLD).
 *   3. Signe `ck.directive.v1` en HMAC-SHA256 et l'envoie à `POST /api/directives` (avec auto-rollback 30 trades côté serveur).
 */
import { createHmac, randomUUID } from 'node:crypto';

const BASE_URL = (process.env.CK_RENDER_URL || '').trim().replace(/\/$/, '');
const API_KEY = (process.env.DAEMON_API_KEY || '').trim();
const SIGNING_KEY = (process.env.DAEMON_SIGNING_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const NEON_GW_URL = (process.env.NEON_AI_GATEWAY_BASE_URL || '').trim().replace(/\/$/, '');
const NEON_GW_TOKEN = (process.env.NEON_AI_GATEWAY_TOKEN || '').trim();
const LLM_MODEL = (process.env.COUNCIL_MODEL || 'gemini-2.5-flash').trim();

const GENOME_MAX_DELTA = {
  takeProfitCents: 3,
  stopLossCents: 2,
  trailArmCents: 2,
  trailDistanceCents: 2,
  minEdgeCents: 1,
  minConfidence: 0.05,
  kellyFraction: 0.05,
  entryPriceMinCents: 5,
  entryPriceMaxCents: 5,
};

if (!BASE_URL || !API_KEY || !SIGNING_KEY) {
  console.error('[Council] Missing CK_RENDER_URL / DAEMON_API_KEY / DAEMON_SIGNING_KEY secrets.');
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

async function apiJson(path, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-daemon-api-key': API_KEY,
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
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

async function callCouncilLlm(promptText) {
  if (GEMINI_API_KEY) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(LLM_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 1536 },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Gemini Council API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const textPart = [...parts].reverse().find((p) => typeof p?.text === 'string' && !p.thought) || parts[0];
    const rawText = String(textPart?.text || '{}')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    return { councilName: `COUNCIL-${LLM_MODEL.toUpperCase()}`, parsed: JSON.parse(rawText) };
  }

  if (NEON_GW_URL && NEON_GW_TOKEN) {
    const gwModel = process.env.NEON_COUNCIL_MODEL || 'gemini-3-flash';
    const res = await fetch(`${NEON_GW_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${NEON_GW_TOKEN}`,
      },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model: gwModel,
        temperature: 0.2,
        max_tokens: 2048,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: promptText }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Neon Gateway Council HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const rawText = data?.choices?.[0]?.message?.content || '{}';
    return { councilName: `COUNCIL-NEON-${gwModel.toUpperCase()}`, parsed: JSON.parse(rawText) };
  }

  return null;
}

async function main() {
  await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(15_000) }).catch(() => {});
  const snap = await apiJson('/api/daemon/snapshot');
  if (!snap.ok) {
    console.error(`[Council] Snapshot HTTP ${snap.status}`);
    process.exit(1);
  }

  const lock = snap.json.strategistLock || {
    independentClosedTrades: 0,
    minRequiredTrades: 30,
    elapsedHours: null,
    cooldownHours: 6,
    unlocked: false,
  };
  const report = snap.json.strategistReport;
  const hard = snap.json.hardLimits || {};

  console.log(
    `[Council] Lock status | unlocked=${lock.unlocked} | trades=${lock.independentClosedTrades}/${lock.minRequiredTrades} | elapsedH=${lock.elapsedHours ?? 'ready'}/${lock.cooldownHours} | killSwitch=${Boolean(hard.killSwitch)}`,
  );

  if (hard.killSwitch) {
    console.log('[Council] Kill-switch actif : aucune évolution stratégique autorisée.');
    return;
  }

  if (!lock.unlocked) {
    console.log(
      `[Council] Verrou anti-oscillation actif (${lock.independentClosedTrades}/${lock.minRequiredTrades} marchés indépendants). Collecte Shadow en cours — 0 appel LLM consommé.`,
    );
    return;
  }

  if (!GEMINI_API_KEY && !(NEON_GW_URL && NEON_GW_TOKEN)) {
    console.log('[Council] Verrou déverrouillé mais aucune clé LLM configurée (GEMINI_API_KEY).');
    return;
  }

  const prompt = `Tu es le Conseil Stratège (Vitesse 3) de CaptainKrabs V4 sur Polymarket.
Objectif : améliorer durablement la rentabilité nette ajustée du risque (ROI, Win-Rate, Profit Factor, Drawdown maîtrisé) de Poche A (Micro-Trading Maker) et Poche B (Conviction) en t'appuyant sur les données réelles Shadow + les 5 pistes R&D.

RÈGLES ABSOLUES :
1. INTERDICTION TOTALE de proposer une clé HARD (bankroll, maxStake, cashReservePct, killSwitch, maxDailyLoss, etc.).
2. Maximum 1 seule directive par Conseil (ou "decision": "HOLD" si les réglages actuels gagnent déjà proprement).
3. Pour MUTATE_GENOME : règle OFAT stricte = EXACTEMENT 1 seul gène dans "patch", respectant GENOME_MAX_DELTA :
   ${JSON.stringify(GENOME_MAX_DELTA)}
   Exemples pour viser une rentabilité plus ambitieuse quand les stats le justifient :
   - Si win-rate > 60% et les gains sont coupés trop tôt -> augmenter takeProfitCents (+2 ou +3c) ou trailArmCents (+1 ou +2c)
   - Si rendement positif solide (IC95 > 0 et MDD < 6%) -> augmenter kellyFraction (+0.05 max, plafond 0.35)
   - Si les entrées à faible avantage perdent -> monter minEdgeCents (+0.5 ou +1c) ou minConfidence (+0.05)
   - Si trop de SL serrés sur du bruit -> ajuster stopLossCents (+1 ou +2c max)
4. Pour PROMOTE : uniquement si une piste R&D a >= 25 trades clos et bat nettement Poche A ou Poche B en ROI et MDD -> patch: { "sourceRdSessionId": "rd-...", "targetPocket": "POCHE_A_MAKER" | "POCHE_B_CONVICTION" }.
5. Pour REALLOCATE_POCKETS / SET_POLICY : patch dans PolicySchema uniquement (pocheAAllocationPct + pocheBAllocationPct = 100 dans [20, 80], blockedCategories, etc.).
6. Pour LAUNCH_EXPERIMENT : tester une idée audacieuse en R&D avant Shadow -> patch: { "label": "...", "genomePatch": { ... } }.
7. Toute mutation/promotion est automatiquement protégée par auto-rollback après 30 trades si elle régresse.

RAPPORT COMPLET LIVE :
${JSON.stringify({ policy: snap.json.policy, strategistReport: report, brierSources: snap.json.brierSources, recentDirectives: (snap.json.recentDirectives || []).slice(0, 4) })}

Réponds STRICTEMENT en JSON :
{
  "decision": "HOLD" | "APPLY",
  "analysisFr": "synthèse claire en 2 phrases max",
  "directive": null | {
    "kind": "MUTATE_GENOME" | "PROMOTE" | "REALLOCATE_POCKETS" | "SET_POLICY" | "LAUNCH_EXPERIMENT",
    "target": { "sessionId": "shadow-poche-a" | "shadow-poche-b" },
    "patch": {},
    "rationaleFr": "justification claire en français (max 240 chars)",
    "expectedEffect": { "metric": "netPnl" | "winRate" | "sharpe" | "brier" | "maxDrawdown", "direction": "+" | "-" }
  }
}`;

  const llmRes = await callCouncilLlm(prompt);
  if (!llmRes) return;

  const { councilName, parsed } = llmRes;
  console.log(`[Council ${councilName}] decision=${parsed?.decision} | ${parsed?.analysisFr || ''}`);

  if (parsed?.decision !== 'APPLY' || !parsed?.directive) {
    console.log('[Council] Décision HOLD : paramètres actuels conservés.');
    return;
  }

  const d = parsed.directive;
  const now = Date.now();
  const body = {
    schema: 'ck.directive.v1',
    id: `dir-${now}-${randomUUID().slice(0, 8)}`,
    issuedAt: new Date(now).toISOString(),
    council: councilName.slice(0, 60),
    kind: d.kind,
    target: d.target && typeof d.target === 'object' ? d.target : {},
    patch: d.patch && typeof d.patch === 'object' ? d.patch : {},
    rationaleFr: String(d.rationaleFr || parsed.analysisFr || 'Évolution stratégique Conseil').slice(0, 500),
    expectedEffect:
      d.expectedEffect && typeof d.expectedEffect === 'object'
        ? d.expectedEffect
        : { metric: 'netPnl', direction: '+' },
  };
  const signed = { ...body, signature: signHmac(body) };

  const res = await apiJson('/api/directives', {
    method: 'POST',
    body: JSON.stringify(signed),
  });
  console.log(
    `[Council] POST /api/directives (${body.kind}) -> HTTP ${res.status} | ${res.json?.detailFr || res.json?.reasonFr || JSON.stringify(res.json)}`,
  );
  if (!res.ok) {
    process.exit(1);
  }
}

void main();
