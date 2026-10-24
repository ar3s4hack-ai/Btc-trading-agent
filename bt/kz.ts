// Killzones ICT (horario Nueva York, como el indicador TFO): estadisticas de toques y modelos de "barrido y giro".
// Ciclo = de 20:00 NY (inicio de Asia) a 16:00 NY del dia siguiente. Solo lunes-viernes (dia de la sesion de Londres).
import type { Bar } from "./index.ts";

const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const offCache = new Map<number, number>();
function nyOff(t: number) { // minutos de diferencia NY - UTC
  const h = Math.floor(t / 3600000); let o = offCache.get(h);
  if (o === undefined) { const p: Record<string, string> = {}; for (const x of fmt.formatToParts(new Date(h * 3600000))) p[x.type] = x.value;
    o = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - h * 3600000) / 60000); offCache.set(h, o); }
  return o;
}
// minutos desde las 20:00 NY: Asia [0,240) Londres [360,540) NY manana [810,900) NY tarde [1050,1200) cierre 1200 (16:00)
const W = { asia: [0, 240], lon: [360, 540], nyam: [810, 900], ny: [810, 1200] } as const;

export type KzTrade = { i: number; d: number; r: number; riskPct: number; res: string; rrT: number };
export function simKZ(B: Bar[]) {
  const N = B.length; const barMin = N > 1 ? (B[1].t - B[0].t) / 60000 : 5;
  const atr: number[] = []; { let a = NaN, s = 0; for (let i = 0; i < N; i++) { const b = B[i]; const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l; if (i < 14) { s += tr; if (i === 13) a = s / 14; } else a = (a * 13 + tr) / 14; atr.push(a); } }
  const st = { cyc: 0, lonAH: 0, lonAL: 0, lonAny: 0, lonBoth: 0, nyLH: 0, nyLL: 0, nyAny: 0, nyBoth: 0, days: 0, pdAny: 0, pdN: 0 };
  // modelos: A = Londres barre Asia; B = NY manana barre Londres. tp: "piv" (nivel contrario, RR>=1) o "2R"
  const models = [{ k: "A-piv", src: "asia", win: W.lon, tp: "piv" }, { k: "A-2R", src: "asia", win: W.lon, tp: "2R" }, { k: "B-piv", src: "lon", win: W.nyam, tp: "piv" }, { k: "B-2R", src: "lon", win: W.nyam, tp: "2R" }] as const;
  const trades: Record<string, KzTrade[]> = Object.fromEntries(models.map((m) => [m.k, []]));
  type Pos = { d: number; e: number; sl: number; tp: number; risk: number; i: number; rrT: number } | null;
  const pos: Record<string, Pos> = {}; const done: Record<string, boolean> = {}; const sw: Record<string, { up: boolean; dn: boolean; ue: number; de: number }> = {};
  let cyc = -1, wk = false, aH = -Infinity, aL = Infinity, lH = -Infinity, lL = Infinity, nH = -Infinity, nL = Infinity;
  let uDay = -1, dH = -Infinity, dL = Infinity, pH = NaN, pL = NaN;
  const closeT = (k: string, i: number, res: string, xp: number) => { const p = pos[k]!; const r = res === "TP" ? Math.abs(p.tp - p.e) / p.risk : res === "SL" ? -1 : p.d * (xp - p.e) / p.risk;
    trades[k].push({ i: p.i, d: p.d, r, riskPct: 100 * p.risk / p.e, res, rrT: p.rrT }); pos[k] = null; };
  const endCycle = () => { if (cyc < 0 || !wk || !isFinite(aH) || !isFinite(lH)) return; st.cyc++;
    const a1 = lH > aH, a2 = lL < aL; if (a1) st.lonAH++; if (a2) st.lonAL++; if (a1 || a2) st.lonAny++; if (a1 && a2) st.lonBoth++;
    if (isFinite(nH)) { const b1 = nH > lH, b2 = nL < lL; if (b1) st.nyLH++; if (b2) st.nyLL++; if (b1 || b2) st.nyAny++; if (b1 && b2) st.nyBoth++; st.days++; } };
  for (let i = 0; i < N; i++) {
    const b = B[i]; const s = b.t + (nyOff(b.t) + 240) * 60000; const c = Math.floor(s / 86400000); const m = Math.floor((s % 86400000) / 60000);
    // dia UTC para PDH/PDL: % de dias (lun-vie) que tocan el maximo o el minimo de ayer
    const ud = Math.floor(b.t / 86400000);
    if (ud !== uDay) { if (uDay >= 0) { const wd = new Date(uDay * 86400000).getUTCDay(); if (isFinite(pH) && wd >= 1 && wd <= 5) { st.pdN++; if (dH > pH || dL < pL) st.pdAny++; } pH = dH; pL = dL; } uDay = ud; dH = -Infinity; dL = Infinity; }
    dH = Math.max(dH, b.h); dL = Math.min(dL, b.l);
    if (c !== cyc) { endCycle(); cyc = c; const wd = new Date(c * 86400000).getUTCDay(); wk = wd >= 1 && wd <= 5; aH = -Infinity; aL = Infinity; lH = -Infinity; lL = Infinity; nH = -Infinity; nL = Infinity;
      for (const md of models) { done[md.k] = false; sw[md.k] = { up: false, dn: false, ue: -Infinity, de: Infinity }; } }
    // gestion de operaciones abiertas (desde la vela siguiente a la entrada) y cierre a las 16:00 NY
    for (const md of models) { const p = pos[md.k]; if (!p || i <= p.i) continue;
      const hs = p.d === 1 ? b.l <= p.sl : b.h >= p.sl, ht = p.d === 1 ? b.h >= p.tp : b.l <= p.tp;
      if (hs) closeT(md.k, i, "SL", p.sl); else if (ht) closeT(md.k, i, "TP", p.tp); else if (m + barMin >= 1200 || m < 240) closeT(md.k, i, "TIME", b.c); }
    if (m >= W.asia[0] && m < W.asia[1]) { aH = Math.max(aH, b.h); aL = Math.min(aL, b.l); }
    if (m >= W.lon[0] && m < W.lon[1]) { lH = Math.max(lH, b.h); lL = Math.min(lL, b.l); }
    if (m >= W.ny[0] && m < W.ny[1]) { nH = Math.max(nH, b.h); nL = Math.min(nL, b.l); }
    if (!wk) continue;
    for (const md of models) {
      if (done[md.k] || pos[md.k] || m < md.win[0] || m >= md.win[1]) continue;
      const rH = md.src === "asia" ? aH : lH, rL = md.src === "asia" ? aL : lL; if (!isFinite(rH) || !isFinite(atr[i])) continue;
      if (md.src === "lon" && m < W.lon[1]) continue;
      const q = sw[md.k];
      if (b.h > rH) { q.up = true; q.ue = Math.max(q.ue, b.h); } else if (q.up) q.ue = Math.max(q.ue, b.h);
      if (b.l < rL) { q.dn = true; q.de = Math.min(q.de, b.l); } else if (q.dn) q.de = Math.min(q.de, b.l);
      const inside = b.c < rH && b.c > rL;
      for (const d of [-1, 1]) {
        if (!inside || (d === -1 ? !q.up : !q.dn)) continue;
        const e = b.c, sl = d === -1 ? q.ue + 0.1 * atr[i] : q.de - 0.1 * atr[i], risk = Math.abs(e - sl);
        const tp = md.tp === "piv" ? (d === -1 ? rL : rH) : e + d * 2 * risk; const rrT = Math.abs(tp - e) / risk;
        if (md.tp === "piv" && rrT < 1) continue;
        pos[md.k] = { d, e, sl, tp, risk, i, rrT }; done[md.k] = true; break;
      }
    }
  }
  endCycle();
  return { st, trades };
}
