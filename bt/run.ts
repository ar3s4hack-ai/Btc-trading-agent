// Ejecuta variantes del backtest (misma logica que /variants) y escribe el resultado en el log.
import { loadBars, simulate, DEFAULTS, type Bar } from "./index.ts";

const Q = (Bun.env.Q || "").split("||").map((x) => x.trim()).filter(Boolean);
for (const q of Q) {
  const u = new URLSearchParams(q);
  const symbols = (u.get("symbols") || "BTCUSDT").toUpperCase().split(",").filter(Boolean);
  const days = +(u.get("days") || 365);
  const base: Record<string, number> = {};
  for (const k of Object.keys(DEFAULTS)) { const v = u.get(k); if (v !== null && v !== "" && !isNaN(+v)) base[k] = +v; }
  const V = (u.get("v") || "base:").split("|").filter(Boolean).map((x) => { const [n, kv = ""] = x.split(":"); const o: Record<string, number> = {};
    for (const p of kv.split(",").filter(Boolean)) { const [k, v] = p.split("="); if (k in DEFAULTS) o[k] = +v; } return { n, o }; });
  const data: { s: string; bars: Bar[]; src: string }[] = [];
  for (const s of symbols) { try { const { bars, src } = await loadBars(s, days, "5m"); data.push({ s, bars, src }); } catch (e: any) { console.log("ERROR", s, String(e.message || e)); } }
  console.log("DATA", data.map((d) => `${d.s}:${d.bars.length}:${d.src}`).join(" "));
  for (const { n, o } of V) {
    let ops = 0, tp = 0, R = 0, R1 = 0, R2 = 0, dd = 0, pos = 0; const per: string[] = [];
    for (const d of data) { const r = simulate(d.bars, { ...base, ...o })[6]; ops += r.ops; tp += r.tp; R += r.Rneto; R1 += r.Rmitad1; R2 += r.Rmitad2; dd = Math.max(dd, r.maxDD_R); if (r.Rneto > 0) pos++; per.push(`${d.s.replace("USDT", "")}:${r.Rneto.toFixed(1)}`); }
    console.log(`RES ${n.padEnd(8)} ops=${ops} tp=${ops ? (100 * tp / ops).toFixed(1) : 0}% R=${R.toFixed(1)} h1=${R1.toFixed(1)} h2=${R2.toFixed(1)} dd=${dd.toFixed(1)} pos=${pos}/${data.length} | ${per.join(" ")}`);
  }
}
