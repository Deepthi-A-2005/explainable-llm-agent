/* Explainable LLM Agent — shared UI + deterministic rule-based router.
 * Model parameters live in js/model.js (single source of truth, also read by tools/evaluate.py). */
const MODEL = (typeof NC_MODEL !== 'undefined') ? NC_MODEL : require('./model.js');

/* ---------- Theme / navigation ---------- */
const THEME_KEY = 'eca-theme';
function safeStorage(op, key, value) {
  try { return op === 'get' ? localStorage.getItem(key) : localStorage.setItem(key, value); }
  catch (e) { return null; }
}
function syncThemeIcon() {
  const light = document.documentElement.classList.contains('light');
  document.querySelectorAll('[data-theme-icon]').forEach(e => { e.textContent = light ? '☾' : '☼'; });
}
function toggleTheme() {
  const light = document.documentElement.classList.toggle('light');
  safeStorage('set', THEME_KEY, light ? 'light' : 'dark');
  syncThemeIcon();
}
function toggleMenu() {
  const links = document.querySelector('.nav-links');
  if (!links) return;
  const open = links.classList.toggle('mobile-open');
  document.querySelector('.menu-btn')?.setAttribute('aria-expanded', String(open));
}
function setActiveNav() {
  const current = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('[data-navlink], .footer-links a').forEach(a => {
    if ((a.getAttribute('href') || '') === current) { a.classList.add('active'); a.setAttribute('aria-current', 'page'); }
  });
}
(function applySavedTheme() {
  const saved = safeStorage('get', THEME_KEY);
  if (typeof document !== 'undefined' && (saved === 'light' || saved === 'dark')) {
    document.documentElement.classList.toggle('light', saved === 'light');
  }
})();
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => { syncThemeIcon(); setActiveNav(); initDemo(); });
}

/* ---------- Scoring ---------- */
function escapeRegExp(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function wordRegex(term) { return new RegExp('\\b' + escapeRegExp(term) + '\\b', 'i'); }
function confidenceFor(score, total) {
  const c = MODEL.confidence;
  return Math.min(c.max, c.shareWeight * (score / total) + c.evidenceWeight * (1 - Math.exp(-score / c.evidenceScale)));
}

/* Returns the prediction contract documented in technical-implementation-and-api-docs.html. */
function classify(text, context = []) {
  const s = text.toLowerCase();
  const scores = {}, cues = {};
  Object.entries(MODEL.intents).forEach(([id, d]) => {
    let raw = 0; const found = [];
    d.keywords.forEach(k => { if (wordRegex(k).test(s)) { raw += MODEL.keywordWeight; found.push({ text: k, weight: MODEL.keywordWeight, type: 'keyword' }); } });
    d.phrases.forEach(p => { if (wordRegex(p).test(s)) { raw += MODEL.phraseWeight; found.push({ text: p, weight: MODEL.phraseWeight, type: 'phrase' }); } });
    if (raw) { scores[id] = raw; cues[id] = found; }
  });

  // Bounded, visible context carryover: only for short messages with weak evidence.
  let contextContribution = null;
  const wordCount = s.split(/\s+/).filter(Boolean).length;
  if (context.length && Object.keys(scores).length <= 1 && wordCount <= MODEL.shortMessageMaxWords) {
    for (const m of context.slice(-MODEL.contextWindow).reverse()) {
      if (m.intent && m.intent !== 'fallback') {
        scores[m.intent] = (scores[m.intent] || 0) + MODEL.contextCarryover;
        contextContribution = { intent: m.intent, weight: MODEL.contextCarryover, source: m.text.slice(0, 90) };
        break;
      }
    }
  }

  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const topId = entries[0]?.[0] || null;
  const confidence = topId ? confidenceFor(entries[0][1], total) : 0;
  const abstained = confidence < MODEL.threshold;
  return {
    intent: abstained ? 'fallback' : topId,
    candidateIntent: topId,
    confidence,
    alternatives: entries.slice(0, 4).map(([id, v]) => ({ id, score: confidenceFor(v, total) })),
    entities: extractEntities(text),
    contextContribution,
    thresholdDecision: { threshold: MODEL.threshold, abstained },
    modelVersion: MODEL.version,
    featureContributions: topId ? (cues[topId] || []) : []
  };
}

function extractEntities(text) {
  const out = [];
  Object.entries(MODEL.entities).forEach(([type, terms]) => terms.forEach(t => {
    const re = new RegExp('\\b' + escapeRegExp(t) + '\\b', 'gi');
    let m; while ((m = re.exec(text)) !== null) out.push({ type, value: t, start: m.index, end: m.index + m[0].length });
  }));
  return out.sort((a, b) => a.start - b.start);
}

/* ---------- Explanation panel ---------- */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])); }
function renderExplanation(target, pred) {
  if (!target) return;
  const pct = Math.round(pred.confidence * 100);
  const thr = Math.round(pred.thresholdDecision.threshold * 100);
  const cueHtml = pred.featureContributions.map(c => `<span class="token hit">${escapeHtml(c.text)} +${c.weight}</span>`).join(' ');
  const ctx = pred.contextContribution;
  let why;
  if (pred.thresholdDecision.abstained && !pred.candidateIntent) why = 'No cue matched, so the router abstained.';
  else if (pred.thresholdDecision.abstained) why = `Best candidate “${escapeHtml(pred.candidateIntent)}” scored below the threshold, so the router abstained.`;
  else if (cueHtml && ctx) why = `Matched ${cueHtml} plus context carryover (+${ctx.weight}).`;
  else if (cueHtml) why = `Matched ${cueHtml}.`;
  else if (ctx) why = `No direct cue matched; the score comes entirely from context carryover (+${ctx.weight}) from an earlier “${escapeHtml(ctx.intent)}” turn.`;
  else why = '—';
  target.innerHTML = `<div class="explain-box">
    <div class="confidence"><div><div class="subtle">Predicted intent</div><strong>${escapeHtml(pred.intent)}</strong></div><span class="tag ${pred.thresholdDecision.abstained ? 'amber' : 'cyan'}">${pct}%</span></div>
    <div class="confidence-bar" role="img" aria-label="Confidence ${pct} percent"><i style="width:${pct}%"></i></div>
    <div class="kv"><b>Decision</b><span>${pred.thresholdDecision.abstained ? `Abstained → fallback (&lt; ${thr}%)` : `Threshold cleared (≥ ${thr}%)`}</span></div>
    <div class="kv"><b>Why</b><span>${why}</span></div>
    <div class="kv"><b>Entities</b><span class="chip-row">${pred.entities.length ? pred.entities.map(e => `<span class="token">${escapeHtml(e.type)}: ${escapeHtml(e.value)} [${e.start}:${e.end}]</span>`).join('') : '—'}</span></div>
    <div class="kv"><b>Alternatives</b><span>${pred.alternatives.map(a => `${escapeHtml(a.id)} ${Math.round(a.score * 100)}%`).join(' · ') || '—'}</span></div>
    <div class="kv"><b>Context</b><span>${ctx ? `Used: ${escapeHtml(ctx.intent)} (+${ctx.weight})` : 'Not used for this turn.'}</span></div>
    <div class="kv"><b>Model</b><span class="mono">${escapeHtml(pred.modelVersion)}</span></div></div>`;
}

/* ---------- Live demo ---------- */
function initDemo() {
  const input = document.querySelector('#demo-input'), send = document.querySelector('#demo-send'),
        chat = document.querySelector('#demo-chat'), inspect = document.querySelector('#demo-explain'),
        clear = document.querySelector('#clear-context');
  if (!input || !send || !chat) return;
  let context = [];
  const replies = {
    internship: 'For a research internship, start with a short target list, then tailor the project evidence to each lab or company. Lead with what you built, how you evaluated it, and what you learned—not generic adjectives.',
    technical: 'Start from the constraint: define the latency, data shape, consistency requirement, or failure mode before choosing an implementation. That makes the architecture defensible in an interview.',
    project: 'Scope the project around one technically defensible contribution. A small system with tests, reproducible setup, architecture notes, and a measured evaluation is stronger than a large feature list.',
    resume: 'Use action + mechanism + evidence. If you do not have a measured outcome, describe the technical mechanism precisely rather than inventing a number.',
    study: 'Use retrieval practice: solve first, read only when blocked, then reconstruct the idea from memory. Track problems solved unaided rather than hours spent reading.',
    greeting: 'Hello. Try asking about an internship, project, resume, study plan, or technical design.'
  };
  const FALLBACK = 'I could not confidently route that message. Try adding a little more context.';

  function addMessage(role, html, meta) {
    const el = document.createElement('div');
    el.className = `message ${role}`;
    el.innerHTML = `<div class="avatar" aria-hidden="true">${role === 'user' ? 'U' : 'AI'}</div><div style="min-width:0;flex:1"><div class="bubble">${html}</div><div class="msg-meta">${meta}</div></div>`;
    chat.appendChild(el);
  }
  function sendMsg() {
    const t = input.value.trim();
    if (!t) return;
    const p = classify(t, context);
    addMessage('user', `<p>${escapeHtml(t)}</p>`, 'USER');
    addMessage('assistant', `<p>${p.intent === 'fallback' ? FALLBACK : replies[p.intent]}</p>`, `LOCAL INFERENCE · ${Math.round(p.confidence * 100)}% CONFIDENCE`);
    context.push({ text: t, intent: p.intent });
    context = context.slice(-MODEL.contextWindow);
    renderExplanation(inspect, p);
    input.value = '';
    chat.scrollTop = chat.scrollHeight;
  }
  send.addEventListener('click', sendMsg);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendMsg(); }   // don't send mid-IME composition (e.g. Japanese input)
  });
  clear?.addEventListener('click', () => {
    context = [];
    inspect.innerHTML = '<div class="explain-box"><div class="subtle">Routing memory cleared. The visible transcript is unchanged.</div></div>';
  });
}

if (typeof module !== 'undefined') module.exports = { classify, extractEntities, MODEL };
