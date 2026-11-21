#!/usr/bin/env node
/**
 * CaptainKrabs V4 — Conseil Stratège Autonome 24/7 (Vitesse 3, toutes les 6 h sur GitHub Actions).
 *
 * - Vérifie le verrou anti-oscillation serveur (`strategistLock.unlocked` : >= 30 marchés indépendants & >= 6h).
 * - Si le verrou est actif : n'appelle PAS le LLM (0 gaspillage de tokens), journalise la progression X/30.
 * - Si le verrou est déverrouillé :
 *   1. Analyse le testing A/B en direct entre Poche A (Maker) et Poche B (Conviction), l'attribution PnL et les scores Brier.
 *   2. Interroge Gemini 2.5 Flash en mode réflexion approfondie (`thinkingBudget: 1536`) pour identifier
 *      au maximum 1 directive ambitieuse et disciplinée (MUTATE_GENOME OFAT dans GENOME_MAX_DELTA, PROMOTE A/B,
 *      REALLOCATE_POCKETS, SET_POLICY ou HOLD) + distiller une nouvelle leçon Karpathy issue du testing A/B Shadow.
 *   3. Signe `ck.directive.v1` en HMAC-SHA256 et l'envoie à `POST /api/directives` (avec auto-rollback 30 trades côté serveur).
 */
import { createHmac, randomUUID } from 'node:crypto';

const BASE_URL = (process.env.CK_RENDER_URL || '').trim().replace(/\/$/, '');
const API_KEY = (process.env.DAEMON_API_KEY || '').trim();
const SIGNING_KEY = (process.env.DAEMON_SIGNING_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const NEON_GW_URL = (process.env.NEON_AI_GATEWAY_BASE_URL || '').trim().replace(/\/$/, '');
const NEON_GW_TOKEN = (process.env.NEON_AI_GATEWAY_TOKEN || '').trim();
const COUNCIL_MODELS = (process.env.COUNCIL_MODELS || process.env.COUNCIL_MODEL || 'gemini-3.8-flash,gemini-3-flash-preview,gemini-2.5-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

async function callSingleCouncilGemini(model, promptText, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const isGemini3 = /^gemini-3/i.test(model);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        thinkingConfig: isGemini3 ? { thinkingLevel: 'medium' } : { thinkingBudget: 1536 },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const textPart = [...parts].reverse().find((p) => typeof p?.text === 'string' && !p.thought) || parts[0];
  const rawText = String(textPart?.text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  if (!rawText) {
    throw new Error(`Empty response (finishReason=${data?.candidates?.[0]?.finishReason ?? 'unknown'})`);
  }
  return { councilName: `COUNCIL-${model.toUpperCase()}`, parsed: JSON.parse(rawText) };
}

async function callCouncilLlm(promptText) {
  const errors = [];
  if (GEMINI_API_KEY) {
    for (let i = 0; i < COUNCIL_MODELS.length; i++) {
      const model = COUNCIL_MODELS[i];
      const timeoutMs = i === 0 && model === 'gemini-3.8-flash' ? 25_000 : 40_000;
      try {
        return await callSingleCouncilGemini(model, promptText, timeoutMs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${model}: ${msg}`);
        const nextModel = COUNCIL_MODELS[i + 1];
        if (nextModel) {
          console.warn(`[Council LLM] ${model} indisponible (${msg.slice(0, 110)}) -> bascule vers ${nextModel}`);
        }
      }
    }
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

  if (errors.length > 0) {
    throw new Error(`Tous les modèles Conseil ont échoué: ${errors.join(' | ')}`);
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

  const lessons = (snap.json.karpathyLessons || []).slice(0, 14);
  console.log(
    `[Council] Lock status | unlocked=${lock.unlocked} | trades=${lock.independentClosedTrades}/${lock.minRequiredTrades} | elapsedH=${lock.elapsedHours ?? 'ready'}/${lock.cooldownHours} | karpathyLessons=${lessons.length} | killSwitch=${Boolean(hard.killSwitch)}`,
  );

  if (hard.killSwitch) {
    console.log('[Council] Kill-switch actif : aucune évolution stratégique autorisée.');
    return;
  }

  if (!lock.unlocked) {
    console.log(
      `[Council] Verrou anti-oscillation actif (${lock.independentClosedTrades}/${lock.minRequiredTrades} marchés indépendants). Collecte Shadow A/B en cours — 0 appel LLM consommé.`,
    );
    return;
  }

  if (!GEMINI_API_KEY && !(NEON_GW_URL && NEON_GW_TOKEN)) {
    console.log('[Council] Verrou déverrouillé mais aucune clé LLM configurée (GEMINI_API_KEY).');
    return;
  }

  const prompt = `Tu es le Conseil Stratège (Vitesse 3) de CaptainKrabs V4 sur Polymarket.
Objectif : améliorer durablement la rentabilité nette ajustée du risque (ROI, Win-Rate, Profit Factor, Drawdown maîtrisé) à partir du TESTING A/B en direct entre Poche A (Micro-Trading Maker) et Poche B (Conviction), de l'attribution PnL Shadow et de la Mémoire Karpathy.

RÈGLES ABSOLUES :
1. INTERDICTION TOTALE de proposer une clé HARD (bankroll, maxStake, cashReservePct, killSwitch, maxDailyLoss, etc.).
2. Maximum 1 seule directive par Conseil (ou "decision": "HOLD" si les réglages actuels gagnent déjà proprement).
3. Respecte la Mémoire Karpathy (\`karpathyLessons\`) : capitalise sur les patterns gagnants du Shadow A/B et ne re-tente pas une mutation qui vient déjà d'être rollbackée sans preuve nouvelle.
4. Pour MUTATE_GENOME : règle OFAT stricte = EXACTEMENT 1 seul gène dans "patch", respectant GENOME_MAX_DELTA :
   ${JSON.stringify(GENOME_MAX_DELTA)}
   Exemples pour viser une rentabilité plus ambitieuse quand le testing A/B Shadow le justifie :
   - Si une poche a un win-rate > 60% et les gains sont coupés trop tôt -> augmenter takeProfitCents (+2 ou +3c) ou trailArmCents (+1 ou +2c)
   - Si rendement positif solide (IC95 > 0 et MDD < 6%) -> augmenter kellyFraction (+0.05 max, plafond 0.35)
   - Si les entrées à faible avantage perdent -> monter minEdgeCents (+0.5 ou +1c) ou minConfidence (+0.05)
   - Si trop de SL serrés sur du bruit -> ajuster stopLossCents (+1 ou +2c max)
5. Pour PROMOTE (A/B) : si Poche A ou Poche B bat nettement l'autre poche sur >= 25 trades clos -> copier le génome gagnant vers la poche en retard : patch: { "sourceSessionId": "shadow-poche-a" | "shadow-poche-b", "targetPocket": "POCHE_A_MAKER" | "POCHE_B_CONVICTION" }.
6. Pour REALLOCATE_POCKETS / SET_POLICY : patch dans PolicySchema uniquement (pocheAAllocationPct + pocheBAllocationPct = 100 dans [20, 80], blockedCategories, etc.).
7. Toute mutation/promotion est automatiquement protégée par auto-rollback après 30 trades si elle régresse.
8. Tire TOUJOURS une leçon synthétique de l'analyse Shadow & A/B Poche A vs Poche B dans "newLesson" dès qu'un enseignement statistique clair se dégage pour enrichir la Mémoire Karpathy.

RAPPORT COMPLET LIVE (SHADOW + TESTING A/B) :
${JSON.stringify({ policy: snap.json.policy, strategistReport: report, brierSources: snap.json.brierSources, karpathyLessons: lessons, recentDirectives: (snap.json.recentDirectives || []).slice(0, 4) })}

Réponds STRICTEMENT en JSON :
{
  "decision": "HOLD" | "APPLY",
  "analysisFr": "synthèse claire du testing A/B Shadow en 2 phrases max",
  "newLesson": null | {
    "category": "WIN_PATTERN" | "AVOID_TRAP" | "RISK_RULE" | "PARAMETER_LESSON",
    "titleFr": "titre court (max 100 chars)",
    "lessonFr": "règle concrète actionnable tirée de Shadow A/B en français (max 280 chars)",
    "evidenceFr": "preuve chiffrée A/B (max 140 chars)"
  },
  "directive": null | {
    "kind": "MUTATE_GENOME" | "PROMOTE" | "REALLOCATE_POCKETS" | "SET_POLICY",
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

  if (parsed?.newLesson && typeof parsed.newLesson === 'object' && typeof parsed.newLesson.titleFr === 'string' && typeof parsed.newLesson.lessonFr === 'string') {
    const lRes = await apiJson('/api/brain/lessons', {
      method: 'POST',
      body: JSON.stringify({
        source: 'SHADOW_AB',
        category: parsed.newLesson.category || 'PARAMETER_LESSON',
        titleFr: parsed.newLesson.titleFr.slice(0, 120),
        lessonFr: parsed.newLesson.lessonFr.slice(0, 320),
        evidenceFr: typeof parsed.newLesson.evidenceFr === 'string' ? parsed.newLesson.evidenceFr.slice(0, 160) : councilName,
      }),
    });
    console.log(`[Council] POST /api/brain/lessons -> HTTP ${lRes.status}`);
  }

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
