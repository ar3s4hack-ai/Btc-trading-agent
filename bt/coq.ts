// Replica del indicador "Coqueto Escenario 1.4" (valores por defecto) + su checklist del manual como estrategia.
import type { Bar } from "./index.ts";

const nanArr = (n: number) => new Array<number>(n).fill(NaN);
function ema(src: number[], n: number) { // Pine ta.ema (semilla SMA)
  const o = nanArr(src.length); const a = 2 / (n + 1); let cnt = 0, sum = 0, prev = NaN;
  for (let i = 0; i < src.length; i++) { const v = src[i]; if (!isFinite(v)) continue;
    if (!isFinite(prev)) { cnt++; sum += v; if (cnt === n) { prev = sum / n; o[i] = prev; } } else { prev = a * v + (1 - a) * prev; o[i] = prev; } }
  return o;
}
function rma(src: number[], n: number) { // Pine ta.rma (semilla SMA)
  const o = nanArr(src.length); let cnt = 0, sum = 0, prev = NaN;
  for (let i = 0; i < src.length; i++) { const v = src[i]; if (!isFinite(v)) continue;
    if (!isFinite(prev)) { cnt++; sum += v; if (cnt === n) { prev = sum / n; o[i] = prev; } } else { prev = (prev * (n - 1) + v) / n; o[i] = prev; } }
  return o;
}
function pivH(x: number[], i: number, L: number, R: number) { const c = i - R; if (c - L < 0) return NaN;
  for (let k = c - L; k < c; k++) if (!(x[c] > x[k])) return NaN; for (let k = c + 1; k <= i; k++) if (!(x[c] >= x[k])) return NaN; return x[c]; }
function pivL(x: number[], i: number, L: number, R: number) { const c = i - R; if (c - L < 0) return NaN;
  for (let k = c - L; k < c; k++) if (!(x[c] < x[k])) return NaN; for (let k = c + 1; k <= i; k++) if (!(x[c] <= x[k])) return NaN; return x[c]; }
const trendOf = (c: number, f: number, s: number) => (c > s && f > s ? 1 : c < s && f < s ? -1 : 0);

// tendencia EMA50/200 de la ultima vela CERRADA de la temporalidad mayor (como request.security(..., t[1], lookahead_on))
function htfTrend(B: Bar[], ms: number) {
  const keys: number[] = [], cl: number[] = []; const idx = new Int32Array(B.length);
  for (let i = 0; i < B.length; i++) { const k = Math.floor(B[i].t / ms); if (!keys.length || keys[keys.length - 1] !== k) { keys.push(k); cl.push(B[i].c); } else cl[cl.length - 1] = B[i].c; idx[i] = keys.length - 1; }
  const f = ema(cl, 50), s = ema(cl, 200); const tr = cl.map((c, j) => trendOf(c, f[j], s[j]));
  const o = new Int8Array(B.length); for (let i = 0; i < B.length; i++) { const j = idx[i] - 1; o[i] = j >= 0 ? tr[j] : 0; }
  return o;
}

export type Coq = ReturnType<typeof coqueto>;
export function coqueto(B: Bar[], htf1Ms = 900000, htf2Ms = 3600000) {
  const N = B.length; const H = B.map((b) => b.h), L = B.map((b) => b.l), C = B.map((b) => b.c), O = B.map((b) => b.o);
  const TR = B.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - C[i - 1]), Math.abs(b.l - C[i - 1])) : b.h - b.l));
  const atr = rma(TR, 14);
  const up = C.map((c, i) => (i ? Math.max(c - C[i - 1], 0) : NaN)), dn = C.map((c, i) => (i ? Math.max(C[i - 1] - c, 0) : NaN));
  const ru = rma(up, 14), rd = rma(dn, 14); const rsi = ru.map((u, i) => (rd[i] === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / rd[i])));
  const pDM = B.map((b, i) => { if (!i) return NaN; const u = b.h - H[i - 1], d = L[i - 1] - b.l; return u > d && u > 0 ? u : 0; });
  const mDM = B.map((b, i) => { if (!i) return NaN; const u = b.h - H[i - 1], d = L[i - 1] - b.l; return d > u && d > 0 ? d : 0; });
  const trR = rma(TR.map((x, i) => (i ? x : NaN)), 14), pR = rma(pDM, 14), mR = rma(mDM, 14);
  const dx = B.map((_, i) => { const p = 100 * pR[i] / trR[i], m = 100 * mR[i] / trR[i]; return isFinite(p) && isFinite(m) ? (p + m === 0 ? 0 : 100 * Math.abs(p - m) / (p + m)) : NaN; });
  const adx = rma(dx, 14);
  const emaF = ema(C, 50), emaS = ema(C, 200);
  const tH1 = htfTrend(B, htf1Ms), tH2 = htfTrend(B, htf2Ms);

  const out = { tL: new Int8Array(N), tH1, tH2, bias: new Int8Array(N), pUp: nanArr(N), nRes: new Int32Array(N), nearSup: new Uint8Array(N), nearRes: new Uint8Array(N),
    supPx: nanArr(N), resPx: nanArr(N), pat: new Int8Array(N), atr, adx };
  type Z = { top: number; bot: number; kind: number; touches: number };
  const zones: Z[] = [];
  let lastPH = NaN, lastPHBar = NaN, lastPL = NaN, lastPLBar = NaN;
  let dtArmed = false, dtNeck = NaN, dtTop = NaN, dtExpire = NaN, dbArmed = false, dbNeck = NaN, dbBot = NaN, dbExpire = NaN;
  const upFirst = new Int32Array(54), dnFirst = new Int32Array(54);
  const pend: { st: number; s: number; u: number; d: number }[] = [];
  const body = (i: number) => Math.abs(C[i] - O[i]);

  for (let i = 0; i < N; i++) {
    const a = atr[i];
    const tL = trendOf(C[i], emaF[i], emaS[i]); out.tL[i] = tL;
    const trendScore = tL + tH1[i] + tH2[i];
    const trending = adx[i] >= 22;
    // zonas
    const ph = pivH(H, i, 10, 10), pl = pivL(L, i, 10, 10);
    const addLevel = (price: number, kind: number, w: number) => {
      for (const z of zones) if (price >= z.bot - w * 0.5 && price <= z.top + w * 0.5) { z.touches++; return; }
      zones.push({ top: kind === 1 ? price : price + w, bot: kind === 1 ? price - w : price, kind, touches: 1 }); if (zones.length > 10) zones.shift();
    };
    if (isFinite(ph) && isFinite(a)) addLevel(ph, 1, a * 0.5);
    if (isFinite(pl) && isFinite(a)) addLevel(pl, -1, a * 0.5);
    for (const z of zones) { if (z.kind === 1 && C[i] > z.top) z.kind = -1; else if (z.kind === -1 && C[i] < z.bot) z.kind = 1; }
    let supPrice = NaN, supDist = NaN, resPrice = NaN, resDist = NaN, touchSup = false, touchRes = false;
    if (isFinite(a) && a > 0) for (const z of zones) {
      if (z.kind === -1 && L[i] <= z.top + 0.1 * a && C[i] >= z.bot) touchSup = true;
      if (z.kind === 1 && H[i] >= z.bot - 0.1 * a && C[i] <= z.top) touchRes = true;
      if (z.kind === -1 && z.bot <= C[i]) { const d = Math.max(0, C[i] - z.top) / a; if (!isFinite(supDist) || d < supDist) { supDist = d; supPrice = z.top; } }
      else if (z.kind === 1 && z.top >= C[i]) { const d = Math.max(0, z.bot - C[i]) / a; if (!isFinite(resDist) || d < resDist) { resDist = d; resPrice = z.bot; } }
    }
    const nearSup = isFinite(supDist) && supDist <= 1, nearRes = isFinite(resDist) && resDist <= 1;
    out.nearSup[i] = +nearSup; out.nearRes[i] = +nearRes; out.supPx[i] = supPrice; out.resPx[i] = resPrice;
    // patrones
    let pat = 0;
    if (i >= 2 && isFinite(a)) {
      const bd = body(i), rg = H[i] - L[i], uw = H[i] - Math.max(O[i], C[i]), lw = Math.min(O[i], C[i]) - L[i];
      const bullE = C[i - 1] < O[i - 1] && C[i] > O[i] && O[i] <= C[i - 1] && C[i] >= O[i - 1] && bd > body(i - 1) && bd >= 0.3 * a;
      const bearE = C[i - 1] > O[i - 1] && C[i] < O[i] && O[i] >= C[i - 1] && C[i] <= O[i - 1] && bd > body(i - 1) && bd >= 0.3 * a;
      const ham = rg >= 0.5 * a && lw >= 2 * bd && lw >= 0.6 * rg && uw <= 0.2 * rg, sho = rg >= 0.5 * a && uw >= 2 * bd && uw >= 0.6 * rg && lw <= 0.2 * rg;
      const big2 = body(i - 2) >= 0.6 * (H[i - 2] - L[i - 2]) && body(i - 2) >= 0.5 * a;
      const ms = C[i - 2] < O[i - 2] && big2 && body(i - 1) <= 0.3 * body(i - 2) && C[i] > O[i] && C[i] > (O[i - 2] + C[i - 2]) / 2;
      const es = C[i - 2] > O[i - 2] && big2 && body(i - 1) <= 0.3 * body(i - 2) && C[i] < O[i] && C[i] < (O[i - 2] + C[i - 2]) / 2;
      const bullLoc = touchSup || nearSup, bearLoc = touchRes || nearRes;
      // dobles
      if (isFinite(ph)) { const phBar = i - 10;
        if (isFinite(lastPH) && phBar - lastPHBar <= 150 && Math.abs(ph - lastPH) <= a && isFinite(lastPLBar) && lastPLBar > lastPHBar && lastPLBar < phBar && Math.max(ph, lastPH) - lastPL >= a) { dtArmed = true; dtNeck = lastPL; dtTop = Math.max(ph, lastPH); dtExpire = i + 150; }
        lastPH = ph; lastPHBar = phBar; }
      if (isFinite(pl)) { const plBar = i - 10;
        if (isFinite(lastPL) && plBar - lastPLBar <= 150 && Math.abs(pl - lastPL) <= a && isFinite(lastPHBar) && lastPHBar > lastPLBar && lastPHBar < plBar && lastPH - Math.min(pl, lastPL) >= a) { dbArmed = true; dbNeck = lastPH; dbBot = Math.min(pl, lastPL); dbExpire = i + 150; }
        lastPL = pl; lastPLBar = plBar; }
      let dblTop = false, dblBot = false;
      if (dtArmed) { if (C[i] > dtTop || i > dtExpire) dtArmed = false; else if (C[i] < dtNeck) { dblTop = true; dtArmed = false; } }
      if (dbArmed) { if (C[i] < dbBot || i > dbExpire) dbArmed = false; else if (C[i] > dbNeck) { dblBot = true; dbArmed = false; } }
      pat = dblBot ? 4 : dblTop ? 8 : ms && bullLoc ? 3 : es && bearLoc ? 7 : bullE && bullLoc ? 1 : bearE && bearLoc ? 5 : ham && bullLoc ? 2 : sho && bearLoc ? 6 : 0;
    }
    out.pat[i] = pat;
    // estado y estadistica (+1 ATR antes que -1 ATR en 12 velas)
    const trendCls = trendScore >= 2 ? 2 : trendScore <= -2 ? 0 : 1, regCls = trending ? 1 : 0;
    const locCls = nearSup && (!nearRes || supDist <= resDist) ? 1 : nearRes ? 2 : 0, rsiCls = rsi[i] < 40 ? 0 : rsi[i] > 60 ? 2 : 1;
    const valid = isFinite(a) && isFinite(rsi[i]) && isFinite(adx[i]) && isFinite(emaS[i]);
    const s = valid ? trendCls * 18 + regCls * 9 + locCls * 3 + rsiCls : -1;
    for (let k = pend.length - 1; k >= 0; k--) { const p = pend[k]; const hu = H[i] >= p.u, hd = L[i] <= p.d, ex = i - p.st >= 12;
      if (hu || hd || ex) { if (hu && !hd) upFirst[p.s]++; else if (hd && !hu) dnFirst[p.s]++; pend.splice(k, 1); } }
    if (s >= 0) pend.push({ st: i, s, u: C[i] + a, d: C[i] - a });
    const n = s >= 0 ? upFirst[s] + dnFirst[s] : 0; const pu = n > 0 ? 100 * upFirst[s] / n : NaN;
    out.nRes[i] = n; out.pUp[i] = pu; out.bias[i] = n < 30 ? 0 : pu >= 57 ? 1 : 100 - pu >= 57 ? -1 : 0;
  }
  return out;
}

// Estrategia del manual (5.1): 15m y 1h a favor + cerca de soporte sin resistencia pegada (o al reves) + sesgo a favor; SL 1.5 ATR, TP 3 ATR.
// v: 0 = checklist, 1 = checklist + patron a favor en la vela, 2 = solo triangulo de cambio de sesgo
export type CoqTrade = { i: number; x: number; d: number; r: number; riskPct: number; res: string };
export function simCoq(B: Bar[], q: Coq, v = 0, slM = 1.5, rr = 2) {
  const T: CoqTrade[] = []; let dir = 0, e = 0, sl = 0, tp = 0, ei = 0, risk = 0, pL = false, pS = false;
  for (let i = 1; i < B.length; i++) {
    const b = B[i];
    if (dir) { const hs = dir === 1 ? b.l <= sl : b.h >= sl, ht = dir === 1 ? b.h >= tp : b.l <= tp;
      if (hs || ht) { T.push({ i: ei, x: i, d: dir, r: hs ? -1 : rr, riskPct: 100 * risk / e, res: hs ? "SL" : "TP" }); dir = 0; } }
    let cL: boolean, cS: boolean;
    if (v === 2) { cL = q.bias[i] === 1 && q.bias[i - 1] !== 1; cS = q.bias[i] === -1 && q.bias[i - 1] !== -1; }
    else { cL = q.tH1[i] === 1 && q.tH2[i] === 1 && !!q.nearSup[i] && !q.nearRes[i] && q.bias[i] === 1 && (v !== 1 || (q.pat[i] >= 1 && q.pat[i] <= 4));
      cS = q.tH1[i] === -1 && q.tH2[i] === -1 && !!q.nearRes[i] && !q.nearSup[i] && q.bias[i] === -1 && (v !== 1 || q.pat[i] >= 5); }
    const sigL = cL && (v === 2 || !pL), sigS = cS && (v === 2 || !pS); pL = cL; pS = cS;
    if (!dir && (sigL || sigS) && isFinite(q.atr[i])) { dir = sigL ? 1 : -1; e = b.c; risk = q.atr[i] * slM; sl = e - dir * risk; tp = e + dir * risk * rr; ei = i; }
  }
  return T;
}
