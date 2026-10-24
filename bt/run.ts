// Ejecuta variantes del backtest y escribe el resultado como anotaciones (::notice::).
// mode=m7 (Rango 9h, como /variants) o mode=ce (Confluence Engine del CAD++). tf=5m|15m|1h
import { loadBars, simulate, DEFAULTS, type Bar } from "./index.ts";
import { simCE, simCEFull, statsCE, type CEOpt } from "./ce.ts";
import { coqueto, simCoq, type Coq } from "./coq.ts";
import { simKZ } from "./kz.ts";
import { simRule } from "./kz2.ts";

const f1 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(1);
const Q = (Bun.env.Q || "").split("||").map((x) => x.trim()).filter(Boolean);
for (const q of Q) {
  const u = new URLSearchParams(q);
  const symbols = (u.get("symbols") || "BTCUSDT").toUpperCase().split(",").filter(Boolean);
  const days = +(u.get("days") || 365); const tf = u.get("tf") || "5m"; const mode = u.get("mode") || "m7"; const tag = u.get("tag") || mode + "-" + tf;
  const data: { s: string; bars: Bar[] }[] = [];
  for (const s of symbols) { try { const { bars } = await loadBars(s, days, tf); data.push({ s, bars }); } catch (e: any) { console.log(`::notice::${tag} ERROR ${s} ${String(e.message || e)}`); } }
  console.log(`::notice::${tag} DATA ` + data.map((d) => `${d.s.replace("USDT", "")}:${d.bars.length}`).join(" "));
  const V = (u.get("v") || "base:").split("|").filter(Boolean).map((x) => { const [n, kv = ""] = x.split(":"); const o: Record<string, number> = {};
    for (const p of kv.split(",").filter(Boolean)) { const [k, v] = p.split("="); o[k] = +v; } return { n, o }; });
  if (mode === "kz2") {
    const VR = (u.get("v") || "").split("|").filter(Boolean).map((x) => { const [n, kv = ""] = x.split(":"); const o: Record<string, any> = {};
      for (const p of kv.split(",").filter(Boolean)) { const [k, v] = p.split("="); o[k] = isNaN(+v) ? v : +v; } return { n, o }; });
    for (const { n, o } of VR) {
      let ops = 0, w = 0, R = 0, R2 = 0, R10 = 0, a1 = 0, a2 = 0, pos = 0; const per: string[] = []; const rk: number[] = [];
      for (const d of data) { const T = simRule(d.bars, o as any); const half = d.bars[Math.floor(d.bars.length / 2)].t; let r0 = 0, r2 = 0;
        for (const x of T) { const n2 = x.r - 0.02 / x.riskPct; ops++; if (x.r > 0) w++; R += x.r; R2 += n2; R10 += x.r - 0.10 / x.riskPct; r0 += x.r; r2 += n2; if (d.bars[x.i].t < half) a1 += n2; else a2 += n2; rk.push(x.riskPct); }
        if (r2 > 0) pos++; per.push(`${d.s.replace("USDT", "")}:${f1(r2)}`); }
      rk.sort((p, q) => p - q);
      console.log(`::notice::${tag} ${n} ops=${ops} acierto=${ops ? (100 * w / ops).toFixed(1) : 0}% Rbruto=${f1(R)} Rneto002=${f1(R2)} Rneto010=${f1(R10)} mitades002=${f1(a1)}/${f1(a2)} pos002=${pos}/${data.length} riesgoMed%=${rk.length ? rk[rk.length >> 1].toFixed(2) : "-"} | neto002 ${per.join(" ")}`);
    }
  } else if (mode === "kz") {
    const st: Record<string, number> = {}; const per: Record<string, string[]> = {}; const agg: Record<string, { n: number; w: number; R: number; R2: number; R10: number; a1: number; a2: number; pos: number; rk: number[]; rr: number[] }> = {};
    for (const d of data) { const r = simKZ(d.bars); for (const [k, v] of Object.entries(r.st)) st[k] = (st[k] ?? 0) + v;
      const half = d.bars[Math.floor(d.bars.length / 2)].t;
      for (const [k, T] of Object.entries(r.trades)) { const g = (agg[k] ??= { n: 0, w: 0, R: 0, R2: 0, R10: 0, a1: 0, a2: 0, pos: 0, rk: [], rr: [] }); let r2 = 0, r0 = 0;
        for (const x of T) { const n2 = x.r - 0.02 / x.riskPct; g.n++; if (x.r > 0) g.w++; g.R += x.r; g.R2 += n2; g.R10 += x.r - 0.10 / x.riskPct; r2 += n2; r0 += x.r; if (d.bars[x.i].t < half) g.a1 += n2; else g.a2 += n2; g.rk.push(x.riskPct); g.rr.push(x.rrT); }
        if (r2 > 0) g.pos++; (per[k] ??= []).push(`${d.s.replace("USDT", "")}:${f1(r0)}/${f1(r2)}`); } }
    const pc = (a: number, b: number) => (b ? (100 * a / b).toFixed(0) : "-") + "%";
    console.log(`::notice::${tag} STATS dias=${st.cyc} | Londres toca max Asia ${pc(st.lonAH, st.cyc)} min ${pc(st.lonAL, st.cyc)} alguno ${pc(st.lonAny, st.cyc)} ambos ${pc(st.lonBoth, st.cyc)} | NY(9:30-16) toca max Londres ${pc(st.nyLH, st.days)} min ${pc(st.nyLL, st.days)} alguno ${pc(st.nyAny, st.days)} ambos ${pc(st.nyBoth, st.days)} | dia toca PDH o PDL ${pc(st.pdAny, st.pdN)}`);
    const med = (a: number[]) => { const x = [...a].sort((p, q) => p - q); return x.length ? x[x.length >> 1] : 0; };
    for (const [k, g] of Object.entries(agg)) console.log(`::notice::${tag} ${k} ops=${g.n} acierto=${g.n ? (100 * g.w / g.n).toFixed(1) : 0}% Rbruto=${f1(g.R)} Rneto002=${f1(g.R2)} Rneto010=${f1(g.R10)} mitades002=${f1(g.a1)}/${f1(g.a2)} pos002=${g.pos}/${data.length} riesgoMed%=${med(g.rk).toFixed(2)} RRobjMed=${med(g.rr).toFixed(1)} | bruto/neto002 ${per[k].join(" ")}`);
  } else if (mode === "coq") {
    const h1 = +(u.get("htf1") || 15) * 60000, h2 = +(u.get("htf2") || 60) * 60000;
    const qs = data.map((d) => coqueto(d.bars, h1, h2));
    for (const { n, o } of V) {
      let ops = 0, w = 0, R = 0, R2 = 0, R10 = 0, a1 = 0, a2 = 0, pos = 0; const per: string[] = []; const rk: string[] = [];
      data.forEach((d, k) => { const T = simCoq(d.bars, qs[k], o.v ?? 0, o.sl ?? 1.5, o.rr ?? 2); const half = d.bars[Math.floor(d.bars.length / 2)].t;
        let r0 = 0, r2 = 0, r10 = 0; const rp = T.map((x) => x.riskPct).sort((x, y) => x - y);
        for (const x of T) { r0 += x.r; r2 += x.r - 0.02 / x.riskPct; r10 += x.r - 0.10 / x.riskPct; if (x.r > 0) w++; if (d.bars[x.i].t < half) a1 += x.r - 0.02 / x.riskPct; else a2 += x.r - 0.02 / x.riskPct; }
        ops += T.length; R += r0; R2 += r2; R10 += r10; if (r2 > 0) pos++; per.push(`${d.s.replace("USDT", "")}:${f1(r0)}/${f1(r2)}`); rk.push(rp.length ? rp[Math.floor(rp.length / 2)].toFixed(2) : "-"); });
      console.log(`::notice::${tag} ${n} ops=${ops} acierto=${ops ? (100 * w / ops).toFixed(1) : 0}% Rbruto=${f1(R)} Rneto002=${f1(R2)} Rneto010=${f1(R10)} mitades002=${f1(a1)}/${f1(a2)} pos002=${pos}/${data.length} riesgoMed%=${rk.join(",")} | bruto/neto002 ${per.join(" ")}`);
    }
  } else if (mode === "ce") {
    for (const { n, o } of V) {
      let ops = 0, w = 0, R = 0, R2 = 0, R10 = 0, h1 = 0, h2 = 0, pos = 0, dd = 0, rOps = 0, rR = 0, rR10 = 0; const per: string[] = []; const risks: number[] = [];
      for (const d of data) {
        const T = simCE(d.bars, o as CEOpt);
        const a = statsCE(d.bars, T, 0), b = statsCE(d.bars, T, 0.02), c = statsCE(d.bars, T, 0.10);
        const recentFrom = d.bars[Math.max(0, d.bars.length - 5000)].t; const rc = statsCE(d.bars, T, 0, recentFrom), rc10 = statsCE(d.bars, T, 0.10, recentFrom);
        ops += a.ops; w += a.ops * a.wr / 100; R += a.R; R2 += b.Rn; R10 += c.Rn; h1 += c.R1; h2 += c.R2; dd = Math.max(dd, c.dd); if (c.Rn > 0) pos++; risks.push(a.riskMed);
        rOps += rc.ops; rR += rc.R; rR10 += rc10.Rn;
        per.push(`${d.s.replace("USDT", "")}:${f1(a.R)}/${f1(c.Rn)}`);
        if (n === V[0].n && d.s === "BTCUSDT") { const last = T.slice(-4).map((x) => { const p = new Date(d.bars[x.i].t + 7200000).toISOString().slice(5, 16).replace("T", " "); return `${p} ${x.d > 0 ? "L" : "S"} ${x.res} ${f1(x.r)}`; });
          console.log(`::notice::${tag} BTC ultimas: ${last.join(" | ")}`); }
      }
      console.log(`::notice::${tag} ${n} ops=${ops} acierto=${ops ? (100 * w / ops).toFixed(1) : 0}% Rbruto=${f1(R)} Rneto002=${f1(R2)} Rneto010=${f1(R10)} mitades010=${f1(h1)}/${f1(h2)} dd=${dd.toFixed(1)} pos010=${pos}/${data.length} riesgoMed%=${risks.map((x) => x.toFixed(2)).join(",")} | ult5000velas: ops=${rOps} Rbruto=${f1(rR)} Rneto010=${f1(rR10)} | bruto/neto010 ${per.join(" ")}`);
    }
  } else {
    const ceCache: Record<string, ReturnType<typeof simCEFull>> = {};
    const cqCache: Record<string, Coq> = {};
    const base: Record<string, number> = {};
    for (const k of Object.keys(DEFAULTS)) { const v = u.get(k); if (v !== null && v !== "" && !isNaN(+v)) base[k] = +v; }
    for (const { n, o } of V) {
      let ops = 0, tp = 0, R = 0, R1 = 0, R2 = 0, dd = 0, pos = 0; const per: string[] = [];
      for (const d of data) { let ext: ((i: number, dd: number) => boolean) | undefined;
        if (o.cq) { const q: Coq = (cqCache[d.s] ??= coqueto(d.bars)); const B = d.bars; const m = o.cq, kR = o.cqK ?? 1;
          ext = (i, dd) => { const c = B[i].c; const tpD = base.m7slP > 0 ? base.m7tpP : c * (base.rgTP ?? DEFAULTS.rgTP) / 100;
            if (m === 1) return q.tH1[i] === dd && q.tH2[i] === dd;
            if (m === 2) return q.tH1[i] !== -dd && q.tH2[i] !== -dd;
            if (m === 3) return q.bias[i] === dd;
            if (m === 4) return q.bias[i] !== -dd;
            if (m === 5) { const z = dd === 1 ? q.resPx[i] - c : c - q.supPx[i]; return !isFinite(z) || z >= kR * tpD; }
            if (m === 6) return q.tL[i] === dd;
            return true; }; }
        if (o.ceV) { const { vb, vs } = (ceCache[d.s] ??= simCEFull(d.bars)); const k = o.ceV; ext = (i, dd) => (dd === 1 ? vb[i] > vs[i] && vb[i] >= k : vs[i] > vb[i] && vs[i] >= k); }
        const r = simulate(d.bars, { ...base, ...o }, ext)[6]; ops += r.ops; tp += r.tp; R += r.Rneto; R1 += r.Rmitad1; R2 += r.Rmitad2; dd = Math.max(dd, r.maxDD_R); if (r.Rneto > 0) pos++; per.push(`${d.s.replace("USDT", "")}:${r.Rneto.toFixed(1)}`); }
      console.log(`::notice::${tag} ${n} ops=${ops} tp=${ops ? (100 * tp / ops).toFixed(1) : 0}% R=${R.toFixed(1)} h1=${R1.toFixed(1)} h2=${R2.toFixed(1)} dd=${dd.toFixed(1)} pos=${pos}/${data.length} | ${per.join(" ")}`);
    }
  }
}
