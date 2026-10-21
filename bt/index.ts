// SMC Sniper backtest service (Bun). Mirrors sim4.py / Pine v4 logic.
// GET /run?symbols=BTCUSDT,SOLUSDT&days=90[&trades=1][&param=value...]
// Models: M1 ICT sweep+FVG, M2 Silver Bullet, M3 OTE Fibonacci, M4 Rango 9h contraria, M5 Rango 9h vela 10:00

export type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; k?: number };

export const DEFAULTS: Record<string, number> = {
  piv: 5, mssBars: 12, disp: 1.2, retBars: 24, minScore: 2, maxDay: 1, rr: 2.0,
  slBuf: 0.1, minSL: 0.2, fee: 0.1, ote: 0.705, rgSL: 0.5, rgTP: 1.12, kz: 1,
  rgStartH: 1, rgEntryH: 10, trend: 0, trendLen: 50,
  eqTol: 0.2, eqLook: 100, m6mss: 1,
  m7body: 0, m7mode: 0, m7endH: 22, rgH: 9, m7slP: 0, m7tpP: 0, ampMin: 0, ampMax: 0, tzFix: 0, emaF: 0, auto: 0, tpPrev: 0, prevN: 5, minRR: 1, m7conf: 1, m7reIn: 0, trendF: 0, wkd: 0, tpMode: 0, swP: 12, swLook: 576, tEx: 0, tpFb: 1, volK: 0, volLen: 20, brkAtr: 0, clsPos: 0, rev: 0, reInN: 0, wickMax: 0, stF: 0, st1h: 0, stFac: 2.5, adxMin: 0, adxH: 0, e200: 0, vwF: 0, vwMax: 0, vwMin: 0, haF: 0, zlF: 0, dsF: 0, bbF: 0, seF: 0, dsP: 30,
};
export const TF_MS: Record<string, number> = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000 };
const BYBIT_TF: Record<string, string> = { "5m": "5", "15m": "15", "1h": "60", "4h": "240" };

// ---------- time helpers (DST-aware) ----------
const fmtCache: Record<string, Intl.DateTimeFormat> = {};
const partsMemo: Record<string, Map<number, { date: string; h: number; m: number }>> = {};
function parts(ms: number, tz: string) {
  const memo = (partsMemo[tz] ??= new Map());
  const hit = memo.get(ms);
  if (hit) return hit;
  const r = partsRaw(ms, tz);
  memo.set(ms, r);
  return r;
}
function partsRaw(ms: number, tz: string) {
  const f = (fmtCache[tz] ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }));
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, h: +p.hour, m: +p.minute };
}

// ---------- data ----------
async function getJSON(url: string) {
  const r = await fetch(url, { headers: { "user-agent": "smc-backtest" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function binance(base: string, sym: string, start: number, end: number, tf: string): Promise<Bar[]> {
  const out: Bar[] = [];
  let s = start;
  while (s < end) {
    const rows: any[] = await getJSON(`${base}/api/v3/klines?symbol=${sym}&interval=${tf}&startTime=${s}&endTime=${end}&limit=1000`);
    if (!rows.length) break;
    for (const k of rows) out.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    s = rows[rows.length - 1][0] + TF_MS[tf];
    if (rows.length < 1000) break;
  }
  return out;
}
async function bybit(sym: string, start: number, end: number, tf: string): Promise<Bar[]> {
  const out: Bar[] = [];
  let e = end;
  while (e > start) {
    const j: any = await getJSON(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${BYBIT_TF[tf]}&start=${start}&end=${e}&limit=1000`);
    const rows: any[] = j?.result?.list ?? [];
    if (!rows.length) break;
    for (const k of rows) out.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    e = +rows[rows.length - 1][0] - TF_MS[tf];
    if (rows.length < 1000) break;
  }
  return out.sort((a, b) => a.t - b.t);
}
const cache = new Map<string, { at: number; bars: Bar[]; src: string }>();
export async function loadBars(sym: string, days: number, tf = "5m") {
  const key = `${sym}:${days}:${tf}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 90 * 60 * 1000) return hit;
  const end = Math.floor(Date.now() / TF_MS[tf]) * TF_MS[tf] - 1; // only closed candles
  const start = end - days * 86400000;
  const tries: [string, () => Promise<Bar[]>][] = [
    ["binance", () => binance("https://api.binance.com", sym, start, end, tf)],
    ["binance-vision", () => binance("https://data-api.binance.vision", sym, start, end, tf)],
    ["bybit", () => bybit(sym, start, end, tf)],
  ];
  const errs: string[] = [];
  for (const [src, fn] of tries) {
    try {
      const bars = dedupe(await fn(), TF_MS[tf]);
      if (bars.length > 100) { const v = { at: Date.now(), bars, src }; cache.set(key, v); return v; }
      errs.push(`${src}: ${bars.length} velas`);
    } catch (e: any) { errs.push(`${src}: ${e.message}`); }
  }
  throw new Error(errs.join(" | "));
}
// daily ATR(14) (RMA) per UTC day; value used on day D = ATR of day D-1
export function dailyAtr(B: Bar[]) {
  const days: { d: string; h: number; l: number; c: number }[] = [];
  for (const b of B) { const d = new Date(b.t).toISOString().slice(0, 10); const x = days[days.length - 1];
    if (!x || x.d !== d) days.push({ d, h: b.h, l: b.l, c: b.c }); else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; } }
  const m = new Map<string, number>(); let atr: number | null = null; const trs: number[] = [];
  for (let j = 0; j < days.length; j++) {
    const x = days[j]; const tr = j ? Math.max(x.h - x.l, Math.abs(x.h - days[j - 1].c), Math.abs(x.l - days[j - 1].c)) : x.h - x.l;
    if (j + 1 < days.length && atr !== null) m.set(days[j + 1].d, atr);
    trs.push(tr); if (trs.length === 14) atr = trs.reduce((a, v) => a + v, 0) / 14; else if (trs.length > 14) atr = ((atr as number) * 13 + tr) / 14;
    if (j + 1 < days.length && atr !== null) m.set(days[j + 1].d, atr);
  }
  return m;
}
export async function attachScale(bars: Bar[], days: number, tf: string) {
  const btc = (await loadBars("BTCUSDT", days, tf)).bars;
  const a = dailyAtr(bars), r = dailyAtr(btc);
  for (const b of bars) { const d = new Date(b.t).toISOString().slice(0, 10); const x = a.get(d), y = r.get(d); b.k = x && y ? x / y : undefined; }
}
function dedupe(b: Bar[], ms: number) {
  const m = new Map<number, Bar>();
  for (const x of b) if (x.t + ms <= Date.now()) m.set(x.t, x);
  return [...m.values()].sort((a, b) => a.t - b.t);
}

// ---------- simulation ----------
type Trade = { i: number; d: number; e: number; sl: number; tp: number; res: string; x: number; xp?: number };
class Tracker {
  inT = false; trades: Trade[] = []; nDay = 0; day = ""; d = 0; e = 0; sl = 0; tp = 0; eb = 0;
  constructor(public name: string, private P: Record<string, number>, private B: Bar[], private mad: (i: number) => any) {}
  exits(i: number) {
    const B = this.B;
    const dd = this.mad(i).date;
    if (dd !== this.day) { this.day = dd; this.nDay = 0; }
    if (this.inT && i > this.eb) {
      const hs = this.d === -1 ? B[i].h >= this.sl : B[i].l <= this.sl;
      const ht = !hs && (this.d === -1 ? B[i].l <= this.tp : B[i].h >= this.tp);
      if (hs || ht) this.close(i, hs ? "SL" : "TP");
    }
  }
  close(i: number, res: string, xp?: number) {
    this.trades.push({ i: this.eb, d: this.d, e: this.e, sl: this.sl, tp: this.tp, res, x: i, xp }); this.inT = false;
  }
  go(i: number, d: number, e: number, sl: number, tp: number, limit = true) {
    if (!d || this.inT || this.nDay >= this.P.maxDay || i < 30) return;
    this.inT = true; this.d = d; this.e = e; this.sl = sl; this.tp = tp; this.eb = i; this.nDay++;
    const B = this.B;
    if (limit && ((d === -1 && B[i].h >= sl) || (d === 1 && B[i].l <= sl))) this.close(i, "SL");
  }
}

export function simulate(B: Bar[], Pin: Record<string, number>, ext?: (i: number, d: number) => boolean) {
  const P = { ...DEFAULTS, ...Pin };
  const N = B.length;
  const barMs = N > 1 ? B[1].t - B[0].t : 300000;
  const madC = B.map((b) => parts(b.t, "Europe/Madrid"));
  const nyC = B.map((b) => parts(b.t, "America/New_York"));
  const mad = (i: number) => madC[i];
  const m7C = P.tzFix ? B.map((b) => parts(b.t, "Etc/GMT-2")) : madC;
  const E10: number[] = [], E50: number[] = [];
  for (let i = 0; i < N; i++) { E10.push(i ? E10[i - 1] + (B[i].c - E10[i - 1]) * 2 / 11 : B[i].c); E50.push(i ? E50[i - 1] + (B[i].c - E50[i - 1]) * 2 / 51 : B[i].c); }
  // Bibi V6 trend filter (Eze 7 oct 2026): SMC structure + session (London/NY open range) + EMA50/200 or RSI14 contrarian
  const E50b: number[] = [], E200: number[] = [], RSI: number[] = [];
  { let ag = 0, al = 0;
    for (let i = 0; i < N; i++) {
      E50b.push(i ? E50b[i - 1] + (B[i].c - E50b[i - 1]) * 2 / 51 : B[i].c); E200.push(i ? E200[i - 1] + (B[i].c - E200[i - 1]) * 2 / 201 : B[i].c);
      const ch = i ? B[i].c - B[i - 1].c : 0; const g = Math.max(ch, 0), lo = Math.max(-ch, 0);
      if (i <= 14) { ag += g / 14; al += lo / 14; } else { ag = (ag * 13 + g) / 14; al = (al * 13 + lo) / 14; }
      RSI.push(i < 14 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
    } }
  const smcV: number[] = new Array(N).fill(0), sesV: (number | null)[] = new Array(N).fill(null);
  { let lsh: number | null = null, lsl: number | null = null, v = 0;
    let lonHi = -Infinity, lonLo = Infinity, lonD: [number, number] | null = null, nyHi = -Infinity, nyLo = Infinity, nyD: [number, number] | null = null, nyOp = false, dPrev = "";
    let inLonP = false, inNyP = false;
    for (let i = 0; i < N; i++) {
      const b = B[i];
      if (i >= 10) { const c = i - 5; let okH = true, okL = true; for (let k = c - 5; k <= c + 5; k++) { if (k === c) continue; if (k < c ? !(B[c].h > B[k].h) : !(B[c].h >= B[k].h)) okH = false; if (k < c ? !(B[c].l < B[k].l) : !(B[c].l <= B[k].l)) okL = false; } if (okH) lsh = B[c].h; if (okL) lsl = B[c].l; }
      if (lsh !== null && b.c > lsh) v = 1; else if (lsl !== null && b.c < lsl) v = -1; smcV[i] = v;
      const md = madC[i].date; if (md !== dPrev) { dPrev = md; lonD = null; nyD = null; nyOp = false; }
      const lp = parts(b.t, "Europe/London"), np = parts(b.t, "America/New_York");
      const lm = lp.h * 60 + lp.m, nm = np.h * 60 + np.m;
      const inLon = lm >= 480 && lm < 510, inNy = nm >= 570 && nm < 600;
      if (inLon) { if (!inLonP) { lonHi = b.h; lonLo = b.l; } else { lonHi = Math.max(lonHi, b.h); lonLo = Math.min(lonLo, b.l); } } else if (inLonP) lonD = [lonHi, lonLo];
      if (inNy) { nyOp = true; if (!inNyP) { nyHi = b.h; nyLo = b.l; } else { nyHi = Math.max(nyHi, b.h); nyLo = Math.min(nyLo, b.l); } } else if (inNyP) nyD = [nyHi, nyLo];
      inLonP = inLon; inNyP = inNy;
      const sr = nyOp ? nyD : lonD; sesV[i] = sr ? (b.c > sr[0] ? 1 : b.c < sr[1] ? -1 : 0) : null;
    } }
  const trendOk = (i: number, d: number) => {
    const emaV = B[i].c > E50b[i] && E50b[i] > E200[i] ? 1 : B[i].c < E50b[i] && E50b[i] < E200[i] ? -1 : 0;
    const rsiV = RSI[i] >= 70 ? -1 : RSI[i] <= 30 ? 1 : 0;
    const sv = sesV[i];
    return (emaV * d === 1 || rsiV * d === 1) && smcV[i] * d === 1 && (sv === null || sv * d === 1);
  };
  // ATR (RMA 14)
  const ATR: (number | null)[] = new Array(N).fill(null);
  const tr = B.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c))));
  for (let i = 0; i < N; i++) {
    if (i === 13) ATR[i] = tr.slice(0, 14).reduce((a, x) => a + x, 0) / 14;
    else if (i > 13) ATR[i] = ((ATR[i - 1] as number) * 13 + tr[i]) / 14;
  }
  // VWAP anchored 00:00 UTC
  // Supertrend (TradingView: hl2, ATR RMA) + ADX(14,14) on 5m and on 1h (last closed hour, no lookahead)
  const stAdx = (H: { h: number; l: number; c: number }[]) => {
    const n = H.length, dir = new Array(n).fill(1), adx = new Array(n).fill(NaN);
    let atr = 0, up = 0, dn = 0, st = 0, sTR = 0, sP = 0, sM = 0, ax = 0;
    for (let i = 0; i < n; i++) {
      const b = H[i], pc = i ? H[i - 1].c : b.c, tr = i ? Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)) : b.h - b.l;
      atr = i < 14 ? (atr * i + tr) / (i + 1) : (atr * 13 + tr) / 14;
      const src = (b.h + b.l) / 2; let u = src - P.stFac * atr, d = src + P.stFac * atr;
      if (i) { u = pc > up ? Math.max(u, up) : u; d = pc < dn ? Math.min(d, dn) : d; }
      let dr: number; if (i === 0) dr = 1; else if (st === dn) dr = b.c > d ? -1 : 1; else dr = b.c < u ? 1 : -1;
      up = u; dn = d; st = dr === -1 ? u : d; dir[i] = dr;
      if (i) { const pm = b.h - H[i - 1].h, mm = H[i - 1].l - b.l; const p = pm > mm && pm > 0 ? pm : 0, m = mm > pm && mm > 0 ? mm : 0;
        sTR = i <= 14 ? sTR + tr : sTR - sTR / 14 + tr; sP = i <= 14 ? sP + p : sP - sP / 14 + p; sM = i <= 14 ? sM + m : sM - sM / 14 + m;
        if (i >= 14 && sTR > 0) { const dp = 100 * sP / sTR, dm = 100 * sM / sTR, dx = dp + dm > 0 ? 100 * Math.abs(dp - dm) / (dp + dm) : 0; ax = i < 28 ? (ax * (i - 14) + dx) / (i - 13) : (ax * 13 + dx) / 14; if (i >= 28) adx[i] = ax; } }
    }
    return { dir, adx };
  };
  const S5 = stAdx(B);
  const HB: { h: number; l: number; c: number; end: number }[] = []; const h1Idx: number[] = new Array(N).fill(-1);
  for (let i = 0; i < N; i++) { const hk = Math.floor(B[i].t / 3600000); const last = HB[HB.length - 1];
    if (!last || last.end !== hk) HB.push({ h: B[i].h, l: B[i].l, c: B[i].c, end: hk }); else { last.h = Math.max(last.h, B[i].h); last.l = Math.min(last.l, B[i].l); last.c = B[i].c; }
    const closedH = (B[i].t + barMs) % 3600000 === 0 ? HB.length - 1 : HB.length - 2; h1Idx[i] = closedH; }
  const S1 = stAdx(HB);
  // CAD++ modules: Heikin-Ashi trend (EMA 9), Zero-Lag MA (15), Multi-DSMA score, Bollinger 20/2, Structure Engine
  const emaArr = (x: number[], n: number) => { const o: number[] = []; const a = 2 / (n + 1); for (let i = 0; i < x.length; i++) o.push(i ? o[i - 1] + a * (x[i] - o[i - 1]) : x[i]); return o; };
  const closes = B.map((b) => b.c);
  const haO: number[] = [], haC: number[] = [];
  for (let i = 0; i < N; i++) { const c = (B[i].o + B[i].h + B[i].l + B[i].c) / 4; haC.push(c); haO.push(i ? (haO[i - 1] + haC[i - 1]) / 2 : (B[i].o + B[i].c) / 2); }
  const haEO = emaArr(haO, 9), haEC = emaArr(haC, 9);
  const zlE = emaArr(closes, 15), zlM = emaArr(closes.map((c, i) => c + (c - zlE[i])), 15);
  const dsScore: number[] = new Array(N).fill(0.5);
  if (P.dsF) {
    const per = Array.from({ length: 8 }, (_, k) => P.dsP + k * 40);
    const DS = per.map((p) => {
      const g = Math.sqrt(2), pi = Math.PI, sv = 2 * pi / p, a1 = Math.exp(-g * pi / (0.5 * p)), b1 = 2 * a1 * Math.cos(g * sv / (0.5 * p)), c2 = b1, c3 = -a1 * a1, c1 = 1 - c2 - c3;
      const out: number[] = []; let f1 = 0, f2 = 0, z1 = 0, e2: number | null = null, ds = 0; const ea = 2 / (p + 1);
      for (let i = 0; i < N; i++) { const z = i >= 2 ? B[i].c - B[i - 2].c : 0; const f = c1 * (z + z1) / 2 + c2 * f1 + c3 * f2; f2 = f1; f1 = f; z1 = z;
        e2 = e2 === null ? f * f : e2 + ea * (f * f - e2); const rms = Math.sqrt(e2); const sc = rms ? f / rms : 0; const al = Math.abs(sc) * 5 / p; ds = al * B[i].c + (1 - al) * ds; out.push(ds); }
      return out; });
    for (let i = 0; i < N; i++) { let sc = 0; for (let k = 0; k < 8; k++) if (DS[k][i] > DS[7][i]) sc += 1 / 7; dsScore[i] = sc; }
  }
  const bbM: number[] = [], bbS: number[] = [];
  for (let i = 0; i < N; i++) { const a = Math.max(0, i - 19); let sm = 0, sq = 0, n = 0; for (let k = a; k <= i; k++) { sm += B[k].c; sq += B[k].c * B[k].c; n++; } const m = sm / n; bbM.push(m); bbS.push(Math.sqrt(Math.max(0, sq / n - m * m))); }
  const seSig: number[] = new Array(N).fill(0);
  { let lastH = NaN, prevH = NaN, lastL = NaN, prevL = NaN, last = 0, at = 0; const pl = 4;
    for (let i = 0; i < N; i++) { const b = B[i], tr = i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l; at = i < 7 ? (at * i + tr) / (i + 1) : (at * 6 + tr) / 7;
      const c = i - pl; if (c - pl >= 0) { let isH = true, isL = true; for (let k = c - pl; k <= i; k++) { if (k === c) continue; if (B[k].h >= B[c].h) isH = false; if (B[k].l <= B[c].l) isL = false; } if (isH) { prevH = lastH; lastH = B[c].h; } if (isL) { prevL = lastL; lastL = B[c].l; } }
      const body = Math.abs(b.c - b.o), rg = b.h - b.l; const bull = b.c > b.o && body > rg * 0.5 && body > at, bear = b.c < b.o && body > rg * 0.5 && body > at;
      const hh = lastH > prevH, lh = lastH < prevH, ll = lastL < prevL, hl = lastL > prevL;
      if ((ll || hl) && bull && last !== 1) last = 1; else if ((hh || lh) && bear && last !== -1) last = -1;
      seSig[i] = last; } }
  const E200c: number[] = []; for (let i = 0; i < N; i++) E200c.push(i ? E200c[i - 1] + (B[i].c - E200c[i - 1]) * 2 / 201 : B[i].c);
  const VS: number[] = []; { let sv = 0; for (let i = 0; i < N; i++) { sv += B[i].v; if (i >= P.volLen) sv -= B[i - P.volLen].v; VS.push(i >= P.volLen - 1 ? sv / P.volLen : NaN); } }
  const VW: number[] = [], VSD: number[] = []; let pv = 0, vv = 0, pv2 = 0, day = "";
  for (let i = 0; i < N; i++) {
    const d = new Date(B[i].t).toISOString().slice(0, 10);
    if (d !== day) { pv = 0; vv = 0; pv2 = 0; day = d; }
    const hlc = (B[i].h + B[i].l + B[i].c) / 3;
    pv += hlc * B[i].v; pv2 += hlc * hlc * B[i].v; vv += B[i].v; const vw = vv > 0 ? pv / vv : B[i].c; VW.push(vw);
    VSD.push(vv > 0 ? Math.sqrt(Math.max(0, pv2 / vv - vw * vw)) : 0);
  }
  // Trend filter: last completed 1h close vs EMA(trendLen) of 1h closes (no lookahead)
  const TD: number[] = new Array(N).fill(0);
  { let ema: number | null = null, lastC: number | null = null, n = 0, sum = 0; const a = 2 / (P.trendLen + 1);
    for (let i = 0; i < N; i++) {
      TD[i] = ema !== null && lastC !== null ? (lastC > ema ? 1 : lastC < ema ? -1 : 0) : 0;
      if ((B[i].t + barMs) % 3600000 === 0) {
        lastC = B[i].c; n++;
        if (n < P.trendLen) sum += B[i].c; else if (n === P.trendLen) { sum += B[i].c; ema = sum / P.trendLen; } else ema = a * B[i].c + (1 - a) * (ema as number);
      }
    } }
  const okT = (i: number, d: number) => !P.trend || d === TD[i];
  const pn = P.piv;
  const pivh = (i: number) => {
    const c = i - pn; if (c - pn < 0) return null;
    for (let k = c - pn; k < c; k++) if (!(B[c].h > B[k].h)) return null;
    for (let k = c + 1; k <= c + pn; k++) if (!(B[c].h >= B[k].h)) return null;
    return B[c].h;
  };
  const pivl = (i: number) => {
    const c = i - pn; if (c - pn < 0) return null;
    for (let k = c - pn; k < c; k++) if (!(B[c].l < B[k].l)) return null;
    for (let k = c + 1; k <= c + pn; k++) if (!(B[c].l <= B[k].l)) return null;
    return B[c].l;
  };
  const stop = (e: number, d: number, swing: number, atr: number) =>
    d === -1 ? Math.max(swing + atr * P.slBuf, e * (1 + P.minSL / 100)) : Math.min(swing - atr * P.slBuf, e * (1 - P.minSL / 100));
  const hm = (p: { h: number; m: number }) => p.h * 60 + p.m;

  const TR = ["M1 ICT barrido+FVG", "M2 Silver Bullet", "M3 OTE Fibonacci", "M4 Rango9h contraria", "M5 Rango9h vela10", "M6 EQH/EQL barrido", "M7 Rango 09-10 ruptura"].map(
    (n) => new Tracker(n, P, B, mad));
  let lastPH: number | null = null, lastPL: number | null = null;
  const used: Record<string, boolean> = { "1S": false, "1L": false, "3S": false, "3L": false };
  let upHi: number | null = null, upLo: number | null = null, dnHi: number | null = null, dnLo: number | null = null;
  const m1: Record<number, any> = { [-1]: { st: 0 }, [1]: { st: 0 } };
  const m3: Record<number, any> = { [-1]: { st: 0 }, [1]: { st: 0 } };
  const sb: any = { st: 0 };
  let asiaOpen: number | null = null;
  const phList: { v: number; bar: number }[] = [], plList: { v: number; bar: number }[] = [];
  let eqH: number | null = null, eqL: number | null = null;
  const m6: Record<number, any> = { [-1]: { st: 0 }, [1]: { st: 0 } };
  let r7Day = "", r7Hi = -Infinity, r7Lo = Infinity, r7Done = true, r7Side = 0, r7Cnt = 0, r7Rev = false;
  const prevR: { hi: number; lo: number }[] = [];
  // dia anterior (maximo/minimo del dia completo) y swings para el TP "al siguiente nivel"
  let dDay = "", dHi = -Infinity, dLo = Infinity; const prevD: { hi: number; lo: number }[] = [];
  const swH: { v: number; bar: number }[] = [], swL: { v: number; bar: number }[] = [];
  const barMin = barMs / 60000;

  for (let i = 0; i < N; i++) {
    const b = B[i];
    for (const t of TR) t.exits(i);
    if (P.tEx && TR[6].inT && i > TR[6].eb) { const tt = m7C[i]; if (tt.date !== m7C[TR[6].eb].date || tt.h * 60 + tt.m + barMin >= 22 * 60 + 50) TR[6].close(i, "RE", b.c); }
    { const tt = m7C[i]; if (tt.date !== dDay) { if (dDay && isFinite(dHi)) { prevD.unshift({ hi: dHi, lo: dLo }); if (prevD.length > 30) prevD.pop(); } dDay = tt.date; dHi = -Infinity; dLo = Infinity; }
      dHi = Math.max(dHi, b.h); dLo = Math.min(dLo, b.l);
      const j = i - P.swP; if (j >= P.swP) { let isH = true, isL = true; for (let k = j - P.swP; k <= i; k++) { if (k === j) continue; if (B[k].h >= B[j].h) isH = false; if (B[k].l <= B[j].l) isL = false; }
        if (isH) { swH.unshift({ v: B[j].h, bar: j }); if (swH.length > 60) swH.pop(); } if (isL) { swL.unshift({ v: B[j].l, bar: j }); if (swL.length > 60) swL.pop(); } } }
    const atr = ATR[i] ?? b.h - b.l;
    const ph = pivh(i), pl = pivl(i);
    if (ph !== null) { lastPH = ph; used["1S"] = used["3S"] = false; }
    if (pl !== null) { lastPL = pl; used["1L"] = used["3L"] = false; }
    const body = Math.abs(b.c - b.o);
    const big: Record<number, boolean> = { [-1]: b.c < b.o && body >= P.disp * atr, [1]: b.c > b.o && body >= P.disp * atr };
    const fvg: Record<number, boolean> = { [-1]: i >= 2 && b.h < B[i - 2].l, [1]: i >= 2 && b.l > B[i - 2].h };
    const tM = mad(i);
    const inKZ = (hm(tM) >= 9 * 60 && hm(tM) < 12 * 60) || (hm(tM) >= 15 * 60 + 30 && hm(tM) < 18 * 60);
    const kzOk = !P.kz || inKZ;
    const sig: Record<number, [number, number, number, number]> = { 1: [0, 0, 0, 0], 2: [0, 0, 0, 0], 3: [0, 0, 0, 0] };

    for (const [model, key] of [[m1, "1"], [m3, "3"]] as [Record<number, any>, string][]) {
      for (const d of [-1, 1]) {
        const s = model[d]; const uk = key + (d === -1 ? "S" : "L");
        const lvl = d === -1 ? lastPH : lastPL, opp = d === -1 ? lastPL : lastPH;
        const swept = lvl !== null && opp !== null && (d === -1 ? b.h > lvl && b.c < lvl : b.l < lvl && b.c > lvl);
        if (s.st === 0 && !used[uk] && swept) {
          used[uk] = true;
          Object.assign(s, { st: 1, sw: d === -1 ? b.h : b.l, swBar: i, lvl, mss: opp, disp: false, fvg: false, obT: null, obB: null, leg: d === -1 ? b.l : b.h });
        } else {
          if (s.st === 1) s.sw = d === -1 ? Math.max(s.sw, b.h) : Math.min(s.sw, b.l);
          if (s.st >= 1) s.leg = d === -1 ? Math.min(s.leg, b.l) : Math.max(s.leg, b.h);
        }
        if (s.st === 1) {
          if (big[d] && !s.disp) { if (d === -1) { s.obT = upHi; s.obB = upLo; } else { s.obT = dnHi; s.obB = dnLo; } }
          if (big[d]) s.disp = true;
          if (fvg[d] && i - 2 >= s.swBar) Object.assign(s, { fT: d === -1 ? B[i - 2].l : b.l, fB: d === -1 ? b.h : B[i - 2].h, fvg: true });
          const kill1 = (d === -1 ? b.c > s.lvl : b.c < s.lvl) || i - s.swBar > P.mssBars;
          const mss = !kill1 && (d === -1 ? b.c < s.mss : b.c > s.mss) && s.disp && (s.fvg || key !== "1");
          if (kill1) s.st = 0; else if (mss) { s.st = 2; s.mBar = i; }
        }
        if (s.st === 2 && i > s.mBar) {
          let epx: number, kill2: boolean;
          if (key === "1") {
            epx = (s.fT + s.fB) / 2;
            kill2 = d === -1 ? b.c > s.fT || b.h > s.sw : b.c < s.fB || b.l < s.sw;
          } else {
            epx = s.leg + (s.sw - s.leg) * P.ote;
            kill2 = d === -1 ? b.h > s.sw : b.l < s.sw;
          }
          kill2 = kill2 || i - s.mBar > P.retBars;
          const touch = d === -1 ? b.h >= epx : b.l <= epx;
          if (touch) {
            const e = d === -1 ? Math.max(b.o, epx) : Math.min(b.o, epx);
            const slv = stop(e, d, s.sw, atr); const risk = Math.abs(e - slv); const tpv = e + d * risk * P.rr;
            let ok = risk > 0 && kzOk;
            if (key === "1") {
              const obOK = s.obT !== null && s.fT >= s.obB && s.fB <= s.obT;
              const pdOK = d === -1 ? epx > (s.sw + s.leg) / 2 : epx < (s.sw + s.leg) / 2;
              const vwOK = d === -1 ? epx < VW[i] : epx > VW[i];
              ok = ok && +obOK + +pdOK + +vwOK >= P.minScore;
            }
            const k = +key;
            if (ok && sig[k][0] === 0) sig[k] = [d, e, slv, tpv];
          }
          if (touch || kill2) s.st = 0;
        }
      }
    }
    // M2 Silver Bullet: NY 03-04 and 10-11
    const tN = nyC[i];
    const inSB = (hm(tN) >= 180 && hm(tN) < 240) || (hm(tN) >= 600 && hm(tN) < 660);
    if (sb.st === 0 && inSB && i >= 2) {
      const pa = ATR[i - 1] ?? atr;
      const bigPrev = Math.abs(B[i - 1].c - B[i - 1].o) >= P.disp * pa;
      if (fvg[-1] && B[i - 1].c < B[i - 1].o && bigPrev) Object.assign(sb, { st: -1, top: B[i - 2].l, bot: b.h, sw: Math.max(B[i - 2].h, B[i - 1].h), bar: i });
      else if (fvg[1] && B[i - 1].c > B[i - 1].o && bigPrev) Object.assign(sb, { st: 1, top: b.l, bot: B[i - 2].h, sw: Math.min(B[i - 2].l, B[i - 1].l), bar: i });
    }
    if (sb.st !== 0 && i > sb.bar) {
      const d = sb.st; const ce = (sb.top + sb.bot) / 2;
      const touch = d === -1 ? b.h >= ce : b.l <= ce;
      const kill = i - sb.bar > P.retBars || (d === -1 ? b.c > sb.top : b.c < sb.bot);
      if (touch) {
        const e = d === -1 ? Math.max(b.o, ce) : Math.min(b.o, ce);
        const slv = stop(e, d, sb.sw, atr); const risk = Math.abs(e - slv);
        sig[2] = [d, e, slv, e + d * risk * P.rr];
      }
      if (touch || kill) sb.st = 0;
    }
    if (b.c > b.o) { upHi = b.h; upLo = b.l; }
    if (b.c < b.o) { dnHi = b.h; dnLo = b.l; }
    // M4 / M5
    if (tM.h === P.rgStartH && tM.m === 0) asiaOpen = b.o;
    const is10 = tM.h === P.rgEntryH && tM.m === 0;
    const d4 = is10 && asiaOpen !== null ? (b.c > asiaOpen ? -1 : b.c < asiaOpen ? 1 : 0) : 0;
    const d5 = is10 ? (b.c < b.o ? -1 : b.c > b.o ? 1 : 0) : 0;
    if (d4 && okT(i, d4)) TR[3].go(i, d4, b.c, b.c * (1 - d4 * P.rgSL / 100), b.c * (1 + d4 * P.rgTP / 100), false);
    if (d5 && okT(i, d5)) TR[4].go(i, d5, b.c, b.c * (1 - d5 * P.rgSL / 100), b.c * (1 + d5 * P.rgTP / 100), false);
    // M6 EQH/EQL: equal highs/lows (two pivots within eqTol*ATR) swept and rejected; optional MSS confirmation
    if (ph !== null) {
      for (const q of phList) if (i - pn - q.bar <= P.eqLook && Math.abs(ph - q.v) <= P.eqTol * atr) { eqH = Math.max(ph, q.v); break; }
      phList.unshift({ v: ph, bar: i - pn }); if (phList.length > 20) phList.pop();
    }
    if (pl !== null) {
      for (const q of plList) if (i - pn - q.bar <= P.eqLook && Math.abs(pl - q.v) <= P.eqTol * atr) { eqL = Math.min(pl, q.v); break; }
      plList.unshift({ v: pl, bar: i - pn }); if (plList.length > 20) plList.pop();
    }
    let s6: [number, number, number, number] = [0, 0, 0, 0];
    for (const d of [-1, 1]) {
      const s = m6[d]; const lvl = d === -1 ? eqH : eqL;
      if (lvl !== null && s.st === 0) {
        const swept = d === -1 ? b.h > lvl && b.c < lvl : b.l < lvl && b.c > lvl;
        const broke = d === -1 ? b.c > lvl : b.c < lvl;
        if (swept || broke) { if (d === -1) eqH = null; else eqL = null; }
        if (swept) {
          if (!P.m6mss) {
            const slv = stop(b.c, d, d === -1 ? b.h : b.l, atr);
            if (kzOk && s6[0] === 0) s6 = [d, b.c, slv, b.c + d * Math.abs(b.c - slv) * P.rr];
          } else Object.assign(s, { st: 1, sw: d === -1 ? b.h : b.l, swBar: i, mss: d === -1 ? lastPL : lastPH });
          continue;
        }
      }
      if (s.st === 1 && i > s.swBar) {
        s.sw = d === -1 ? Math.max(s.sw, b.h) : Math.min(s.sw, b.l);
        const kill = (d === -1 ? b.c > s.sw : b.c < s.sw) || i - s.swBar > P.mssBars || s.mss === null;
        const mss = !kill && (d === -1 ? b.c < s.mss : b.c > s.mss);
        if (mss) {
          const slv = stop(b.c, d, s.sw, atr);
          if (kzOk && s6[0] === 0) s6 = [d, b.c, slv, b.c + d * Math.abs(b.c - slv) * P.rr];
        }
        if (kill || mss) s.st = 0;
      }
    }
    if (s6[0] && okT(i, s6[0])) TR[5].go(i, s6[0], s6[1], s6[2], s6[3], false);
    // M7 Rango 09:00-10:00 (Madrid): first close outside the 9-10 range after 10:00 -> trade the breakout
    if (P.m7reIn && !r7Rev && TR[6].inT && i > TR[6].eb && (!P.reInN || i - TR[6].eb <= P.reInN) && (TR[6].d === 1 ? b.c < r7Hi : b.c > r7Lo)) {
      const od = TR[6].d, oe = TR[6].e; TR[6].close(i, "RE", b.c);
      if (P.rev && !r7Rev && m7C[i].h < P.m7endH) {   // falsa ruptura: gira al lado contrario con la misma distancia de SL/TP
        r7Rev = true; const nd = -od; const kk2 = P.auto ? b.k : 1;
        const slD = P.m7slP > 0 ? P.m7slP * (kk2 as number) : b.c * P.rgSL / 100, tpD = P.m7slP > 0 ? P.m7tpP * (kk2 as number) : b.c * P.rgTP / 100;
        TR[6].nDay = 0; TR[6].go(i, nd, b.c, b.c - nd * slD, b.c + nd * tpD, false);
      }
    }
    const t7 = m7C[i];
    if (t7.h === P.rgH) {
      if (r7Day !== t7.date) { if (r7Day && isFinite(r7Hi)) { prevR.unshift({ hi: r7Hi, lo: r7Lo }); if (prevR.length > 30) prevR.pop(); } r7Day = t7.date; r7Hi = -Infinity; r7Lo = Infinity; r7Done = false; r7Side = 0; r7Cnt = 0; r7Rev = false; }
      r7Hi = Math.max(r7Hi, b.h); r7Lo = Math.min(r7Lo, b.l);
    } else if (!r7Done && r7Day === t7.date && t7.h > P.rgH && t7.h < P.m7endH) {
      const side7 = b.c > r7Hi ? 1 : b.c < r7Lo ? -1 : 0;
      if (side7 && side7 === r7Side) r7Cnt++; else { r7Side = side7; r7Cnt = side7 ? 1 : 0; }
      const d7 = r7Cnt >= P.m7conf ? r7Side : 0;
      if (d7) {
        r7Done = true;
        const bodyOk = !P.m7body || (d7 === -1 ? big[-1] : big[1]);
        const kk = P.auto ? b.k : 1;
        const amp = r7Hi - r7Lo; const ampOk = kk !== undefined && (!P.ampMin || amp >= P.ampMin * kk) && (!P.ampMax || amp <= P.ampMax * kk);
        const lvl7 = d7 === 1 ? r7Hi : r7Lo, hl7 = b.h - b.l || 1e-12;
        const volOk = !P.volK || (isFinite(VS[i - 1]) && b.v >= P.volK * VS[i - 1]);
        const brkOk = !P.brkAtr || d7 * (b.c - lvl7) >= P.brkAtr * atr;
        const cpOk = !P.clsPos || (d7 === 1 ? (b.c - b.l) / hl7 : (b.h - b.c) / hl7) >= P.clsPos;
        const wkOk = !P.wickMax || (d7 === 1 ? b.h - b.c : b.c - b.l) <= P.wickMax * Math.abs(b.c - b.o);
        const hI = h1Idx[i];
        const stOk = (!P.stF || S5.dir[i] === -d7) && (!P.st1h || (hI >= 0 && S1.dir[hI] === -d7));
        const adxV = P.adxH ? (hI >= 0 ? S1.adx[hI] : NaN) : S5.adx[i];
        const adxOk = !P.adxMin || (isFinite(adxV) && adxV >= P.adxMin);
        const vwD = VSD[i] > 0 ? d7 * (b.c - VW[i]) / VSD[i] : 0;
        const vwOk = (!P.vwF || d7 * (b.c - VW[i]) > 0) && (!P.vwMax || vwD <= P.vwMax) && (!P.vwMin || vwD >= P.vwMin);
        const cadOk = (!P.haF || d7 * (haEC[i] - haEO[i]) > 0) && (!P.zlF || d7 * (zlM[i] - zlE[i]) > 0) && (!P.dsF || (d7 === 1 ? dsScore[i] > 0.5 : dsScore[i] < 0.5))
          && (!P.bbF || (P.bbF === 1 ? d7 * (b.c - (bbM[i] + d7 * 2 * bbS[i])) > 0 : d7 * (b.c - (bbM[i] + d7 * 2 * bbS[i])) <= 0)) && (!P.seF || seSig[i] === d7);
        const e2Ok = cadOk && vwOk && (!P.e200 || (d7 === 1 ? b.c > E200c[i] : b.c < E200c[i]));
        const emaOk = stOk && adxOk && e2Ok && volOk && brkOk && cpOk && wkOk && (!P.emaF || (d7 === 1 ? E10[i] > E50[i] : E10[i] < E50[i])) && (!P.trendF || trendOk(i, d7)) && (!P.wkd || (new Date(b.t).getUTCDay() % 6 !== 0)) && (!ext || ext(i, d7));
        if (bodyOk && ampOk && emaOk && okT(i, d7)) {
          if (P.m7slP > 0 || !P.m7mode) {
            const slDist = P.m7slP > 0 ? P.m7slP * (kk as number) : b.c * P.rgSL / 100;
            let tpv: number | null = b.c + d7 * (P.m7slP > 0 ? P.m7tpP * (kk as number) : b.c * P.rgTP / 100);
            if (P.tpMode) {
              const lv = P.tpMode === 1 ? prevD.slice(0, P.prevN).flatMap((q) => [q.hi, q.lo]) : (d7 === 1 ? swH : swL).filter((q) => i - q.bar <= P.swLook).map((q) => q.v);
              let best: number | null = null; for (const v of lv) { const dist = d7 * (v - b.c); if (dist >= slDist * P.minRR && (best === null || dist < d7 * (best - b.c))) best = v; }
              tpv = best !== null ? best : P.tpFb ? tpv : null;
            }
            if (P.tpPrev) { tpv = null; for (const q of prevR.slice(0, P.prevN)) for (const lv of [q.hi, q.lo]) { const dist = d7 * (lv - b.c); if (dist >= slDist * P.minRR && (tpv === null || dist < d7 * (tpv - b.c))) tpv = lv; } }
            if (tpv !== null) TR[6].go(i, d7, b.c, b.c - d7 * slDist, tpv, false);
          }
          else { const slv = stop(b.c, d7, d7 === 1 ? r7Lo : r7Hi, atr); TR[6].go(i, d7, b.c, slv, b.c + d7 * Math.abs(b.c - slv) * P.rr, false); }
        }
      }
    }
    for (const k of [1, 2, 3]) { const [d, e, slv, tpv] = sig[k]; if (d && okT(i, d)) TR[k - 1].go(i, d, e, slv, tpv); }
  }

  const feeR = (t: Trade) => P.fee / ((Math.abs(t.e - t.sl) / t.e) * 100);
  const rOf = (t: Trade) => (t.res === "TP" ? Math.abs(t.tp - t.e) / Math.abs(t.sl - t.e) : t.res === "RE" ? t.d * ((t.xp as number) - t.e) / Math.abs(t.sl - t.e) : -1) - feeR(t);
  const half = B.length ? B[Math.floor(N / 2)].t : 0;
  return TR.map((t) => {
    const R = t.trades.reduce((a, x) => a + rOf(x), 0);
    const w = t.trades.filter((x) => x.res === "TP").length;
    const h1 = t.trades.filter((x) => B[x.i].t < half), h2 = t.trades.filter((x) => B[x.i].t >= half);
    let peak = 0, cum = 0, dd = 0;
    for (const x of t.trades) { cum += rOf(x); peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    return {
      modelo: t.name, ops: t.trades.length, tp: w, sl: t.trades.length - w,
      wr: t.trades.length ? +(100 * w / t.trades.length).toFixed(1) : 0,
      Rneto: +R.toFixed(2), Rmitad1: +h1.reduce((a, x) => a + rOf(x), 0).toFixed(2), Rmitad2: +h2.reduce((a, x) => a + rOf(x), 0).toFixed(2),
      maxDD_R: +dd.toFixed(2),
      ult25: (() => { const l = t.trades.slice(-25); const w2 = l.filter((x) => x.res === "TP").length; return `${w2}TP/${l.length - w2}SL R${l.reduce((a, x) => a + rOf(x), 0).toFixed(1)}`; })(),
      meses: (() => { const m: Record<string, number> = {}; for (const x of t.trades) { const k = madC[x.i].date.slice(0, 7); m[k] = +((m[k] ?? 0) + rOf(x)).toFixed(1); } return m; })(),
      trades: t.trades.map((x) => ({ fecha: `${madC[x.i].date} ${String(madC[x.i].h).padStart(2, "0")}:${String(madC[x.i].m).padStart(2, "0")}`, dir: x.d === -1 ? "S" : "L", e: x.e, sl: +x.sl.toPrecision(6), tp: +x.tp.toPrecision(6), res: x.res })),
    };
  });
}

// ---------- parameter sweep with in-sample / out-of-sample split ----------
// /sweep?symbols=A,B&days=180&split=0.67&grid=rr:1,1.5,2;kz:0,1&top=5
// Every combo is optimised on the first `split` of the period (IS) and reported on the rest (OOS).
const jobs = new Map<string, any>();
async function sweep(u: URL) {
  const symbols = (u.searchParams.get("symbols") || "BTCUSDT").toUpperCase().split(",").filter(Boolean).slice(0, 15);
  const tf = TF_MS[u.searchParams.get("tf") || "5m"] ? (u.searchParams.get("tf") || "5m") : "5m";
  const days = Math.min(tf === "5m" ? 365 : 1100, Math.max(10, +(u.searchParams.get("days") || 180)));
  const split = Math.min(0.9, Math.max(0.3, +(u.searchParams.get("split") || 0.67)));
  const top = Math.min(20, +(u.searchParams.get("top") || 5));
  const grid: [string, number[]][] = (u.searchParams.get("grid") || "rr:1,1.5,2,3")
    .split(/[;_|]/).filter(Boolean).map((g) => { const [k, v] = g.split(":"); return [k, v.split(",").map(Number)] as [string, number[]]; })
    .filter(([k]) => k in DEFAULTS);
  const base: Record<string, number> = {};
  for (const k of Object.keys(DEFAULTS)) { const v = u.searchParams.get(k); if (v !== null && v !== "" && !isNaN(+v)) base[k] = +v; }
  let combos: Record<string, number>[] = [{}];
  for (const [k, vals] of grid) combos = combos.flatMap((c) => vals.map((v) => ({ ...c, [k]: v })));
  combos = combos.slice(0, 200);
  const data: { s: string; is: Bar[]; oos: Bar[] }[] = [];
  const errors: Record<string, string> = {};
  for (const s of symbols) {
    try {
      const { bars } = await loadBars(s, days, tf);
      if (base.auto) await attachScale(bars, days, tf);
      const cut = Math.floor(bars.length * split);
      data.push({ s, is: bars.slice(0, cut), oos: bars.slice(cut) });
    } catch (e: any) { errors[s] = String(e.message || e); }
  }
  const agg: Record<string, any[]> = {};
  for (const c of combos) {
    const P = { ...base, ...c };
    const acc: Record<string, any> = {};
    for (const d of data) {
      const ri = simulate(d.is, P), ro = simulate(d.oos, P);
      ri.forEach((r, k) => {
        const a = (acc[r.modelo] ??= { combo: c, opsIS: 0, R_IS: 0, opsOOS: 0, tpOOS: 0, R_OOS: 0, posIS: 0, posOOS: 0 });
        a.opsIS += r.ops; a.R_IS += r.Rneto; if (r.Rneto > 0) a.posIS++;
        a.opsOOS += ro[k].ops; a.tpOOS += ro[k].tp; a.R_OOS += ro[k].Rneto; if (ro[k].Rneto > 0) a.posOOS++;
      });
    }
    for (const [m, a] of Object.entries(acc)) (agg[m] ??= []).push(a);
  }
  const out: any = { tf, days, split, symbols: data.map((d) => d.s), errors, combos: combos.length, mejores_por_modelo: {} };
  for (const [m, arr] of Object.entries(agg)) {
    arr.sort((a, b) => b.R_IS - a.R_IS);
    out.mejores_por_modelo[m] = arr.slice(0, top).map((a) => ({
      ...a, R_IS: +a.R_IS.toFixed(2), R_OOS: +a.R_OOS.toFixed(2), wrOOS: a.opsOOS ? +(100 * a.tpOOS / a.opsOOS).toFixed(1) : 0,
    }));
  }
  return out;
}


// ---------- variants: one data load, several named param sets ----------
// /variants?symbols=A,B&days=365&<base params>&v=base:|conf2:m7conf=2|vol:volK=1.5
async function variants(u: URL) {
  await new Promise((r) => setTimeout(r, 50));
  const symbols = (u.searchParams.get("symbols") || "BTCUSDT").toUpperCase().split(",").filter(Boolean).slice(0, 15);
  const days = Math.min(365, Math.max(10, +(u.searchParams.get("days") || 365)));
  const base: Record<string, number> = {};
  for (const k of Object.keys(DEFAULTS)) { const v = u.searchParams.get(k); if (v !== null && v !== "" && !isNaN(+v)) base[k] = +v; }
  const V = (u.searchParams.get("v") || "base:").split("|").filter(Boolean).map((x) => { const [n, kv = ""] = x.split(":"); const o: Record<string, number> = {};
    for (const p of kv.split(",").filter(Boolean)) { const [k, v] = p.split("="); if (k in DEFAULTS) o[k] = +v; } return { n, o }; });
  const data: { s: string; bars: Bar[] }[] = []; const errors: Record<string, string> = {};
  for (const s of symbols) { try { const { bars } = await loadBars(s, days, "5m"); if (base.auto) await attachScale(bars, days, "5m"); data.push({ s, bars }); } catch (e: any) { errors[s] = String(e.message || e); } }
  const out: any = { days, symbols: data.map((d) => d.s), errors, base, res: {} };
  for (const { n, o } of V) {
    const t = { ops: 0, tp: 0, re: 0, R: 0, R1: 0, R2: 0, maxDD: 0, pos: 0, porActivo: {} as Record<string, number> };
    for (const d of data) { const r = simulate(d.bars, { ...base, ...o })[6]; t.ops += r.ops; t.tp += r.tp; t.R += r.Rneto; t.R1 += r.Rmitad1; t.R2 += r.Rmitad2; t.maxDD = Math.max(t.maxDD, r.maxDD_R); if (r.Rneto > 0) t.pos++; t.porActivo[d.s] = r.Rneto; }
    out.res[n] = { params: o, ops: t.ops, tpPct: t.ops ? +(100 * t.tp / t.ops).toFixed(1) : 0, R: +t.R.toFixed(1), mitad1: +t.R1.toFixed(1), mitad2: +t.R2.toFixed(1), peorDD: +t.maxDD.toFixed(1), activosPositivos: t.pos, porActivo: t.porActivo };
  }
  return out;
}

// ---------- hour-of-day bias, walk-forward ----------
// /hours?symbols=A,B&tf=1h&days=1100&tz=Etc/GMT-2&minN=20&thr=0.6&fee=0.02
export function hourStats(B: Bar[], tz: string, minN: number, thr: number, fee: number) {
  const n = new Array(24).fill(0), up = new Array(24).fill(0), sumR = new Array(24).fill(0);
  const W = new Array(24).fill(0), L = new Array(24).fill(0), PR = new Array(24).fill(0);
  let w = 0, l = 0, pr = 0, half = B[Math.floor(B.length / 2)]?.t ?? 0, pr1 = 0, pr2 = 0;
  for (const b of B) {
    const h = parts(b.t, tz).h; const ret = (b.c - b.o) / b.o * 100; const dir = ret > 0 ? 1 : ret < 0 ? -1 : 0;
    if (n[h] >= minN) {
      const p = up[h] / n[h]; const pd = p >= thr ? 1 : p <= 1 - thr ? -1 : 0;
      if (pd && dir) { const r = pd * ret - fee; if (pd === dir) { W[h]++; w++; } else { L[h]++; l++; } PR[h] += r; pr += r; if (b.t < half) pr1 += r; else pr2 += r; }
    }
    n[h]++; if (dir > 0) up[h]++; sumR[h] += ret;
  }
  const horas = n.map((_, h) => ({ h, n: n[h], verdes: +(100 * up[h] / Math.max(1, n[h])).toFixed(1), medio: +(sumR[h] / Math.max(1, n[h])).toFixed(3), wf: `${W[h]}W/${L[h]}L`, wfRetPct: +PR[h].toFixed(2) })).filter((x) => W[x.h] + L[x.h] > 0);
  return { senales: w + l, acierto: +(100 * w / Math.max(1, w + l)).toFixed(1), retNetoPct: +pr.toFixed(2), mitad1: +pr1.toFixed(2), mitad2: +pr2.toFixed(2), horas };
}
async function hours(u: URL) {
  const symbols = (u.searchParams.get("symbols") || "BTCUSDT").toUpperCase().split(",").filter(Boolean).slice(0, 15);
  const tf = "1h"; const days = Math.min(1100, +(u.searchParams.get("days") || 1100));
  const tz = u.searchParams.get("tz") || "Etc/GMT-2"; const minN = +(u.searchParams.get("minN") || 20);
  const thr = +(u.searchParams.get("thr") || 0.6); const fee = +(u.searchParams.get("fee") || 0.02);
  const out: any = { tf, days, tz, minN, thr, fee, res: {} };
  for (const s of symbols) { try { const { bars } = await loadBars(s, days, tf); out.res[s] = { desde: new Date(bars[0].t).toISOString().slice(0, 10), ...hourStats(bars, tz, minN, thr, fee) }; } catch (e: any) { out.res[s] = { error: String(e.message || e) }; } }
  return out;
}


// ---------- previous-day 09-10 range: touch stats + "go to nearest level" trade ----------
// /prevday?symbols=A,B&days=365&tz=Etc/GMT-2&fee=0.02&slMult=1&endH=24
export function prevDay(B: Bar[], tz: string, fee: number, slMult: number, endH: number, lag = 1) {
  type D = { date: string; rH: number; rL: number; open10: number | null; bars: Bar[] };
  const days: D[] = []; let cur: D | null = null;
  for (const b of B) { const p = parts(b.t, tz); if (!cur || cur.date !== p.date) { cur = { date: p.date, rH: -Infinity, rL: Infinity, open10: null, bars: [] }; days.push(cur); }
    if (p.h === 9) { cur.rH = Math.max(cur.rH, b.h); cur.rL = Math.min(cur.rL, b.l); } else if (p.h >= 10 && p.h < endH) cur.bars.push(b); }
  let n = 0, tH = 0, tL = 0, tAny = 0, tBoth = 0, inside = 0, insideAny = 0;
  let trades = 0, wins = 0, timeEx = 0, R = 0, R1 = 0, R2 = 0; const half = Math.floor(days.length / 2);
  let nearHit = 0, nearN = 0;
  for (let j = lag; j < days.length; j++) {
    const y = days[j - lag], d = days[j]; if (!isFinite(y.rH) || !isFinite(d.rH) || !d.bars.length) continue;
    n++;
    // from 09:00 (include today's range) to endH
    const hi = Math.max(d.rH, ...d.bars.map((b) => b.h)), lo = Math.min(d.rL, ...d.bars.map((b) => b.l));
    const h1 = hi >= y.rH, l1 = lo <= y.rL; if (h1) tH++; if (l1) tL++; if (h1 || l1) tAny++; if (h1 && l1) tBoth++;
    const c = d.bars[0].o; // price at 10:00
    const isIn = c < y.rH && c > y.rL; if (isIn) { inside++; if (h1 || l1) insideAny++; }
    // trade: at 10:00 go toward the nearer level NOT already touched during 09-10 today
    const cand: { lv: number; dir: number }[] = [];
    if (d.rH < y.rH && y.rH > c) cand.push({ lv: y.rH, dir: 1 });
    if (d.rL > y.rL && y.rL < c) cand.push({ lv: y.rL, dir: -1 });
    if (!cand.length) continue;
    cand.sort((a, b) => Math.abs(a.lv - c) - Math.abs(b.lv - c)); const t = cand[0];
    const dist = Math.abs(t.lv - c); const sl = c - t.dir * dist * slMult; nearN++;
    let res = 0, hit = false;
    for (const b of d.bars) { const hs = t.dir === 1 ? b.l <= sl : b.h >= sl; const ht = t.dir === 1 ? b.h >= t.lv : b.l <= t.lv;
      if (hs) { res = -1; break; } if (ht) { res = 1 / slMult; hit = true; break; } }
    if (hit) nearHit++;
    if (res === 0) { const cl = d.bars[d.bars.length - 1].c; res = t.dir * (cl - c) / (dist * slMult); timeEx++; }
    const r = res - fee / (dist * slMult / c * 100); trades++; if (res > 0) wins++; R += r; if (j < half) R1 += r; else R2 += r;
  }
  const pc = (x: number, m: number) => +(100 * x / Math.max(1, m)).toFixed(1);
  return { dias: n, tocaMaxAyer: pc(tH, n), tocaMinAyer: pc(tL, n), tocaAlguno: pc(tAny, n), tocaAmbos: pc(tBoth, n),
    abreDentroRangoAyer: pc(inside, n), dentroYTocaAlguno: pc(insideAny, inside),
    trade: { ops: trades, llegaAlNivel: pc(nearHit, nearN), ganadoras: pc(wins, trades), cierresPorHora: timeEx, R: +R.toFixed(1), mitad1: +R1.toFixed(1), mitad2: +R2.toFixed(1) } };
}
async function prevday(u: URL) {
  const symbols = (u.searchParams.get("symbols") || "BTCUSDT").toUpperCase().split(",").filter(Boolean).slice(0, 15);
  const days = Math.min(365, +(u.searchParams.get("days") || 365)); const tz = u.searchParams.get("tz") || "Etc/GMT-2";
  const fee = +(u.searchParams.get("fee") || 0.02); const slMult = +(u.searchParams.get("slMult") || 1); const endH = +(u.searchParams.get("endH") || 24); const lag = +(u.searchParams.get("lag") || 1);
  const out: any = { days, tz, fee, slMult, endH, lag, res: {} };
  for (const s of symbols) { try { const { bars } = await loadBars(s, days, "5m"); out.res[s] = { desde: new Date(bars[0].t).toISOString().slice(0, 10), ...prevDay(bars, tz, fee, slMult, endH, lag) }; } catch (e: any) { out.res[s] = { error: String(e.message || e) }; } }
  return out;
}

// ---------- HTTP ----------
async function handle(req: Request) {
  const u = new URL(req.url);
  if (u.pathname === "/") return new Response("ok. usa /run?symbols=BTCUSDT,SOLUSDT&days=90");
  if (u.pathname.startsWith("/sweep")) {
    const id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    jobs.set(id, { status: "running", started: new Date().toISOString() });
    sweep(u).then((r) => jobs.set(id, { status: "done", result: r })).catch((e) => jobs.set(id, { status: "error", error: String(e) }));
    return Response.json({ job: id, ver: `/job/${id}` });
  }
  if (u.pathname.startsWith("/variants")) {
    const id = "v" + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    jobs.set(id, { status: "running", started: new Date().toISOString() });
    variants(u).then((r) => jobs.set(id, { status: "done", result: r })).catch((e) => jobs.set(id, { status: "error", error: String(e) }));
    return Response.json({ job: id, ver: `/job/${id}` });
  }
  if (u.pathname.startsWith("/job")) { const id = u.searchParams.get("id") || u.pathname.split("/")[2] || ""; return Response.json(jobs.get(id) ?? { status: "unknown", id }); }
  if (u.pathname.startsWith("/prevday")) return Response.json(await prevday(u));
  if (u.pathname.startsWith("/hours")) return Response.json(await hours(u));
  if (!u.pathname.startsWith("/run")) return new Response("not found", { status: 404 });
  const symbols = (u.searchParams.get("symbols") || "BTCUSDT").toUpperCase().split(",").filter(Boolean).slice(0, 15);
  const tf = TF_MS[u.searchParams.get("tf") || "5m"] ? (u.searchParams.get("tf") || "5m") : "5m";
  const days = Math.min(tf === "5m" ? 365 : 1100, Math.max(1, +(u.searchParams.get("days") || 90)));
  const withTrades = u.searchParams.get("trades") === "1";
  const P: Record<string, number> = {};
  for (const k of Object.keys(DEFAULTS)) { const v = u.searchParams.get(k); if (v !== null && v !== "" && !isNaN(+v)) P[k] = +v; }
  const out: any = { tf, days, params: { ...DEFAULTS, ...P }, resultados: {} };
  for (const s of symbols) {
    try {
      const { bars, src } = await loadBars(s, days, tf);
      if (P.auto) await attachScale(bars, days, tf);
      const res = simulate(bars, P);
      out.resultados[s] = { fuente: src, velas: bars.length, desde: new Date(bars[0].t).toISOString().slice(0, 10), modelos: res.map((r, k) => (withTrades ? r : { ...r, trades: undefined, meses: k === 6 ? r.meses : undefined })) };
    } catch (e: any) { out.resultados[s] = { error: String(e.message || e) }; }
  }
  // totals per model across symbols
  const tot: Record<string, any> = {};
  for (const s of symbols) for (const r of out.resultados[s]?.modelos ?? []) {
    const t = (tot[r.modelo] ??= { ops: 0, tp: 0, Rneto: 0, Rmitad1: 0, Rmitad2: 0, activos_positivos: 0 });
    t.ops += r.ops; t.tp += r.tp; t.Rneto += r.Rneto; t.Rmitad1 += r.Rmitad1; t.Rmitad2 += r.Rmitad2; if (r.Rneto > 0) t.activos_positivos++;
  }
  for (const t of Object.values(tot)) { t.wr = t.ops ? +(100 * t.tp / t.ops).toFixed(1) : 0; t.Rneto = +t.Rneto.toFixed(2); t.Rmitad1 = +t.Rmitad1.toFixed(2); t.Rmitad2 = +t.Rmitad2.toFixed(2); }
  out.totales = tot;
  return Response.json(out);
}

if (import.meta.main) {
  Bun.serve({ port: +(Bun.env.PORT || 3000), idleTimeout: 255, fetch: handle });
  // AUTOJOB: consultas de /variants separadas por "||"; el resultado se escribe en los logs
  const aj = Bun.env.AUTOJOB;
  if (aj) (async () => { for (const q of aj.split("||")) { try { const r = await variants(new URL("http://x/variants?" + q.trim()));
    const c: Record<string, any> = {}; for (const [n, v] of Object.entries<any>(r.res)) c[n] = [v.ops, v.tpPct, v.R, v.mitad1, v.mitad2, v.activosPositivos, Object.values<number>(v.porActivo).map((x) => Math.round(x)).join("/")];
    console.log("AUTOJOB " + JSON.stringify({ q: q.trim().slice(0, 60), errors: r.errors, res: c })); } catch (e: any) { console.log("AUTOJOB ERROR " + String(e)); } } })();
}
