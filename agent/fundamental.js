/* Contexto fundamental del BTC Trading Agent — MODO SOMBRA.
   Recoge tres factores de fuentes públicas sin clave y los publica en
   data/fundamental.json para el dashboard, las alertas y el registro de
   señales. NO decide operaciones: primero acumulamos histórico junto a cada
   señal (signals-log.json) y solo si demuestra valor predictivo se promoverá
   a feature del modelo (ver research/IDEAS.md).

   Factores y lectura (documentada, discutible y por eso registrada):
   - Miedo/Codicia (alternative.me): lectura contraria — miedo extremo suele
     ser mejor momento de compra que la codicia extrema.
   - Prima de Coinbase vs Binance: prima positiva = demanda spot institucional
     y minorista de EE. UU.; descuento = presión vendedora.
   - Red (mempool.space): ajuste de dificultad al alza = mineros invirtiendo,
     salud de red; señal lenta, peso menor. */
'use strict';

async function getJSON(url, timeoutMs = 15000){
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try{
    const res = await fetch(url, {headers: {'User-Agent': 'btc-trading-agent/1.0'}, signal: ctl.signal});
    if(!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function fearGreed(){
  const d = await getJSON('https://api.alternative.me/fng/?limit=2');
  const [hoy, ayer] = d.data;
  return {value: +hoy.value, label: hoy.value_classification, prev: ayer ? +ayer.value : null};
}

async function coinbasePremium(binancePrice){
  const t = await getJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
  const cb = +t.price;
  if(!(cb > 0) || !(binancePrice > 0)) throw new Error('precio inválido para la prima');
  return {coinbase: cb, premiumPct: Math.round((cb/binancePrice - 1)*10000)/100};
}

async function red(){
  const da = await getJSON('https://mempool.space/api/v1/difficulty-adjustment');
  const fees = await getJSON('https://mempool.space/api/v1/fees/recommended');
  return {difficultyChangePct: Math.round(da.difficultyChange*100)/100, fastestFee: fees.fastestFee};
}

/* Compuesto -100..+100 con pesos fijos y saturación:
   40% sentimiento contrario, 40% prima Coinbase (satura a ±0,25%),
   20% dificultad (satura a ±10%). Umbral de etiqueta: ±30. */
function componer(f){
  const parts = [];
  if(f.fng) parts.push({w: 0.4, s: Math.max(-100, Math.min(100, (50 - f.fng.value)*2))});
  if(f.premium) parts.push({w: 0.4, s: Math.max(-100, Math.min(100, f.premium.premiumPct*400))});
  if(f.red) parts.push({w: 0.2, s: Math.max(-100, Math.min(100, f.red.difficultyChangePct*10))});
  if(!parts.length) return null;
  const tw = parts.reduce((t,p) => t+p.w, 0);
  const score = Math.round(parts.reduce((t,p) => t + p.w*p.s, 0) / tw);
  const label = score >= 30 ? 'alcista' : (score <= -30 ? 'bajista' : 'neutral');
  return {score, label};
}

/* Cada factor es independiente: si una fuente falla, se sigue con el resto. */
async function snapshot(binancePrice){
  const out = {generated_at: new Date().toISOString(), fng: null, premium: null, red: null, composite: null};
  const tareas = [
    ['fng', () => fearGreed()],
    ['premium', () => coinbasePremium(binancePrice)],
    ['red', () => red()],
  ];
  for(const [k, fn] of tareas){
    try{ out[k] = await fn(); }
    catch(e){ console.error('fundamental:', k, 'no disponible:', String(e.message || e).slice(0, 120)); }
  }
  out.composite = componer(out);
  return out;
}

/* Línea corta para las alertas de Telegram. */
function resumen(f){
  if(!f || !f.composite) return '';
  const iconos = {alcista: '🟢', neutral: '⚪', bajista: '🔴'};
  const partes = [`${iconos[f.composite.label]} ${f.composite.label} (${f.composite.score})`];
  if(f.fng) partes.push(`F&G ${f.fng.value}`);
  if(f.premium) partes.push(`prima CB ${f.premium.premiumPct >= 0 ? '+' : ''}${f.premium.premiumPct}%`);
  return `\nContexto fundamental: ${partes.join(' · ')}`;
}

module.exports = {snapshot, resumen, componer};
