#!/usr/bin/env node
/* Agente "Rango 9h" (replica del bot del grupo Bibifury, reconstruida con sus mensajes).
   Regla: rango 09:00-10:00 (UTC+2 fijo, como el bot). Desde las 10:00 y hasta las 22:00,
   la primera vela de 5 min que CIERRA fuera del rango da la entrada (una al dia por activo).
   SL/TP: BTC 600/800 puntos, SOL 0.72/1.62, resto 0.5% / 1.12%. Filtro de amplitud
   (250-600 pts) solo en BTC. Solo de lunes a viernes.
   Envia por Telegram: aviso previo "ROTURA INMINENTE", la senal con el analisis tipo bot
   (dudosa por spread, dolares con spread descontado, conveniencia, camino al TP, SL
   protegido, EQH/EQL de 48 h con toques) y el cierre por TP/SL. Lleva una cartera
   simulada (paper trading) que empieza con CAPITAL dolares.
   Pensado para correr en bucle dentro de GitHub Actions (workflow rango9h.yml).
   Sin dependencias: Node 18+. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---------------- configuracion ----------------
const CAPITAL = +(process.env.CAPITAL || 500);            // saldo inicial de la cartera simulada ($)
const POSITION_USD = +(process.env.POSITION_USD || CAPITAL); // tamano (nocional) de cada operacion ($)
const RUN_MINUTES = +(process.env.RUN_MINUTES || 0);       // 0 = una sola pasada
const POLL_SEC = +(process.env.POLL_SEC || 60);
const PUSH_EVERY_MIN = 30;
const TZ_OFF_H = 2;            // UTC+2 fijo todo el ano (como el bot)
const RANGE_H = 9, ENTRY_END_H = 22;
const DEF_SPREAD_PCT = 0.03;   // spread por lado si no se conoce (% del precio)
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
const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'rango9h-state.json');
const TRADES = path.join(DATA, 'rango9h-trades.json');

// ---------------- utilidades ----------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loc = (t) => { const d = new Date(t + TZ_OFF_H * 3600e3); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; };
const dayKey = (t) => { const l = loc(t); return `${l.y}-${String(l.mo).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`; };
const hhmm = (t) => { const l = loc(t); return `${String(l.h).padStart(2, '0')}:${String(l.mi).padStart(2, '0')}`; };
const dmy = (t) => { const l = loc(t); return `${String(l.d).padStart(2, '0')}/${String(l.mo).padStart(2, '0')}/${l.y}`; };
const tzParts = (t, tz) => { const p = {}; for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t))) p[x.type] = x.value; return +p.hour * 60 + +p.minute; };
function decimals(p) { return p >= 1000 ? 2 : p >= 100 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : 5; }
const fx = (x, ref) => (x == null || !isFinite(x) ? '-' : x.toFixed(decimals(ref ?? x)));
const usd = (x) => (x >= 0 ? '+' : '-') + '$' + Math.abs(x).toFixed(2);
function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; } }
function saveJSON(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 1)); }

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
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
      if (rows.length) return rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], ct: k[6] }));
    } catch (e) { /* siguiente fuente */ }
  }
  const end = Math.floor(Date.now() / 1000), start = end - limit * 300;
  const j = await getJSON(`https://api.kucoin.com/api/v1/market/candles?type=5min&symbol=${a.kc}&startAt=${start}&endAt=${end}`);
  return (j.data || []).map((k) => ({ t: +k[0] * 1000, o: +k[1], c: +k[2], h: +k[3], l: +k[4], v: +k[5], ct: +k[0] * 1000 + 299999 })).sort((x, y) => x.t - y.t);
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

// ---------------- analisis tipo bot ----------------
function analyze(a, B, i, dir, e, sl, tp, rH, rL) {
  const closes = B.map((b) => b.c);
  const E20 = ema(closes, 20), E50 = ema(closes, 50), E200 = ema(closes, 200), R = rsi(closes), A = atr(B);
  const pv = pivots(B, i);
  // estructura SMC: ultima ruptura de un swing
  let smc = 0, lsh = null, lsl = null; const hiByI = new Map(pv.hi.map((p) => [p.i + 5, p.v])), loByI = new Map(pv.lo.map((p) => [p.i + 5, p.v]));
  for (let k = 0; k <= i; k++) { if (hiByI.has(k)) lsh = hiByI.get(k); if (loByI.has(k)) lsl = loByI.get(k); if (lsh !== null && B[k].c > lsh) smc = 1; else if (lsl !== null && B[k].c < lsl) smc = -1; }
  // sesion: rango de apertura de Londres (08:00-08:30 Londres) y, abierto NY, el de Wall Street (09:30-10:00 NY)
  let lon = null, ny = null; const today = dayKey(B[i].t);
  for (let k = 0; k <= i; k++) { if (dayKey(B[k].t) !== today) continue; const lm = tzParts(B[k].t, 'Europe/London'), nm = tzParts(B[k].t, 'America/New_York');
    if (lm >= 480 && lm < 510) lon = lon ? [Math.max(lon[0], B[k].h), Math.min(lon[1], B[k].l)] : [B[k].h, B[k].l];
    if (nm >= 570 && nm < 600) ny = ny ? [Math.max(ny[0], B[k].h), Math.min(ny[1], B[k].l)] : [B[k].h, B[k].l]; }
  const nmNow = tzParts(B[i].t, 'America/New_York'); const ses = nmNow >= 600 && ny ? ny : lon;
  const sesV = ses ? (e > ses[0] ? 1 : e < ses[1] ? -1 : 0) : null;
  const emaV = e > E50[i] && E50[i] > E200[i] ? 1 : e < E50[i] && E50[i] < E200[i] ? -1 : 0;
  const rsiV = R[i] >= 70 ? -1 : R[i] <= 30 ? 1 : 0;
  const mk = (v) => (v === null ? '—' : v * dir > 0 ? '✓' : v * dir < 0 ? '✗' : '·');
  const trendOk = (emaV * dir === 1 || rsiV * dir === 1) && smc * dir === 1 && (sesV === null || sesV * dir === 1);
  // obstaculo entre la entrada y el TP; estructura detras del SL
  const sw = dir === -1 ? pv.lo : pv.hi;
  const obst = sw.filter((p) => (dir === -1 ? p.v < e && p.v > tp : p.v > e && p.v < tp)).sort((x, y) => Math.abs(x.v - e) - Math.abs(y.v - e))[0];
  const beyond = sw.filter((p) => (dir === -1 ? p.v <= tp : p.v >= tp)).sort((x, y) => Math.abs(x.v - e) - Math.abs(y.v - e))[0];
  const prot = (dir === -1 ? pv.hi : pv.lo).filter((p) => (dir === -1 ? p.v > e && p.v < sl : p.v < e && p.v > sl)).sort((x, y) => Math.abs(y.v - e) - Math.abs(x.v - e))[0];
  const press = dir === -1 ? e < E20[i] && R[i] < 50 : e > E20[i] && R[i] > 50;
  // EQH / EQL de 48 h (velas de 5 min) con toques
  const from = Math.max(0, i - 576), tol = A[i] * 0.15;
  const eq = (arr, isHi) => { const ps = arr.filter((p) => p.i >= from); const lv = []; for (let x = 0; x < ps.length; x++) for (let y = x + 1; y < ps.length; y++) if (Math.abs(ps[x].v - ps[y].v) <= tol) { const v = isHi ? Math.max(ps[x].v, ps[y].v) : Math.min(ps[x].v, ps[y].v); if (!lv.some((q) => Math.abs(q.v - v) <= tol)) lv.push({ v }); }
    for (const q of lv) { let n = 0, last = 0; for (let k = from; k <= i; k++) { const px = isHi ? B[k].h : B[k].l; if (Math.abs(px - q.v) <= tol) { n++; last = B[k].t; } } q.n = n; q.last = last; } return lv; };
  const eqh = eq(pv.hi, true), eql = eq(pv.lo, false);
  const sp = a.spread ?? e * DEF_SPREAD_PCT / 100;
  const tpD = Math.abs(tp - e), slD = Math.abs(sl - e);
  const tpUsd = POSITION_USD * (tpD - 2 * sp) / e, slUsd = POSITION_USD * (slD + 2 * sp) / e;
  const lvlBreak = dir === 1 ? rH : rL, dud = Math.abs(e - lvlBreak) < sp;
  const conv = trendOk ? 'favorable' : obst ? 'desfavorable' : 'con reservas';
  const tpSide = dir === -1 ? eql : eqh, slSide = dir === -1 ? eqh : eql;
  const tpLv = tpSide.filter((q) => (dir === -1 ? q.v < e && q.v > tp : q.v > e && q.v < tp)).sort((x, y) => Math.abs(x.v - e) - Math.abs(y.v - e));
  const slLv = slSide.filter((q) => (dir === -1 ? q.v > e && q.v < sl + slD * 0.3 : q.v < e && q.v > sl - slD * 0.3)).sort((x, y) => Math.abs(x.v - e) - Math.abs(y.v - e));
  const pts = (x) => fx(x, e);
  const L = [];
  L.push(`🚦 ${slD / tpD <= 1 ? '🟢 riesgo bajo' : '🟡 riesgo medio'}: si falla pierde ${(slD / tpD).toFixed(1)} veces lo que gana`);
  L.push(`💰 Posicion $${POSITION_USD} · saldo simulado $SALDO_X`);
  L.push(`🎯 TP ${usd(tpUsd)} · ${(tpD / e * 100).toFixed(2)}% del precio`);
  L.push(`🛑 SL ${usd(-slUsd)} · ${(slD / e * 100).toFixed(2)}% del precio`);
  L.push(`<i>Spread ${pts(sp)} pts/lado ya descontado</i>`);
  L.push(`🧭 <b>Conveniencia ${dir === 1 ? 'LONG' : 'SHORT'}:</b> ${trendOk ? '✅ favorable' : obst ? '⛔ desfavorable' : '🟡 con reservas'}`);
  L.push(`${trendOk ? '✅' : '⚠️'} Filtro de tendencia ${trendOk ? 'a favor' : 'en contra (riesgo)'}: SMC ${mk(smc)} · Sesion ${mk(sesV)} · EMA ${mk(emaV)} · RSI ${mk(rsiV)}`);
  L.push(obst ? `⚠️ ${dir === -1 ? 'Suelo' : 'Techo'} a ${pts(Math.abs(obst.v - e))} pts, antes del TP (${pts(tpD)} pts): swing ${dir === -1 ? 'low' : 'high'} ${pts(obst.v)}`
    : `✅ Camino libre hasta el TP${beyond ? `: ${dir === -1 ? 'suelo' : 'techo'} mas cercano a ${pts(Math.abs(beyond.v - e))} pts (swing ${pts(beyond.v)})` : ''}`);
  L.push(prot ? `✅ SL ${dir === -1 ? 'sobre el ultimo maximo' : 'bajo el ultimo minimo'} (${pts(prot.v)}): protegido por la estructura` : `⚠️ SL sin estructura detras`);
  L.push(press ? `• Presion ${dir === -1 ? 'vendedora' : 'compradora'}: precio ${dir === -1 ? 'bajo' : 'sobre'} la EMA 20, RSI ${R[i].toFixed(0)}` : `• Sin presion clara (EMA 20 / RSI ${R[i].toFixed(0)})`);
  if (tpLv.length) { const q = tpLv[0]; const prud = q.v + (dir === -1 ? tol : -tol);
    L.push(`🧱 ${dir === -1 ? 'EQL' : 'EQH'} de 48 h (${q.n} toques en 5 min) en ${pts(q.v)} (${pts(Math.abs(q.v - e))} pts, ultimo toque ${dmy(q.last)}) antes del TP: TP prudente ≈ ${pts(prud)}${tpLv.length > 1 ? ` · ${tpLv.length - 1} mas en el camino` : ''}`);
  } else L.push(`🧱 Camino al TP sin EQL/EQH de 48 h hasta ${pts(tp)}`);
  if (slLv.length) { const q = slLv[0]; L.push(`🛡 ${dir === -1 ? 'EQH' : 'EQL'} de 48 h (${q.n} toques en 5 min) en ${pts(q.v)} entre la entrada y el SL: SL tras el nivel ≈ ${pts(q.v + (dir === -1 ? tol : -tol))}`); }
  L.push(`<i>Reglas orientativas (ICT/SMC): en nuestro backtest de 1 ano no cambiaron el acierto de forma fiable.</i>`);
  return { text: L.join('\n'), dud, tpUsd, slUsd, sp, conv, trendOk };
}

// ---------------- logica del rango ----------------
function slTp(a, e, dir) {
  const sl = a.mode === 'pts' ? e - dir * a.sl : e * (1 - dir * a.sl / 100);
  const tp = a.mode === 'pts' ? e + dir * a.tp : e * (1 + dir * a.tp / 100);
  return { sl, tp };
}
function rangeOf(B, today) { let hi = -Infinity, lo = Infinity, n = 0; for (const b of B) if (dayKey(b.t) === today && loc(b.t).h === RANGE_H) { hi = Math.max(hi, b.h); lo = Math.min(lo, b.l); n++; } return n >= 12 ? { hi, lo } : null; }

async function processAsset(a, st, trades, now) {
  let B;
  try { B = await klines(a); } catch (e) { console.error(a.name, 'sin datos:', e.message); return; }
  const closed = B.filter((b) => b.ct < now);
  if (!closed.length) return;
  const live = B[B.length - 1];
  // 1) seguimiento de operaciones abiertas (SL primero si la vela toca los dos)
  for (const tr of trades.list.filter((x) => x.asset === a.name && !x.res)) {
    for (const b of closed.filter((x) => x.t > tr.t_entry)) {
      const hs = tr.dir === 1 ? b.l <= tr.sl : b.h >= tr.sl, ht = tr.dir === 1 ? b.h >= tr.tp : b.l <= tr.tp;
      if (hs || ht) {
        tr.res = hs ? 'SL' : 'TP'; tr.t_close = b.t; tr.dudosa_cierre = hs && ht;
        tr.pnl = +(hs ? -tr.slUsd : tr.tpUsd).toFixed(2);
        trades.balance = +(trades.balance + tr.pnl).toFixed(2);
        await telegram(`${hs ? '❌ <b>PERDIDA</b>' : '✅ <b>GANADA</b>'} · ${a.name} Rango 9h · ${dmy(tr.t_entry)} ${hhmm(tr.t_entry + 300000)}\n${tr.dir === 1 ? 'LONG' : 'SHORT'} ${fx(tr.e)} → ${hs ? 'SL' : 'TP'} ${fx(hs ? tr.sl : tr.tp, tr.e)}  (${hhmm(b.t)})\n${usd(tr.pnl)} · saldo simulado $${trades.balance.toFixed(2)}${tr.dudosa_cierre ? '\n<i>La vela toco TP y SL: se cuenta como SL</i>' : ''}`);
        break;
      }
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
    // aviso previo: la vela en curso ya esta fuera del rango
    if (!s.pre && l.h >= RANGE_H + 1 && l.h < ENTRY_END_H && live.ct >= now && (live.c > r.hi || live.c < r.lo)) {
      s.pre = true; const dir = live.c > r.hi ? 1 : -1; const lv = dir === 1 ? r.hi : r.lo; const p = slTp(a, live.c, dir);
      const sp = a.spread ?? live.c * DEF_SPREAD_PCT / 100; const dud = Math.abs(live.c - lv) < sp;
      await telegram(`⚡⚡⚡ <b>ROTURA INMINENTE</b> ⚡⚡⚡${dud ? '\n⚠️⚠️⚠️ <b>DUDOSA · OJO AL SPREAD</b> ⚠️⚠️⚠️' : ''}\n📏 ${a.bin} · ${a.name} Rango 9h · ${dmy(now)} ${hhmm(now)}\nPrecio ${fx(live.c)} · ya ${dir === 1 ? 'por encima del maximo' : 'por debajo del minimo'} ${fx(lv, live.c)} (${fx(Math.abs(live.c - lv), live.c)} pts): si la vela de las ${hhmm(live.t)} cierra asi, entra\n${a.name} Rango 9h: ${fx(r.lo, live.c)} - ${fx(r.hi, live.c)}\nSi una vela de 5 min cierra ${dir === 1 ? 'por encima de' : 'por debajo de'} ${fx(lv, live.c)} → ${dir === 1 ? '🟢 LONG' : '🔴 SHORT'}\n<pre>ENTRADA ${fx(live.c)}\nTP      ${fx(p.tp, live.c)}\nSL fijo ${fx(p.sl, live.c)}  ← plan</pre>\n<i>La entrada real sera el cierre de la vela que rompa.</i>`);
    }
    return;
  }
  const b = closed[idx]; s.done = true;
  const dir = b.c > r.hi ? 1 : -1, e = b.c;
  if (a.amp) { const amp = r.hi - r.lo; if (amp < a.amp[0] || amp > a.amp[1]) { s.note = `filtrada: amplitud ${fx(amp, e)} fuera de ${a.amp[0]}-${a.amp[1]}`; return; } }
  if (now - b.ct > 30 * 60e3) { s.note = 'senal antigua (el agente no estaba activo): no se envia'; return; }
  const { sl, tp } = slTp(a, e, dir);
  const iFull = B.findIndex((x) => x.t === b.t);
  const an = analyze(a, B, iFull, dir, e, sl, tp, r.hi, r.lo);
  trades.list.push({ asset: a.name, day: today, dir, e, sl, tp, t_entry: b.t, tpUsd: +an.tpUsd.toFixed(2), slUsd: +an.slUsd.toFixed(2), dudosa: an.dud, conveniencia: an.conv, res: null });
  const head = dir === 1 ? '🟢🟢🟢 <b>LONG</b> 🟢🟢🟢' : '🔴🔴🔴 <b>SHORT</b> 🔴🔴🔴';
  const tpD = Math.abs(tp - e), slD = Math.abs(sl - e);
  await telegram(`${head}${an.dud ? '\n⚠️⚠️⚠️ <b>DUDOSA · OJO AL SPREAD</b> ⚠️⚠️⚠️' : ''}\n📏 ${a.bin} · ${a.name} Rango 9h · ${dmy(b.ct)} ${hhmm(b.ct + 1)}\n${a.name} Rango 9h: ${fx(r.lo, e)} - ${fx(r.hi, e)}\n<pre>ENTRADA ${fx(e)}\nTP      ${fx(tp, e)}   +${fx(tpD, e)} pts  ${usd(an.tpUsd)}\nSL fijo ${fx(sl, e)}   -${fx(slD, e)} pts  ${usd(-an.slUsd)}  ← plan</pre>\n${an.text.replace('SALDO_X', trades.balance.toFixed(2))}\n\n<i>Rango 9h · senal educativa, no es asesoramiento financiero</i>`);
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

async function main() {
  const st = loadJSON(STATE, { assets: {} });
  const trades = loadJSON(TRADES, null) || { capital: CAPITAL, balance: CAPITAL, list: [] };
  const t0 = Date.now(); let lastPush = Date.now();
  do {
    const now = Date.now();
    for (const a of ASSETS) await processAsset(a, st, trades, now);
    st.updated = new Date(now).toISOString();
    saveJSON(STATE, st); saveJSON(TRADES, trades);
    if (Date.now() - lastPush > PUSH_EVERY_MIN * 60e3) { pushState('chore: estado rango9h'); lastPush = Date.now(); }
    if (!RUN_MINUTES) break;
    const l = loc(Date.now()), open = trades.list.some((x) => !x.res);
    if (l.h >= ENTRY_END_H && !open) break;          // fuera de horario y sin operaciones abiertas
    if (Date.now() - t0 > RUN_MINUTES * 60e3) break;
    await sleep(POLL_SEC * 1000);
  } while (true);
  pushState('chore: estado rango9h');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { slTp, rangeOf, analyze, dayKey, loc, ASSETS, processAsset };
