// Replica del "Confluence Engine" (modulo 9) del indicador CAD++ & VWAP, con sus modulos de votos/gatillos.
// Valores por defecto = los del indicador. Entrada al cierre de la vela; SL y TP en la misma vela => SL.
import type { Bar } from "./index.ts";

export type CEOpt = { minScore?: number; reqTrig?: number; reqSR?: number; tpRR?: number; minRR?: number; maxSL?: number; cool?: number };
export type CETrade = { i: number; x: number; d: number; e: number; sl: number; tp: number; res: string; r: number; riskPct: number };

const nanArr = (n: number) => new Array<number>(n).fill(NaN);
// Pine ta.ema: semilla = SMA de las primeras n velas validas
function ema(src: number[], n: number) {
  const o = nanArr(src.length); const a = 2 / (n + 1); let cnt = 0, sum = 0, prev = NaN;
  for (let i = 0; i < src.length; i++) {
    const v = src[i]; if (!isFinite(v)) { continue; }
    if (!isFinite(prev)) { cnt++; sum += v; if (cnt === n) { prev = sum / n; o[i] = prev; } }
    else { prev = a * v + (1 - a) * prev; o[i] = prev; }
  }
  return o;
}
function sma(src: number[], n: number) {
  const o = nanArr(src.length); let s = 0;
  for (let i = 0; i < src.length; i++) { s += src[i]; if (i >= n) s -= src[i - n]; if (i >= n - 1) o[i] = s / n; }
  return o;
}
function atrRma(B: Bar[], n: number) {
  const o = nanArr(B.length); let s = 0;
  for (let i = 0; i < B.length; i++) {
    const b = B[i]; const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l;
    if (i < n) { s += tr; if (i === n - 1) o[i] = s / n; } else o[i] = (o[i - 1] * (n - 1) + tr) / n;
  }
  return o;
}
// pivote (izquierda estricta, derecha >=), confirmado en la vela i con valor en i-R
function pivH(x: number[], i: number, L: number, R: number) { const c = i - R; if (c - L < 0) return NaN;
  for (let k = c - L; k < c; k++) if (!(x[c] > x[k])) return NaN; for (let k = c + 1; k <= i; k++) if (!(x[c] >= x[k])) return NaN; return x[c]; }
function pivL(x: number[], i: number, L: number, R: number) { const c = i - R; if (c - L < 0) return NaN;
  for (let k = c - L; k < c; k++) if (!(x[c] < x[k])) return NaN; for (let k = c + 1; k <= i; k++) if (!(x[c] <= x[k])) return NaN; return x[c]; }

export function simCE(B: Bar[], opt: CEOpt = {}) { return simCEFull(B, opt).trades; }
export function simCEFull(B: Bar[], opt: CEOpt = {}) {
  const minScore = opt.minScore ?? 5, reqTrig = opt.reqTrig ?? 1, reqSR = opt.reqSR ?? 1, tpRR = opt.tpRR ?? 0;
  const minRR = opt.minRR ?? 1.5, maxSL = opt.maxSL ?? 3.0, cool = opt.cool ?? 5;
  const trigWin = 3, rejWin = 3, srLen = 10, zoneW = 0.5, maxZones = 12, minWick = 0.25, obLook = 10, slBuf = 0.3, minSL = 0.5, rrFixed = 2.0;
  const N = B.length;
  const H = B.map((b) => b.h), Lo = B.map((b) => b.l), C = B.map((b) => b.c), O = B.map((b) => b.o);

  // M1 Smart Structure Engine (pivote 4, ATR 7, impulso 1.0)
  const atr7 = atrRma(B, 7);
  // M2 EMAs
  const e10 = ema(C, 10), e55 = ema(C, 55), e200 = ema(C, 200);
  // M3 Trend Indicator A (Heikin-Ashi + EMA 9)
  const haO = nanArr(N), haC = nanArr(N), haH = nanArr(N), haL = nanArr(N);
  for (let i = 0; i < N; i++) { haC[i] = (O[i] + H[i] + Lo[i] + C[i]) / 4; haO[i] = i ? (haO[i - 1] + haC[i - 1]) / 2 : (O[i] + C[i]) / 2; haH[i] = Math.max(H[i], haO[i], haC[i]); haL[i] = Math.min(Lo[i], haO[i], haC[i]); }
  const mO = ema(haO, 9), mC = ema(haC, 9), mH = ema(haH, 9), mL = ema(haL, 9);
  const trend = (i: number) => { const r = mH[i] - mL[i]; return r !== 0 && isFinite(r) ? 100 * (mC[i] - mO[i]) / r : 0; };
  // M4 Bollinger (base SMA 20)
  const bbB = sma(C, 20);
  // M5 Zero-Lag MA 15
  const zlE = ema(C, 15); const zlM = ema(C.map((c, i) => c + (c - zlE[i])), 15);
  // M6 Multi DSMA (periodo 30, paso 40, fuente close)
  const DS: number[][] = [];
  for (let k = 0; k < 8; k++) {
    const p = 30 + 40 * k, g = Math.sqrt(2), pi = Math.PI, s = 2 * pi / p, a1 = Math.exp(-g * pi / (0.5 * p)), b1 = 2 * a1 * Math.cos(g * s / (0.5 * p)), c2 = b1, c3 = -a1 * a1, c1 = 1 - c2 - c3;
    const out = nanArr(N); let f1 = 0, f2 = 0, z1 = NaN, ds = 0; const f2s: number[] = [];
    for (let i = 0; i < N; i++) { const z = i >= 2 ? C[i] - C[i - 2] : NaN; let f = c1 * (z + z1) / 2 + c2 * f1 + c3 * f2; if (!isFinite(f)) f = NaN;
      f2 = f1; f1 = isFinite(f) ? f : 0; z1 = z; f2s.push(isFinite(f) ? f * f : NaN); out[i] = f; }
    const ems = ema(f2s, p);
    for (let i = 0; i < N; i++) { const rms = Math.sqrt(ems[i]); const f = out[i]; const sc = isFinite(rms) && rms !== 0 && isFinite(f) ? f / rms : 0; const al = Math.abs(sc) * 5 / p; ds = al * C[i] + (1 - al) * ds; out[i] = ds; }
    DS.push(out);
  }
  const dsScore = (i: number) => { let s = 0; for (let k = 0; k < 8; k++) if (DS[k][i] > DS[7][i]) s += 1 / 7; return s; };
  // M7 ICT SMAs
  const sL = sma(Lo, 20), sH = sma(H, 20);
  // M8 VWAP sesion (UTC), hlc3
  const VW = nanArr(N); { let pv = 0, vv = 0, day = -1; for (let i = 0; i < N; i++) { const d = Math.floor(B[i].t / 86400000); if (d !== day) { pv = 0; vv = 0; day = d; } const h3 = (H[i] + Lo[i] + C[i]) / 3; pv += h3 * B[i].v; vv += B[i].v; VW[i] = vv > 0 ? pv / vv : NaN; } }
  // M9 base
  const atr14 = atrRma(B, 14);

  // estado M1
  let lastHigh = NaN, prevHigh = NaN, lastLow = NaN, prevLow = NaN, lastSignal = 0;
  // estado M7 ICT SwiftEdge (estructura en el mismo TF, rlBars = 2 por defecto "30M")
  const rl = 2; type Pv = { pp: number; pi: number } | null;
  let bull = false, nPh1 = NaN, nPl1 = NaN; let pH: Pv = null, pL: Pv = null, nPh: Pv = null, nPl: Pv = null, prevNPh: Pv = null, prevNPl: Pv = null;
  const lin: number[] = []; let mssBullVar = false, mssBearVar = false;
  let tBosBull = NaN, tBosBear = NaN, lBosBull = NaN, lBosBear = NaN, pBosBull = NaN, pBosBear = NaN, trendState = 0, ictSeen = false;
  // estado M9
  type Z = { top: number; bot: number; dir: number; touches: number };
  const zones: Z[] = [];
  let bullOBlo = NaN, bullOBhi = NaN, bearOBlo = NaN, bearOBhi = NaN;
  let lastTrigL = -1e9, lastTrigS = -1e9, lastRejL = -1e9, lastRejS = -1e9, rejLBot = NaN, rejSTop = NaN;
  let prevCondL = false, prevCondS = false, lastSigBar = -1e9;
  let dir = 0, entry = NaN, sl = NaN, tp = NaN, risk = NaN, eBar = 0;
  const trades: CETrade[] = []; const vb = new Int8Array(N), vs = new Int8Array(N);
  const close = (i: number, res: string, xp: number) => { const r = dir * (xp - entry) / risk; trades.push({ i: eBar, x: i, d: dir, e: entry, sl, tp, res, r, riskPct: 100 * risk / entry }); dir = 0; };

  for (let i = 0; i < N; i++) {
    const b = B[i];
    // ---- M1
    const ph4 = pivH(H, i, 4, 4), pl4 = pivL(Lo, i, 4, 4);
    if (isFinite(ph4)) { prevHigh = lastHigh; lastHigh = ph4; }
    if (isFinite(pl4)) { prevLow = lastLow; lastLow = pl4; }
    const body = Math.abs(b.c - b.o), rg = b.h - b.l;
    const bullImp = b.c > b.o && body > rg * 0.5 && body > atr7[i], bearImp = b.c < b.o && body > rg * 0.5 && body > atr7[i];
    const isHH = isFinite(prevHigh) && lastHigh > prevHigh, isLH = isFinite(prevHigh) && lastHigh < prevHigh;
    const isLL = isFinite(prevLow) && lastLow < prevLow, isHL = isFinite(prevLow) && lastLow > prevLow;
    const buySig = (isLL || isHL) && bullImp && lastSignal !== 1, sellSig = (isHH || isLH) && bearImp && lastSignal !== -1;
    if (buySig) lastSignal = 1; if (sellSig) lastSignal = -1;
    // ---- M5 cruce
    const zlUp = i > 0 && zlM[i] > zlE[i] && zlM[i - 1] <= zlE[i - 1], zlDn = i > 0 && zlM[i] < zlE[i] && zlM[i - 1] >= zlE[i - 1];
    // ---- M7 ICT
    const phPs = pivH(H, i, rl, rl), plPs = pivL(Lo, i, rl, rl);
    if (isFinite(phPs)) { nPh = { pp: phPs, pi: B[i - rl].t }; if (!pH) pH = { ...nPh }; }
    if (isFinite(plPs)) { nPl = { pp: plPs, pi: B[i - rl].t }; if (!pL) pL = { ...nPl }; }
    let bosBull = false, bosBear = false, mssBull = false, mssBear = false;
    const htfC = i ? C[i - 1] : NaN, htfT = i ? B[i - 1].t : NaN;
    const highCond = bull ? b.h : htfC, tHigh = bull ? b.t : htfT;
    if ((plPs > nPl1 && bull) || !isFinite(nPl1) || plPs < nPl1) nPl1 = plPs;
    if (pH && highCond > pH.pp) {
      if (bull) { bosBull = true; tBosBull = pH.pp; if (!mssBullVar && lin.length) lin.shift(); mssBullVar = false; }
      else { mssBull = true; mssBullVar = true; }
      bull = true; mssBearVar = false; pH = null; pL = null; if (isFinite(nPl1) && nPl) pL = { ...nPl }; lin.unshift(tHigh);
    }
    const lowCond = bull ? htfC : b.l, tLow = bull ? htfT : b.t;
    if ((phPs < nPh1 && !bull) || !isFinite(nPh1) || phPs > nPh1) nPh1 = phPs;
    if (pL && lowCond < pL.pp) {
      if (!bull) { bosBear = true; tBosBear = pL.pp; if (!mssBearVar && lin.length) lin.shift(); mssBearVar = false; }
      else { mssBear = true; mssBearVar = true; }
      bull = false; mssBullVar = false; pH = null; pL = null; if (isFinite(nPh1) && nPh) pH = { ...nPh }; lin.unshift(tLow);
    }
    if (pH && nPh && prevNPh && lin.length && !bull && nPh.pp !== prevNPh.pp && nPh.pi <= lin[0]) pH = { ...nPh };
    if (pL && nPl && prevNPl && lin.length && bull && nPl.pp !== prevNPl.pp && nPl.pi <= lin[0]) pL = { ...nPl };
    if (nPh && b.h > nPh.pp) nPh = null;
    if (nPl && b.l < nPl.pp) nPl = null;
    prevNPh = nPh; prevNPl = nPl;
    pBosBull = lBosBull; pBosBear = lBosBear;
    if (bosBull && isFinite(tBosBull)) lBosBull = tBosBull;
    if (bosBear && isFinite(tBosBear)) lBosBear = tBosBear;
    const aboveBoth = b.c > sH[i] && b.c > sL[i], belowBoth = b.c < sH[i] && b.c < sL[i], between = b.c > sL[i] && b.c < sH[i];
    const ictBuyC = i > 0 && b.c > lBosBull && C[i - 1] <= pBosBull && aboveBoth, ictSellC = i > 0 && b.c < lBosBear && C[i - 1] >= pBosBear && belowBoth;
    const ictBuy = ictBuyC && trendState !== 1, ictSell = ictSellC && trendState !== -1;
    if (ictBuy) trendState = 1; if (ictSell) trendState = -1; if (between) trendState = 0;
    if (bosBull || bosBear || mssBull || mssBear) ictSeen = true;

    // ---- M9 votos
    const ds = dsScore(i), tr = trend(i);
    const vBull = +(e10[i] > e55[i] && b.c > e200[i]) + +(tr > 0) + +(zlM[i] > zlE[i]) + +(ds > 0.5) + +aboveBoth + +(b.c > VW[i]) + +(b.c > bbB[i]) + +(lastSignal === 1) + +(ictSeen && bull);
    const vBear = +(e10[i] < e55[i] && b.c < e200[i]) + +(tr < 0) + +(zlM[i] < zlE[i]) + +(ds < 0.5) + +belowBoth + +(b.c < VW[i]) + +(b.c < bbB[i]) + +(lastSignal === -1) + +(ictSeen && !bull);
    vb[i] = vBull; vs[i] = vBear;
    const trigBull = buySig || ictBuy || zlUp, trigBear = sellSig || ictSell || zlDn;

    // 1) zonas S/R
    const w = atr14[i] * zoneW;
    const addZone = (price: number, d: number) => {
      const cTop = d === 1 ? price + w : price, cBot = d === 1 ? price : price - w;
      for (const z of zones) if (z.dir === d && cBot <= z.top + w * 0.25 && cTop >= z.bot - w * 0.25) { z.top = Math.max(z.top, cTop); z.bot = Math.min(z.bot, cBot); z.touches++; return; }
      zones.push({ top: cTop, bot: cBot, dir: d, touches: 1 }); if (zones.length > maxZones) zones.shift();
    };
    if (isFinite(w)) { const zph = pivH(H, i, srLen, srLen), zpl = pivL(Lo, i, srLen, srLen); if (isFinite(zph)) addZone(zph, -1); if (isFinite(zpl)) addZone(zpl, 1); }
    // 2) rechazos, vuelco de zonas y objetivos
    const loW = rg > 0 ? (Math.min(b.o, b.c) - b.l) / rg : 0, upW = rg > 0 ? (b.h - Math.max(b.o, b.c)) / rg : 0;
    let rlj = false, rsj = false, rlBot = NaN, rsTop = NaN, tpUp = NaN, tpDn = NaN;
    for (const z of zones) {
      if (z.dir === 1 && b.l <= z.top && b.c > z.top && loW >= minWick) { rlj = true; rlBot = isFinite(rlBot) ? Math.min(rlBot, z.bot) : z.bot; }
      if (z.dir === -1 && b.h >= z.bot && b.c < z.bot && upW >= minWick) { rsj = true; rsTop = isFinite(rsTop) ? Math.max(rsTop, z.top) : z.top; }
      if (z.dir === -1 && b.c > z.top) { z.dir = 1; z.touches = 1; } else if (z.dir === 1 && b.c < z.bot) { z.dir = -1; z.touches = 1; }
      if (z.dir === -1 && z.bot > b.c) tpUp = isFinite(tpUp) ? Math.min(tpUp, z.bot) : z.bot;
      if (z.dir === 1 && z.top < b.c) tpDn = isFinite(tpDn) ? Math.max(tpDn, z.top) : z.top;
    }
    if (rlj) { lastRejL = i; rejLBot = rlBot; } if (rsj) { lastRejS = i; rejSTop = rsTop; }
    if (trigBull) lastTrigL = i; if (trigBear) lastTrigS = i;
    // 3) order blocks
    const bullBrk = (bullImp && isFinite(lastHigh) && b.c > lastHigh) || bosBull || mssBull;
    const bearBrk = (bearImp && isFinite(lastLow) && b.c < lastLow) || bosBear || mssBear;
    if (bullBrk) { let lo = NaN, hi = NaN; for (let k = 1; k <= obLook && i - k >= 0; k++) { const q = B[i - k]; if (q.c < q.o && (!isFinite(lo) || q.l < lo)) { lo = q.l; hi = q.h; } } if (isFinite(lo)) { bullOBlo = lo; bullOBhi = hi; } }
    if (bearBrk) { let lo = NaN, hi = NaN; for (let k = 1; k <= obLook && i - k >= 0; k++) { const q = B[i - k]; if (q.c > q.o && (!isFinite(hi) || q.h > hi)) { hi = q.h; lo = q.l; } } if (isFinite(hi)) { bearOBhi = hi; bearOBlo = lo; } }
    if (isFinite(bullOBlo) && b.c < bullOBlo) { bullOBlo = NaN; bullOBhi = NaN; }
    if (isFinite(bearOBhi) && b.c > bearOBhi) { bearOBlo = NaN; bearOBhi = NaN; }
    // 4) gestion de la operacion abierta
    if (dir !== 0) { const hs = dir === 1 ? b.l <= sl : b.h >= sl, ht = dir === 1 ? b.h >= tp : b.l <= tp; if (hs) close(i, "SL", sl); else if (ht) close(i, "TP", tp); }
    // 5) condiciones
    const trigOkL = !reqTrig || i - lastTrigL <= trigWin, trigOkS = !reqTrig || i - lastTrigS <= trigWin;
    const srOkL = !reqSR || i - lastRejL <= rejWin, srOkS = !reqSR || i - lastRejS <= rejWin;
    let lo4 = Infinity, hi4 = -Infinity; for (let k = Math.max(0, i - rejWin); k <= i; k++) { lo4 = Math.min(lo4, Lo[k]); hi4 = Math.max(hi4, H[k]); }
    let slL = NaN, tpL = NaN, rrL = NaN, slOkL = false;
    { const swL = isFinite(lastLow) && lastLow < b.c ? lastLow : NaN, obL = isFinite(bullOBlo) && bullOBlo < b.c ? bullOBlo : NaN; const base = isFinite(obL) ? obL : swL;
      if (isFinite(base)) { let sx = Math.min(base, lo4); if (isFinite(rejLBot) && i - lastRejL <= rejWin) sx = Math.min(sx, rejLBot); slL = sx - atr14[i] * slBuf; const rk = b.c - slL;
        slOkL = rk >= atr14[i] * minSL && rk <= atr14[i] * maxSL; if (slOkL) { tpL = !tpRR && isFinite(tpUp) ? tpUp : b.c + rk * rrFixed; rrL = (tpL - b.c) / rk; } } }
    let slS = NaN, tpS = NaN, rrS = NaN, slOkS = false;
    { const swS = isFinite(lastHigh) && lastHigh > b.c ? lastHigh : NaN, obS = isFinite(bearOBhi) && bearOBhi > b.c ? bearOBhi : NaN; const base = isFinite(obS) ? obS : swS;
      if (isFinite(base)) { let sx = Math.max(base, hi4); if (isFinite(rejSTop) && i - lastRejS <= rejWin) sx = Math.max(sx, rejSTop); slS = sx + atr14[i] * slBuf; const rk = slS - b.c;
        slOkS = rk >= atr14[i] * minSL && rk <= atr14[i] * maxSL; if (slOkS) { tpS = !tpRR && isFinite(tpDn) ? tpDn : b.c - rk * rrFixed; rrS = (b.c - tpS) / rk; } } }
    const condL = vBull >= minScore && vBull > vBear && trigOkL && srOkL && slOkL && rrL >= minRR;
    const condS = vBear >= minScore && vBear > vBull && trigOkS && srOkS && slOkS && rrS >= minRR;
    const coolOk = i - lastSigBar >= cool;
    const sigL = condL && !prevCondL && coolOk && dir !== 1, sigS = condS && !prevCondS && coolOk && dir !== -1;
    prevCondL = condL; prevCondS = condS;
    // 6) entrada (si habia una contraria, se cierra al cierre)
    if (sigL || sigS) {
      if (dir !== 0) close(i, "REV", b.c);
      dir = sigL ? 1 : -1; entry = b.c; sl = sigL ? slL : slS; tp = sigL ? tpL : tpS; risk = Math.abs(b.c - sl); eBar = i; lastSigBar = i;
    }
  }
  return { trades, vb, vs };
}

export function statsCE(B: Bar[], T: CETrade[], fee: number, fromT = 0) {
  const t = T.filter((x) => B[x.i].t >= fromT);
  const half = B[Math.floor(B.length / 2)].t; const net = (x: CETrade) => x.r - fee / x.riskPct;
  let R = 0, Rn = 0, R1 = 0, R2 = 0, w = 0, pk = 0, cum = 0, dd = 0, hold = 0;
  for (const x of t) { R += x.r; Rn += net(x); if (B[x.i].t < half) R1 += net(x); else R2 += net(x); if (x.r > 0) w++; cum += net(x); pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); hold += x.x - x.i; }
  const rp = t.map((x) => x.riskPct).sort((a, b) => a - b);
  return { ops: t.length, wr: t.length ? 100 * w / t.length : 0, R, Rn, R1, R2, dd, hold: t.length ? hold / t.length : 0, riskMed: rp.length ? rp[Math.floor(rp.length / 2)] : 0,
    rrMed: (() => { const a = t.filter((x) => x.res === "TP").map((x) => x.r).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : 0; })() };
}
