#!/usr/bin/env node
/* Agente "Rango 9h" (rotura del rango 09:00-10:00 con TP/SL fijos).
   Regla: rango 09:00-10:00 (UTC+2 fijo, como el bot). Desde las 10:00 y hasta las 22:00,
   la primera vela de 5 min que CIERRA fuera del rango da la entrada (una al dia por activo).
   SL/TP: BTC 600/800 puntos, SOL 0.72/1.62, resto 0.5% / 1.12%. Filtro de amplitud
   (250-600 pts) solo en BTC. Solo de lunes a viernes. A las 22:50 se cierra por hora
   lo que siga abierto (como el bot).
   Mensajes por Telegram con el formato del bot: ROTURA INMINENTE (entrada provisional en
   el nivel del rango), la senal con su analisis (DUDOSA por spread, poder/margen, $ y EUR,
   ROI, % del saldo, conveniencia, camino al TP, SL protegido, presion con % de compras a
   mercado de la ultima hora, EQH/EQL de 48 h con toques) y los cierres (TP, SL o por hora).
   Lleva una cartera simulada que empieza con CAPITAL dolares.
   Pensado para correr en bucle dentro de GitHub Actions (workflow rango9h.yml).
   Sin dependencias: Node 18+. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------- configuracion ----------------
const CAPITAL = +(process.env.CAPITAL || 500);                // saldo inicial de la cartera simulada ($)
const POSITION_USD = +(process.env.POSITION_USD || CAPITAL);  // poder (nocional) de cada operacion ($)
const LEVERAGE = +(process.env.LEVERAGE || 20);               // solo para mostrar el margen (poder / apalancamiento)
const RUN_MINUTES = +(process.env.RUN_MINUTES || 0);          // 0 = una sola pasada
const DAEMON = process.env.DAEMON === '1';                     // Railway: siempre encendido, revisa cada pocos segundos
const POLL_SEC = +(process.env.POLL_SEC || 60);
const PUSH_EVERY_MIN = 30;
const TZ_OFF_H = 2;              // UTC+2 fijo todo el ano (como el bot)
const RANGE_H = 9, ENTRY_END_H = 22;
const TIME_EXIT_MIN = 22 * 60 + 50;   // cierre por hora a las 22:50
const DEF_SPREAD_PCT = 0.03;     // spread por lado si no se conoce (% del precio)
// spread por lado deducido de los importes del bot (spread "ya descontado")
const ASSETS = [
  { name: 'BTC',  bin: 'BTCUSDT',  kc: 'BTC-USDT',  mode: 'pts', tp: 800,  sl: 600,  amp: [250, 600] },
  { name: 'HYPE', bin: 'HYPEUSDT', kc: 'HYPE-USDT', mode: 'pct', tp: 1.12, sl: 0.5 },
  { name: 'TAO',  bin: 'TAOUSDT',  kc: 'TAO-USDT',  mode: 'pct', tp: 1.12, sl: 0.5, spread: 0.21 },
  { name: 'HBAR', bin: 'HBARUSDT', kc: 'HBAR-USDT', mode: 'pct', tp: 1.12, sl: 0.5 },
  { name: 'UNI',  bin: 'UNIUSDT',  kc: 'UNI-USDT',  mode: 'pct', tp: 1.12, sl: 0.5 },
  { name: 'SUI',  bin: 'SUIUSDT',  kc: 'SUI-USDT',  mode: 'pct', tp: 1.12, sl: 0.5, spread: 0.00038 },
  { name: 'SOL',  bin: 'SOLUSDT',  kc: 'SOL-USDT',  mode: 'pts', tp: 1.62, sl: 0.72, spread: 0.02 },
  { name: 'LINK', bin: 'LINKUSDT', kc: 'LINK-USDT', mode: 'pct', tp: 1.12, sl: 0.5, spread: 0.003 },
];
const REPO_DATA = path.join(__dirname, '..', 'data');
const DATA = process.env.DATA_DIR || REPO_DATA;   // en Railway: volumen persistente
const STATE = path.join(DATA, 'rango9h-state.json');
const TRADES = path.join(DATA, 'rango9h-trades.json');

// ---------------- utilidades ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loc = (t) => { const d = new Date(t + TZ_OFF_H * 3600e3); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; };
const dayKey = (t) => { const l = loc(t); return `${l.y}-${String(l.mo).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`; };
const hhmm = (t) => { const l = loc(t); return `${String(l.h).padStart(2, '0')}:${String(l.mi).padStart(2, '0')}`; };
const dmy = (t) => { const l = loc(t); return `${String(l.d).padStart(2, '0')}/${String(l.mo).padStart(2, '0')}/${l.y}`; };
const minOfDay = (t) => { const l = loc(t); return l.h * 60 + l.mi; };
const tzParts = (t, tz) => { const p = {}; for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t))) p[x.type] = x.value; return +p.hour * 60 + +p.minute; };
function decimals(p) { return p >= 100 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : 5; }
const fx = (x, ref) => (x == null || !isFinite(x) ? '-' : x.toFixed(decimals(Math.abs(ref ?? x))));
const sgn = (x) => (x >= 0 ? '+' : '-');
const money = (x) => sgn(x) + '$' + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (x, r) => (r ? ` (${sgn(x)}${Math.abs(x / r).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€)` : '');
const pct = (x) => sgn(x) + Math.abs(x).toFixed(2) + '%';
function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }
function saveJSON(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1)); }

let CHAT = process.env.TELEGRAM_CHAT_ID || null;
async function findChat(token) {   // sin TELEGRAM_CHAT_ID: usa el ultimo chat que escribio al bot (/start)
  try { const j = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
    const u = (j.result || []).map((x) => x.message || x.channel_post || x.my_chat_member).filter(Boolean).pop();
    if (u && u.chat) { CHAT = String(u.chat.id); console.log('chat detectado:', CHAT); }
  } catch (e) { console.error('getUpdates:', e.message); }
  return CHAT;
}
async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN; const chat = CHAT || (token ? await findChat(token) : null);
  if (!token || !chat) { console.log('[telegram omitido]\n' + text.replace(/<[^>]+>/g, '') + '\n'); return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) console.error('telegram:', res.status, await res.text());
  } catch (e) { console.error('telegram:', e.message); }
}

// ---------------- datos (Binance publico; KuCoin de respaldo) ----------------
async function getJSON(url) { const r = await fetch(url, { headers: { 'user-agent': 'rango9h-agent' } }); if (!r.ok) throw new Error(r.status + ' ' + url); return r.json(); }
async function klines(a, limit = 700) {
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const rows = await getJSON(`${host}/api/v3/klines?symbol=${a.bin}&interval=5m&limit=${Math.min(limit, 1000)}`);
      if (rows.length) { if (!klines.src) console.log('datos desde', (klines.src = host)); return rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6], tb: k[9] != null ? +k[9] : null })); }
    } catch (e) { /* siguiente fuente */ }
  }
  const end = Math.floor(Date.now() / 1000), start = end - limit * 300;
  if (klines.src !== 'kucoin') console.log('datos desde', (klines.src = 'kucoin'));
  const j = await getJSON(`https://api.kucoin.com/api/v1/market/candles?type=5min&symbol=${a.kc}&startAt=${start}&endAt=${end}`);
  return (j.data || []).map((k) => ({ t: +k[0] * 1000, o: +k[1], c: +k[2], h: +k[3], l: +k[4], v: +k[5], ct: +k[0] * 1000 + 299999, tb: null })).sort((x, y) => x.t - y.t);
}
async function eurusd() {
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try { const j = await getJSON(`${host}/api/v3/ticker/price?symbol=EURUSDT`); if (+j.price > 0) return +j.price; } catch (e) { /* siguiente */ }
  }
  return null;
}

// ---------------- indicadores ----------------
function ema(vals, n) { const out = []; const k = 2 / (n + 1); vals.forEach((v, i) => out.push(i ? out[i - 1] + (v - out[i - 1]) * k : v)); return out; }
function rsi(vals, n = 14) { const out = []; let ag = 0, al = 0; for (let i = 0; i < vals.length; i++) { const ch = i ? vals[i] - vals[i - 1] : 0, g = Math.max(ch, 0), l = Math.max(-ch, 0); if (i <= n) { ag += g / n; al += l / n; } else { ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n; } out.push(i < n ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al)); } return out; }
function atr(B, n = 14) { const out = []; for (let i = 0; i < B.length; i++) { const tr = i ? Math.max(B[i].h - B[i].l, Math.abs(B[i].h - B[i - 1].c), Math.abs(B[i].l - B[i - 1].c)) : B[i].h - B[i].l; out.push(i < n ? tr : (out[i - 1] * (n - 1) + tr) / n); } return out; }
function pivots(B, upto, n = 5) { // pivotes confirmados hasta la vela 'upto'
  const hi = [], lo = [];
  for (let c = n; c <= upto - n; c++) {
    let isH = true, isL = true;
    for (let k = c - n; k <= c + n; k++) { if (k === c) continue; if (k < c ? !(B[c].h > B[k].h) : !(B[c].h >= B[k].h)) isH = false; if (k < c ? !(B[c].l < B[k].l) : !(B[c].l <= B[k].l)) isL = false; }
    if (isH) hi.push({ i: c, v: B[c].h }); if (isL) lo.push({ i: c, v: B[c].l });
  }
  return { hi, lo };
}

// ---------------- dinero (formato del bot) ----------------
// $ = poder x (distancia -/+ 2 x spread) / entrada ; ROI sobre el poder ; % sobre el saldo
function moneyLines(a, e, tp, sl, balance, rate) {
  const sp = a.spread ?? e * DEF_SPREAD_PCT / 100;
  const tpD = Math.abs(tp - e), slD = Math.abs(sl - e);
  const tpUsd = POSITION_USD * (tpD - 2 * sp) / e, slUsd = POSITION_USD * (slD + 2 * sp) / e;
  const txt = [
    `💰 Poder ${POSITION_USD.toLocaleString('en-US')}$ (margen ${(POSITION_USD / LEVERAGE).toLocaleString('en-US', { maximumFractionDigits: 2 })}$ a ${LEVERAGE}x)`,
    `🎯 TP ${money(tpUsd)}${eur(tpUsd, rate)} · ROI ${pct(tpUsd / POSITION_USD * 100)} · ${pct(tpUsd / balance * 100)} del saldo`,
    `🛑 SL ${money(-slUsd)}${eur(-slUsd, rate)} · ROI ${pct(-slUsd / POSITION_USD * 100)} · ${pct(-slUsd / balance * 100)} del saldo`,
    `<i>Spread ${fx(sp, e)} pts/lado ya descontado</i>`,
  ].join('\n');
  return { txt, tpUsd, slUsd, sp, tpD, slD };
}
function planBlock(e, tp, sl, m) {
  return `<pre>ENTRADA  ${fx(e)}\nTP       ${fx(tp, e)}   +${fx(m.tpD, e)} pts   ${money(m.tpUsd)}\nSL fijo  ${fx(sl, e)}   -${fx(m.slD, e)} pts   ${money(-m.slUsd)}  ← plan</pre>`;
}

// ---------------- analisis tipo bot ----------------
function eqLevels(B, i, A) {
  const pv = pivots(B, i), from = Math.max(0, i - 576), tol = A[i] * 0.15;
  const eq = (arr, isHi) => { const ps = arr.filter((p) => p.i >= from); const lv = [];
    for (let x = 0; x < ps.length; x++) for (let y = x + 1; y < ps.length; y++) if (Math.abs(ps[x].v - ps[y].v) <= tol) { const v = isHi ? Math.max(ps[x].v, ps[y].v) : Math.min(ps[x].v, ps[y].v); if (!lv.some((q) => Math.abs(q.v - v) <= tol)) lv.push({ v }); }
    for (const q of lv) { let n = 0, last = 0; for (let k = from; k <= i; k++) { const px = isHi ? B[k].h : B[k].l; if (Math.abs(px - q.v) <= tol) { n++; last = B[k].t; } } q.n = n; q.last = last; }
    return lv; };
  return { pv, tol, eqh: eq(pv.hi, true), eql: eq(pv.lo, false) };
}
function pathLines(dir, e, tp, sl, lv) {
  const { eqh, eql, tol } = lv; const pts = (x) => fx(x, e); const L = [];
  const tpSide = dir === -1 ? eql : eqh, slSide = dir === -1 ? eqh : eql, slD = Math.abs(sl - e);
  const tpLv = tpSide.filter((q) => (dir === -1 ? q.v < e && q.v > tp : q.v > e && q.v < tp)).sort((x, y) => Math.abs(x.v - e) - Math.abs(y.v - e));
  const slLv = slSide.filter((q) => (dir === -1 ? q.v > e && q.v < sl + slD * 0.3 : q.v < e && q.v > sl - slD * 0.3)).sort((x, y) => Math.abs(x.v - e) - Math.abs(y.v - e));
  if (tpLv.length) { const q = tpLv[0]; const prud = q.v + (dir === -1 ? tol : -tol);
    L.push(`🧱 ${dir === -1 ? 'EQL' : 'EQH'} de 48 h (${q.n} toques en 5 min) en ${pts(q.v)} (${sgn(dir * (q.v - e))}${pts(Math.abs(q.v - e))} pts, ultimo toque ${dmy(q.last)}) antes del TP: TP prudente ≈ ${pts(prud)} (${sgn(dir * (prud - e))}${pts(Math.abs(prud - e))})${tpLv.length > 1 ? ` · ${tpLv.length - 1} mas en el camino` : ''}`);
  } else L.push(`🧱 Camino al TP sin EQL/EQH de 48 h hasta ${pts(tp)}`);
  if (slLv.length) { const q = slLv[0]; const beh = q.v + (dir === -1 ? tol : -tol);
    L.push(`🛡 ${dir === -1 ? 'EQH' : 'EQL'} de 48 h (${q.n} toques en 5 min) en ${pts(q.v)} (-${pts(Math.abs(q.v - e))} pts) entre la entrada y el SL: SL tras el nivel ≈ ${pts(beh)} (-${pts(Math.abs(beh - e))})`); }
  return L.join('\n');
}
function analyze(a, B, i, dir, e, sl, tp) {
  const closes = B.map((b) => b.c);
  const E20 = ema(closes, 20), E50 = ema(closes, 50), E200 = ema(closes, 200), R = rsi(closes), A = atr(B);
  const lv = eqLevels(B, i, A), pv = lv.pv;
  // estructura SMC: ultima ruptura de un swing
  let smc = 0, lsh = null, lsl = null; const hiByI = new Map(pv.hi.map((p) => [p.i + 5, p.v])), loByI = new Map(pv.lo.map((p) => [p.i + 5, p.v]));
  for (let k = 0; k <= i; k++) { if (hiByI.has(k)) lsh = hiByI.get(k); if (loByI.has(k)) lsl = loByI.get(k); if (lsh !== null && B[k].c > lsh) smc = 1; else if (lsl !== null && B[k].c < lsl) smc = -1; }
  // sesion: rango de apertura de Londres (08:00-08:30 Londres) y, abierto NY, el de Wall Street (09:30-10:00 NY)
  let lon = null, ny = null; const today = dayKey(B[i].t);
  for (let k = 0; k <= i; k++) { if (dayKey(B[k].t) !== today) continue; const lm = tzParts(B[k].t, 'Europe/London'), nm = tzParts(B[k].t, 'America/New_York');
    if (lm >= 480 && lm < 510) lon = lon ? [Math.max(lon[0], B[k].h), Math.min(lon[1], B[k].l)] : [B[k].h, B[k].l];
    if (nm >= 570 && nm < 600) ny = ny ? [Math.max(ny[0], B[k].h), Math.min(ny[1], B[k].l)] : [B[k].h, B[k].l]; }
  const ses = tzParts(B[i].t, 'America/New_York') >= 600 && ny ? ny : lon;
  const sesV = ses ? (e > ses[0] ? 1 : e < ses[1] ? -1 : 0) : null;
  const emaV = e > E50[i] && E50[i] > E200[i] ? 1 : e < E50[i] && E50[i] < E200[i] ? -1 : 0;
  const rsiV = R[i] >= 70 ? -1 : R[i] <= 30 ? 1 : 0;
  const mk = (v) => (v === null ? '—' : v * dir > 0 ? '✓' : v * dir < 0 ? '✗' : '·');
  const trendOk = (emaV * dir === 1 || rsiV * dir === 1) && smc * dir === 1 && (sesV === null || sesV * dir === 1);
  const sw = dir === -1 ? pv.lo : pv.hi;
  const obst = sw.filter((p) => (dir === -1 ? p.v < e && p.v > tp : p.v > e && p.v < tp)).sort((x, y) => Math.abs(x.v - e) - Math.abs(y.v - e))[0];
  const beyond = sw.filter((p) => (dir === -1 ? p.v <= tp : p.v >= tp)).sort((x, y) => Math.abs(x.v - e) - Math.abs(y.v - e))[0];
  const prot = (dir === -1 ? pv.hi : pv.lo).filter((p) => (dir === -1 ? p.v > e && p.v < sl : p.v < e && p.v > sl)).sort((x, y) => Math.abs(y.v - e) - Math.abs(x.v - e))[0];
  // presion: EMA 20 + RSI + % de compras a mercado (taker buy) de la ultima hora
  let tbTxt = ''; { let v = 0, tb = 0, ok = true; for (let k = Math.max(0, i - 11); k <= i; k++) { v += B[k].v; if (B[k].tb == null) ok = false; else tb += B[k].tb; } if (ok && v > 0) tbTxt = ` · compras a mercado ${Math.round(tb / v * 100)} % del volumen (1 h)`; }
  const strong = dir === -1 ? e < E20[i] && R[i] < 40 : e > E20[i] && R[i] > 60;
  const press = dir === -1 ? e < E20[i] && R[i] < 50 : e > E20[i] && R[i] > 50;
  const pts = (x) => fx(x, e);
  const L = [];
  L.push(`🧭 <b>Conveniencia ${dir === 1 ? 'LONG' : 'SHORT'}:</b> ${trendOk ? '✅ favorable' : obst ? '⛔ desfavorable' : '🟡 con reservas'}`);
  L.push(`   ${trendOk ? '✅' : '⚠️'} Filtro de tendencia ${trendOk ? 'a favor' : 'en contra (riesgo)'}: SMC ${mk(smc)} · Sesion ${mk(sesV)} · EMA ${mk(emaV)} · RSI ${mk(rsiV)}${trendOk ? '' : ' (falta: ' + [smc * dir !== 1 && 'SMC', sesV !== null && sesV * dir !== 1 && 'Sesion', emaV * dir !== 1 && rsiV * dir !== 1 && 'EMA o RSI'].filter(Boolean).join(', ') + ')'}`);
  L.push(obst ? `   ⚠️ ${dir === -1 ? 'Suelo' : 'Techo'} a ${pts(Math.abs(obst.v - e))} pts, antes del TP (${pts(Math.abs(tp - e))} pts): swing ${dir === -1 ? 'low' : 'high'} ${pts(obst.v)}`
    : `   ✅ Camino libre hasta el TP${beyond ? `: ${dir === -1 ? 'suelo' : 'techo'} mas cercano a ${pts(Math.abs(beyond.v - e))} pts (swing ${dir === -1 ? 'low' : 'high'} ${pts(beyond.v)})` : ''}`);
  L.push(prot ? `   ✅ SL ${dir === -1 ? 'sobre el ultimo maximo' : 'bajo el ultimo minimo'} (${pts(prot.v)}): protegido por la estructura` : `   ⚠️ SL sin estructura detras`);
  L.push(press ? `   • Presion ${dir === -1 ? 'vendedora' : 'compradora'}${strong ? ' con fuerza' : ''}: precio ${dir === -1 ? 'bajo' : 'sobre'} la EMA 20, RSI ${R[i].toFixed(0)}${tbTxt}` : `   • Sin presion clara: EMA 20 / RSI ${R[i].toFixed(0)}${tbTxt}`);
  L.push(`   <i>Reglas orientativas (ICT/SMC): en nuestro backtest de 1 ano no cambiaron el acierto a igual stop.</i>`);
  L.push(pathLines(dir, e, tp, sl, lv));
  return { text: L.join('\n'), conv: trendOk ? 'favorable' : obst ? 'desfavorable' : 'con reservas', lv };
}

// ---------------- logica del rango ----------------
function slTp(a, e, dir) {
  const sl = a.mode === 'pts' ? e - dir * a.sl : e * (1 - dir * a.sl / 100);
  const tp = a.mode === 'pts' ? e + dir * a.tp : e * (1 + dir * a.tp / 100);
  return { sl, tp };
}
function rangeOf(B, today) { let hi = -Infinity, lo = Infinity, n = 0; for (const b of B) if (dayKey(b.t) === today && loc(b.t).h === RANGE_H) { hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); n++; } return n >= 12 ? { hi, lo } : null; }
const riskLine = (slD, tpD) => `🚦 ${slD / tpD <= 1.5 ? '🟢 riesgo bajo' : '🟡 riesgo alto'}: si falla pierde ${(slD / tpD).toFixed(1)} veces lo que gana`;

async function closeTrade(a, tr, trades, px, t, kind, rate) {
  const sp = a.spread ?? tr.e * DEF_SPREAD_PCT / 100;
  const move = tr.dir * (px - tr.e), net = move - 2 * sp;
  const pnl = kind === 'TP' ? tr.tpUsd : kind === 'SL' ? -tr.slUsd : POSITION_USD * net / tr.e;
  const before = trades.balance;
  tr.res = kind; tr.t_close = t; tr.px_close = px; tr.pnl = +pnl.toFixed(2);
  trades.balance = +(before + tr.pnl).toFixed(2);
  const head = kind === 'TIME' ? '⏰' : kind === 'TP' ? '✅' : '❌';
  const what = kind === 'TIME' ? `CIERRE POR HORA · <b>${pnl >= 0 ? 'ganancia' : 'perdida'}</b>` : kind === 'TP' ? '<b>TP alcanzado · ganada</b>' : '<b>SL alcanzado · perdida</b>';
  await telegram(`${head} ${a.bin} · ${a.name} Rango 9h · ${dmy(tr.t_entry)} ${hhmm(tr.t_entry + 300000)}\n${what} a las ${hhmm(t)}\n${tr.dir === 1 ? 'LONG' : 'SHORT'} desde ${fx(tr.e)} → ${sgn(move)}${fx(Math.abs(move), tr.e)} pts (neto ${sgn(net)}${fx(Math.abs(net), tr.e)} tras spread)\n💰 ${money(pnl)}${eur(pnl, rate)} · ROI ${pct(pnl / POSITION_USD * 100)} · ${pct(pnl / before * 100)} del saldo · saldo ${trades.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}$${rate ? ` (${(trades.balance / rate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}€)` : ''}${tr.dudosa_cierre ? '\n<i>La vela toco TP y SL: se cuenta como SL</i>' : ''}`);
}

async function processAsset(a, st, trades, now, rate) {
  let B;
  try { B = await klines(a); } catch (e) { console.error(a.name, 'sin datos:', e.message); return; }
  const closed = B.filter((b) => b.ct < now);
  if (!closed.length) return;
  const live = B[B.length - 1];
  // 1) operaciones abiertas: SL primero si la vela toca los dos; a las 22:50 cierre por hora
  for (const tr of trades.list.filter((x) => x.asset === a.name && !x.res)) {
    for (const b of closed.filter((x) => x.t > tr.t_entry)) {
      const hs = tr.dir === 1 ? b.l <= tr.sl : b.h >= tr.sl, ht = tr.dir === 1 ? b.h >= tr.tp : b.l <= tr.tp;
      if (hs || ht) { tr.dudosa_cierre = hs && ht; await closeTrade(a, tr, trades, hs ? tr.sl : tr.tp, b.ct + 1, hs ? 'SL' : 'TP', rate); break; }
      const endT = b.ct + 1;   // cierre por hora: vela que termina a las 22:50 (o la primera de otro dia)
      if (dayKey(b.t) !== tr.day || minOfDay(endT) >= TIME_EXIT_MIN) { await closeTrade(a, tr, trades, b.c, endT, 'TIME', rate); break; }
    }
  }
  // 2) senal del dia
  const today = dayKey(now), l = loc(now);
  const s = (st.assets[a.name] ||= {});
  if (s.day !== today) { s.day = today; s.done = false; s.pre = false; s.note = ''; }
  if (s.done || l.dow === 0 || l.dow === 6) return;
  const r = rangeOf(closed, today);
  if (!r) return;
  const idx = closed.findIndex((b) => dayKey(b.t) === today && loc(b.t).h >= RANGE_H + 1 && loc(b.t).h < ENTRY_END_H && (b.c > r.hi || b.c < r.lo));
  if (idx === -1) {
    // ROTURA INMINENTE: la vela en curso ya esta fuera del rango (entrada provisional = nivel del rango)
    if (!s.pre && l.h >= RANGE_H + 1 && l.h < ENTRY_END_H && live.ct >= now && (live.c > r.hi || live.c < r.lo)) {
      s.pre = true; const dir = live.c > r.hi ? 1 : -1; const lvl = dir === 1 ? r.hi : r.lo; const p = slTp(a, lvl, dir);
      const m = moneyLines(a, lvl, p.tp, p.sl, trades.balance, rate); const dud = Math.abs(live.c - lvl) < m.sp;
      const iL = B.length - 1; const lv = eqLevels(B, iL, atr(B));
      await telegram(`⚡⚡⚡ <b>ROTURA INMINENTE</b> ⚡⚡⚡${dud ? '\n⚠️⚠️⚠️ <b>DUDOSA · OJO AL SPREAD</b> ⚠️⚠️⚠️' : ''}\n📏 ${a.name}/USDT · ${a.name} Rango 9h · ${dmy(now)} ${hhmm(now)}\nPrecio ${fx(live.c)} · ya ${dir === 1 ? 'por encima del maximo' : 'por debajo del minimo'} ${fx(lvl, live.c)} (${fx(Math.abs(live.c - lvl), live.c)} pts): si la vela de las ${hhmm(live.ct + 1)} cierra asi, entra\n${a.name} Rango 9h: ${fx(r.lo, live.c)} - ${fx(r.hi, live.c)}\nSi una vela de 5 min cierra ${dir === 1 ? 'por encima de' : 'por debajo de'} ${fx(lvl, live.c)} → ${dir === 1 ? '🟢 LONG' : '🔴 SHORT'}\n${planBlock(lvl, p.tp, p.sl, m)}\n${m.txt}\n${pathLines(dir, lvl, p.tp, p.sl, lv)}\n<i>La entrada real sera el cierre de la vela que rompa; los importes son aproximados.</i>`);
    }
    return;
  }
  const b = closed[idx]; s.done = true;
  const dir = b.c > r.hi ? 1 : -1, e = b.c;
  if (a.amp) { const amp = r.hi - r.lo; if (amp < a.amp[0] || amp > a.amp[1]) { s.note = `filtrada: amplitud ${fx(amp, e)} fuera de ${a.amp[0]}-${a.amp[1]}`; return; } }
  if (now - b.ct > 30 * 60e3) { s.note = 'senal antigua (el agente no estaba activo): no se envia'; return; }
  const { sl, tp } = slTp(a, e, dir);
  const iFull = B.findIndex((x) => x.t === b.t);
  const m = moneyLines(a, e, tp, sl, trades.balance, rate);
  const an = analyze(a, B, iFull, dir, e, sl, tp);
  const dud = Math.abs(e - (dir === 1 ? r.hi : r.lo)) < m.sp;
  trades.list.push({ asset: a.name, day: today, dir, e, sl, tp, t_entry: b.t, tpUsd: +m.tpUsd.toFixed(2), slUsd: +m.slUsd.toFixed(2), dudosa: dud, conveniencia: an.conv, res: null });
  const head = dir === 1 ? '🟢🟢🟢 <b>LONG</b> 🟢🟢🟢' : '🔴🔴🔴 <b>SHORT</b> 🔴🔴🔴';
  await telegram(`${head}${dud ? '\n⚠️⚠️⚠️ <b>DUDOSA · OJO AL SPREAD</b> ⚠️⚠️⚠️' : ''}\n📏 ${a.bin} · ${a.name} Rango 9h · ${dmy(b.ct)} ${hhmm(b.ct + 1)}\n${a.name} Rango 9h: ${fx(r.lo, e)} - ${fx(r.hi, e)}\n${planBlock(e, tp, sl, m)}\n${riskLine(m.slD, m.tpD)}\n${m.txt}\n${an.text}\n\n<i>Rango 9h · senal educativa, no es asesoramiento financiero</i>`);
}

function pushState(msg) {
  if (!process.env.GITHUB_ACTIONS) return;
  try {
    execSync('git config user.name "github-actions[bot]" && git config user.email "github-actions[bot]@users.noreply.github.com"');
    execSync(`git add data/rango9h-state.json data/rango9h-trades.json`);
    try { execSync(`git commit -m "${msg} [skip ci]"`); } catch (e) { return; } // nada que guardar
    for (let k = 0; k < 3; k++) { try { execSync('git pull --rebase --autostash -q && git push -q'); return; } catch (e) { execSync('sleep 5'); } }
  } catch (e) { console.error('push:', e.message); }
}

// espera hasta 3 s despues del proximo cierre de vela de 5 min, o 20 s como maximo (para el aviso de rotura inminente)
function nextWait() { const now = Date.now(), toClose = 300e3 - (now % 300e3) + 3e3; return Math.max(2e3, Math.min(toClose, 20e3)); }

async function main() {
  if (DATA !== REPO_DATA) for (const f of ['rango9h-state.json', 'rango9h-trades.json'])   // primera vez en el volumen: copia el estado del repo
    if (!fs.existsSync(path.join(DATA, f)) && fs.existsSync(path.join(REPO_DATA, f))) { fs.mkdirSync(DATA, { recursive: true }); fs.copyFileSync(path.join(REPO_DATA, f), path.join(DATA, f)); }
  const first = !fs.existsSync(STATE) || (DAEMON && !loadJSON(STATE, {}).daemon);
  const st = loadJSON(STATE, { assets: {} });
  const trades = loadJSON(TRADES, null) || { capital: CAPITAL, balance: CAPITAL, list: [] };
  const t0 = Date.now(); let lastPush = Date.now();
  if (first) await telegram(`✅ <b>Agente Rango 9h activado</b>\nActivos: ${ASSETS.map((x) => x.name).join(', ')}\nCartera simulada: $${CAPITAL} · poder $${POSITION_USD} por operacion\nRango 09:00-10:00 (UTC+2) · entradas de 10:00 a 22:00, lunes a viernes · cierre por hora 22:50`);
  let rate = null, rateT = 0;
  do {
    const now = Date.now();
    if (now - rateT > 30 * 60e3) { rate = (await eurusd()) || rate; rateT = now; }
    for (const a of ASSETS) await processAsset(a, st, trades, now, rate);
    st.updated = new Date(now).toISOString(); if (DAEMON) st.daemon = true;
    saveJSON(STATE, st); saveJSON(TRADES, trades);
    if (Date.now() - lastPush > PUSH_EVERY_MIN * 60e3) { pushState('chore: estado rango9h'); lastPush = Date.now(); }
    if (DAEMON) { await sleep(nextWait()); continue; }
    if (!RUN_MINUTES) break;
    const open = trades.list.some((x) => !x.res);
    if (minOfDay(Date.now()) >= TIME_EXIT_MIN + 5 && !open) break;   // fuera de horario y sin operaciones abiertas
    if (Date.now() - t0 > RUN_MINUTES * 60e3) break;
    await sleep(POLL_SEC * 1000);
  } while (true);
  pushState('chore: estado rango9h');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { slTp, rangeOf, analyze, dayKey, loc, ASSETS, processAsset, moneyLines };
