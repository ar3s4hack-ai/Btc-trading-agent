// Motor generico de reglas sobre niveles de killzones (hora Nueva York) para buscar ventaja estadistica.
// Rango: asia | lon | pd (maximo/minimo del dia anterior, ciclo NY). Ventana de entrada: lon | nyam | day (02:00-16:00 NY).
// modo: brk (cierre fuera del rango -> a favor) | rev (barrido y cierre de vuelta dentro -> en contra).
// SL: brk -> mitad del rango (sl=mid) o k x ATR 1h (sl=atr); rev -> mecha del barrido + 0.1 ATR 5m. TP: tp x R. Cierre 16:00 NY.
// Filtro tendencia (t=1): Supertrend 1h (factor 2.5, ATR 14) a favor + ADX 1h >= 20 (vela de 1h cerrada).
import type { Bar } from "./index.ts";

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map<number, number>();
function nyOff(t: number) { const h = Math.floor(t / 3600000); let o = offCache.get(h);
  if (o === undefined) { const p: Record<string, string> = {}; for (const x of fmt.formatToParts(new Date(h * 3600000))) p[x.type] = x.value;
    o = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - h * 3600000) / 60000); offCache.set(h, o); }
  return o; }
const WIN: Record<string, [number, number]> = { asia: [0, 240], lon: [360, 540], nyam: [810, 900], ny: [810, 1200], day: [360, 1200] };

function stAdx(H: { h: number; l: number; c: number }[], fac = 2.5) {
  const n = H.length, dir = new Array(n).fill(1), adx = new Array(n).fill(NaN), atrA = new Array(n).fill(NaN);
  let atr = 0, up = 0, dn = 0, st = 0, sTR = 0, sP = 0, sM = 0, ax = 0;
  for (let i = 0; i < n; i++) {
    const b = H[i], pc = i ? H[i - 1].c : b.c, tr = i ? Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc)) : b.h - b.l;
    atr = i < 14 ? (atr * i + tr) / (i + 1) : (atr * 13 + tr) / 14; atrA[i] = atr;
    const src = (b.h + b.l) / 2; let u = src - fac * atr, d = src + fac * atr;
    if (i) { u = pc > up ? Math.max(u, up) : u; d = pc < dn ? Math.min(d, dn) : d; }
    let dr: number; if (i === 0) dr = 1; else if (st === dn) dr = b.c > d ? -1 : 1; else dr = b.c < u ? 1 : -1;
    up = u; dn = d; st = dr === -1 ? u : d; dir[i] = dr;
    if (i) { const pm = b.h - H[i - 1].h, mm = H[i - 1].l - b.l; const p = pm > mm && pm > 0 ? pm : 0, m = mm > pm && mm > 0 ? mm : 0;
      sTR = i <= 14 ? sTR + tr : sTR - sTR / 14 + tr; sP = i <= 14 ? sP + p : sP - sP / 14 + p; sM = i <= 14 ? sM + m : sM - sM / 14 + m;
      if (i >= 14 && sTR > 0) { const dp = 100 * sP / sTR, dm = 100 * sM / sTR, dx = dp + dm > 0 ? 100 * Math.abs(dp - dm) / (dp + dm) : 0; ax = i < 28 ? (ax * (i - 14) + dx) / (i - 13) : (ax * 13 + dx) / 14; if (i >= 28) adx[i] = ax; } }
  }
  return { dir, adx, atr: atrA };  // dir -1 = alcista (convencion TradingView)
}

export type Rule = { src: "asia" | "lon" | "pd"; win: string; mode: "brk" | "rev"; tp: number; t?: number; sl?: "mid" | "atr"; k?: number; maxRng?: number; minRng?: number };
export type R2 = { i: number; d: number; r: number; riskPct: number; res: string };

export function simRule(B: Bar[], rule: Rule) {
  const N = B.length, barMin = N > 1 ? (B[1].t - B[0].t) / 60000 : 5;
  const atr5: number[] = []; { let a = NaN, s = 0; for (let i = 0; i < N; i++) { const b = B[i]; const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l; if (i < 14) { s += tr; if (i === 13) a = s / 14; } else a = (a * 13 + tr) / 14; atr5.push(a); } }
  // velas de 1h y la ultima CERRADA para cada vela de 5m
  const HB: { h: number; l: number; c: number; k: number }[] = []; const h1 = new Int32Array(N);
  for (let i = 0; i < N; i++) { const k = Math.floor(B[i].t / 3600000); const L = HB[HB.length - 1];
    if (!L || L.k !== k) HB.push({ h: B[i].h, l: B[i].l, c: B[i].c, k }); else { L.h = Math.max(L.h, B[i].h); L.l = Math.min(L.l, B[i].l); L.c = B[i].c; }
    h1[i] = (B[i].t + barMin * 60000) % 3600000 === 0 ? HB.length - 1 : HB.length - 2; }
  const S1 = stAdx(HB);
  const T: R2[] = []; let pos: { d: number; e: number; sl: number; tp: number; risk: number; i: number } | null = null;
  let cyc = -1, wk = false, done = false, aH = -Infinity, aL = Infinity, lH = -Infinity, lL = Infinity, cH = -Infinity, cL = Infinity, pH = NaN, pL = NaN;
  let up = false, dn = false, ue = -Infinity, de = Infinity;
  const [w0, w1] = WIN[rule.win];
  for (let i = 0; i < N; i++) {
    const b = B[i]; const s = b.t + (nyOff(b.t) + 240) * 60000; const c = Math.floor(s / 86400000); const m = Math.floor((s % 86400000) / 60000);
    if (c !== cyc) { if (cyc >= 0 && isFinite(cH)) { pH = cH; pL = cL; } cyc = c; const wd = new Date(c * 86400000).getUTCDay(); wk = wd >= 1 && wd <= 5;
      done = false; aH = -Infinity; aL = Infinity; lH = -Infinity; lL = Infinity; cH = -Infinity; cL = Infinity; up = dn = false; ue = -Infinity; de = Infinity; }
    if (pos && i > pos.i) { const p = pos; const hs = p.d === 1 ? b.l <= p.sl : b.h >= p.sl, ht = p.d === 1 ? b.h >= p.tp : b.l <= p.tp;
      const fin = (res: string, xp: number) => { T.push({ i: p.i, d: p.d, r: res === "TP" ? rule.tp : res === "SL" ? -1 : p.d * (xp - p.e) / p.risk, riskPct: 100 * p.risk / p.e, res }); pos = null; };
      if (hs) fin("SL", p.sl); else if (ht) fin("TP", p.tp); else if (m + barMin >= 1200 || m < 240) fin("TIME", b.c); }
    if (m >= 0 && m < 240) { aH = Math.max(aH, b.h); aL = Math.min(aL, b.l); }
    if (m >= 360 && m < 540) { lH = Math.max(lH, b.h); lL = Math.min(lL, b.l); }
    cH = Math.max(cH, b.h); cL = Math.min(cL, b.l);
    if (!wk || done || pos || m < w0 || m >= w1 || !isFinite(atr5[i])) continue;
    if (rule.src === "lon" && m < 540) continue;
    const rH = rule.src === "asia" ? aH : rule.src === "lon" ? lH : pH, rL = rule.src === "asia" ? aL : rule.src === "lon" ? lL : pL;
    if (!isFinite(rH) || !isFinite(rL)) continue;
    const hi = h1[i]; const atr1 = hi >= 0 ? S1.atr[hi] : NaN;
    if (rule.maxRng && (rH - rL) > rule.maxRng * atr1) { done = true; continue; }
    if (rule.minRng && (rH - rL) < rule.minRng * atr1) { done = true; continue; }
    const tOk = (d: number) => !rule.t || (hi >= 0 && S1.dir[hi] === -d && S1.adx[hi] >= 20);
    let d = 0, sl = NaN;
    if (rule.mode === "brk") {
      const sd = b.c > rH ? 1 : b.c < rL ? -1 : 0; if (!sd) continue;
      done = true; if (!tOk(sd)) continue; d = sd;
      sl = rule.sl === "atr" ? b.c - d * (rule.k ?? 1) * atr1 : (rH + rL) / 2;
      if (d * (b.c - sl) <= 0) continue;
    } else {
      if (b.h > rH) up = true; if (up) ue = Math.max(ue, b.h);
      if (b.l < rL) dn = true; if (dn) de = Math.min(de, b.l);
      if (!(b.c < rH && b.c > rL)) continue;
      for (const dd of [-1, 1]) { if ((dd === -1 ? up : dn) && tOk(dd)) { d = dd; break; } }
      if (!d) continue;
      done = true; sl = d === -1 ? ue + 0.1 * atr5[i] : de - 0.1 * atr5[i];
    }
    const risk = Math.abs(b.c - sl); pos = { d, e: b.c, sl, tp: b.c + d * rule.tp * risk, risk, i };
  }
  return T;
}
