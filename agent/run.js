#!/usr/bin/env node
/* Analizador autónomo del BTC Trading Agent (GitHub Actions, cada 30 min).
   - Descarga 30 días de velas 1h y 4h de Binance (espejo público de datos).
   - Calcula señales (cruces EMA + rupturas de consolidación) con lib/agent-core.
   - Puntúa cada señal con el modelo ML (data/model.json) si existe.
   - Escribe data/signals.json (lo lee el dashboard) y, si hay señal nueva
     desde la última ejecución, la envía a Telegram (secrets del repo).
   Sin dependencias: Node 18+ (fetch global). */
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('../lib/agent-core.js');
const paper = require('./paper.js');
const fundamental = require('./fundamental.js');

const HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const SYMBOL = 'BTCUSDT';
// Solo se alertan/operan señales de convicción: probabilidad ML >= listón.
// El listón viaja en model.json (auto-calibrado en cada reentrenamiento sobre
// el tramo de test walk-forward: el más laxo con precisión >= base + 3pts);
// MIN_PROB queda como respaldo si el modelo aún no trae umbral. Sin modelo,
// se operan solo rupturas con volumen alto.
const MIN_PROB = 64;
// Ventana de frescura por timeframe (en velas): solo se opera lo reciente.
// Dimensionada con datos: el hueco máximo medido entre pasadas de Actions
// fue de 285 min (el 09/07 una señal válida del 65.3% se perdió con la
// ventana de 3 velas). 5 velas en 1h cubre el peor hueco observado; la
// entrada tardía se paga al precio de ejecución real, así que el coste del
// retraso queda medido en signal_price vs entry.
const FRESH_CANDLES = {'1h': 5, '4h': 2};
const TFS = ['1h', '4h'];
const DATA = path.join(__dirname, '..', 'data');
const OUT = path.join(DATA, 'signals.json');
const TRADES = path.join(DATA, 'trades.json');
const TRADES_B = path.join(DATA, 'trades-b.json');
// Registro persistente de señales (operadas y descartadas) con su prob:
// materia prima para recalibrar MIN_PROB con datos vivos. Cap 500 entradas.
const SIGLOG = path.join(DATA, 'signals-log.json');
const FUND = path.join(DATA, 'fundamental.json');
// Cartera B (experimento A/B): mismas entradas que la A, salidas distintas.
// En 1h prueba TP/SL simétrico 2%/2% — en el backtest anual deja más margen
// entre el acierto real y el umbral de equilibrio que el 1.2%/2% actual.
// En 4h mantiene el perfil actual (ya era el mejor del grid). No alerta por
// Telegram: compite en silencio y el dashboard compara las dos curvas.
const PROFILE_B = {
  '1h': {tp: 0.020, sl: 0.020},
  '4h': {tp: core.TF['4h'].tp, sl: core.TF['4h'].sl},
};
// Cartera C ("rupturas con recorrido"): deja correr al ganador con TP largo
// y SL corto. Backtest anual con costes: 1h solo rupturas 3%/1.5% -> +1.43
// USD (47% win vs 39% de equilibrio); 4h todas las señales 4%/2% -> +1.74.
// Gana pocas veces pero grande: rachas de pérdidas más largas son normales.
const TRADES_C = path.join(DATA, 'trades-c.json');
const PROFILE_C = {
  '1h': {tp: 0.030, sl: 0.015, solo: 'break'},
  '4h': {tp: 0.040, sl: 0.020},
};

async function fetchCandles(tf){
  const {binance, secs, count} = core.TF[tf];
  const end = Date.now();
  let cursor = end - count*secs*1000;
  const out = [];
  while(cursor < end){
    let batch = null, lastErr = null;
    for(const host of HOSTS){
      const url = `${host}/api/v3/klines?symbol=${SYMBOL}&interval=${binance}&startTime=${cursor}&limit=1000`;
      try{
        const res = await fetch(url, {headers:{'User-Agent':'btc-trading-agent/1.0'}});
        if(!res.ok) throw new Error(`${host} ${res.status}`);
        batch = await res.json();
        break;
      }catch(e){ lastErr = e; }
    }
    if(!batch) throw lastErr;
    if(!batch.length) break;
    for(const r of batch) out.push({time:Math.floor(r[0]/1000), open:+r[1], high:+r[2], low:+r[3], close:+r[4], volume:+r[5]});
    if(batch.length < 1000) break;
    cursor = batch[batch.length-1][0] + secs*1000;
  }
  return out;
}

async function telegram(text){
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if(!token || !chat){ console.error('telegram: secrets no configurados, alerta omitida'); return; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chat_id: chat, text, parse_mode:'HTML'}),
  });
  if(!res.ok) console.error('telegram:', res.status, await res.text());
}

function loadJSON(p){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch(e){ return null; } }
const fmt$ = n => '$'+n.toLocaleString('es-ES',{maximumFractionDigits:0});

async function main(){
  const model = loadJSON(path.join(DATA, 'model.json'));
  const prev = loadJSON(OUT);
  const ledger = loadJSON(TRADES) || paper.init();
  const ledgerB = loadJSON(TRADES_B) || paper.init();
  const ledgerC = loadJSON(TRADES_C) || paper.init();
  const siglog = loadJSON(SIGLOG) || [];
  const siglogStart = siglog.length;
  const nowSec = Math.floor(Date.now()/1000);
  const lastPrice = {};
  const state = {generated_at:new Date().toISOString(), symbol:SYMBOL, tfs:{}};
  const newAlerts = [];

  for(const tf of TFS){
    // la última vela está sin cerrar: se descarta para que las señales sean firmes
    const candles = (await fetchCandles(tf)).slice(0, -1);
    if(candles.length < 60) throw new Error(`histórico insuficiente para ${tf}: ${candles.length} velas`);
    const an = core.computeSignals(candles);
    const bt = core.backtest(candles, an.sigs, core.TF[tf].tp, core.TF[tf].sl);
    const mtf = model && model.tfs && model.tfs[tf];
    const rowFn = mtf ? core.featurePrep(candles) : null;
    const score = s => {
      if(!rowFn) return null;
      const x = rowFn(s.i, s.type==='BUY' ? 1 : -1);
      return x ? Math.round(core.scoreProb(mtf, x)*1000)/10 : null;
    };
    const lastZone = an.zones[an.zones.length-1];
    const active = lastZone && lastZone.active ? lastZone : null;
    const recent = an.sigs.slice(-5).map(s=>({
      time:s.time, kind:s.kind, type:s.type, price:s.price,
      strong:s.strong||false, zone:s.zone||null, outcome:s.outcome, prob:score(s),
    }));
    state.tfs[tf] = {
      price: candles[candles.length-1].close,
      candles: candles.length,
      state: active ? 'range' : (recent.length ? recent[recent.length-1].type : 'neutral'),
      zone: active ? {top:active.top, bottom:active.bottom} : null,
      winRate: bt.winRate!=null ? Math.round(bt.winRate*10)/10 : null,
      byKind: bt.byKind, signals: recent,
    };
    // señal nueva = posterior a la última vista en la ejecución anterior
    const prevLast = prev && prev.tfs && prev.tfs[tf] && prev.tfs[tf].signals.length
      ? prev.tfs[tf].signals[prev.tfs[tf].signals.length-1].time : 0;
    const liston = (mtf && mtf.thr) || MIN_PROB;
    const conviction = s => s.prob!=null
      ? s.prob>=liston
      : (s.kind==='break' && s.strong);
    const fresh = [];
    for(const s of recent){
      if(s.time <= prevLast) continue;
      const esFresca = s.time >= nowSec - FRESH_CANDLES[tf]*core.TF[tf].secs;
      // conviction = aprobó el examen ML; operada = además llegó a tiempo
      siglog.push({tf, time:s.time, kind:s.kind, type:s.type, price:s.price,
                   prob:s.prob, conviction: conviction(s), operada: conviction(s) && esFresca});
      if(!conviction(s)){
        // aviso informativo si roza el listón (a menos de 2 puntos):
        // visibilidad de que el agente examina y descarta, sin abrir posiciones
        if(s.prob!=null && s.prob>=liston-2 && esFresca){
          newAlerts.push(`🔕 Señal descartada — BTC/USDT ${tf}: ${s.kind==='break'?'ruptura':'cruce'} ${s.type==='BUY'?'alcista':'bajista'} a ${fmt$(s.price)} con nota <b>${s.prob}%</b> (listón ${liston}%). Sin operación.`);
        }
        continue;
      }
      if(!esFresca){
        // señal válida que llegó tarde por la cadencia de Actions: visible
        // en Telegram para que ninguna pérdida de oportunidad sea silenciosa
        newAlerts.push(`⏰ Señal válida perdida por cadencia — BTC/USDT ${tf}: ${s.kind==='break'?'ruptura':'cruce'} ${s.type==='BUY'?'alcista':'bajista'} con nota <b>${s.prob}%</b> nació hace ${Math.round((nowSec-s.time)/3600*10)/10}h y ya no es operable.`);
        continue;
      }
      fresh.push(s);
      const buy = s.type==='BUY';
      const head = s.kind==='break'
        ? `${buy?'🟢':'🔴'} <b>RUPTURA ${buy?'ALCISTA':'BAJISTA'}</b>${s.strong?' (vol. alto)':''}`
        : `${buy?'🟢':'🔴'} <b>${buy?'COMPRA':'VENTA'}</b>`;
      const zone = s.zone ? `\nRango: ${fmt$(s.zone.bottom)}–${fmt$(s.zone.top)}` : '';
      const prob = s.prob!=null ? `\nProb. ML (TP antes que SL): <b>${s.prob}%</b>` : '';
      newAlerts.push(`${head} — BTC/USDT ${tf}\nPrecio: ${fmt$(s.price)}${zone}${prob}`);
    }
    // paper trading: cerrar por TP/SL con las velas nuevas y abrir con las señales frescas
    lastPrice[tf] = candles[candles.length-1].close;
    // carteras B y C: mismas señales, salidas alternativas, sin alertas
    paper.settle(ledgerB, tf, candles);
    paper.trade(ledgerB, tf, fresh, PROFILE_B[tf].tp, PROFILE_B[tf].sl, lastPrice[tf]);
    paper.settle(ledgerC, tf, candles);
    const freshC = PROFILE_C[tf].solo ? fresh.filter(s => s.kind === PROFILE_C[tf].solo) : fresh;
    paper.trade(ledgerC, tf, freshC, PROFILE_C[tf].tp, PROFILE_C[tf].sl, lastPrice[tf]);
    const events = [
      ...paper.settle(ledger, tf, candles),
      ...paper.trade(ledger, tf, fresh, core.TF[tf].tp, core.TF[tf].sl, lastPrice[tf]),
    ];
    for(const ev of events){
      const dirTxt = ev.type==='BUY' ? 'COMPRA' : 'VENTA';
      if(ev.event==='open'){
        newAlerts.push(`📜 <b>PAPER</b>: abierta ${dirTxt} ${tf} a ${fmt$(ev.entry)} (${ev.stake} USDT`+
          (ev.prob!=null ? `, prob ${ev.prob}%` : '') + `)\nTP ${fmt$(ev.tp)} · SL ${fmt$(ev.sl)}`);
      } else {
        const sign = ev.pnl>=0 ? '+' : '';
        const motivo = {tp:'take profit', sl:'stop loss', flip:'señal contraria'}[ev.reason] || ev.reason;
        newAlerts.push(`📜 <b>PAPER</b>: cerrada ${dirTxt} ${tf} a ${fmt$(ev.exit)} por ${motivo}\n`+
          `Resultado: <b>${sign}${ev.pnl} USDT</b> · balance ${ledger.balance.toLocaleString('es-ES')} USDT`);
      }
    }
  }

  // contexto fundamental (modo sombra): se publica, acompaña y se registra,
  // pero no interviene en la decisión de operar
  const fund = await fundamental.snapshot(lastPrice['1h'] || lastPrice['4h']);
  for(let i = siglogStart; i < siglog.length; i++){
    siglog[i].fund = fund.composite ? {
      score: fund.composite.score,
      fng: fund.fng && fund.fng.value,
      premium: fund.premium && fund.premium.premiumPct,
    } : null;
  }

  const equity = paper.mark(ledger, lastPrice, nowSec);
  const equityB = paper.mark(ledgerB, lastPrice, nowSec);
  const equityC = paper.mark(ledgerC, lastPrice, nowSec);
  fs.mkdirSync(DATA, {recursive:true});
  fs.writeFileSync(OUT, JSON.stringify(state, null, 1));
  fs.writeFileSync(TRADES, JSON.stringify(ledger, null, 1));
  fs.writeFileSync(TRADES_B, JSON.stringify(ledgerB, null, 1));
  fs.writeFileSync(TRADES_C, JSON.stringify(ledgerC, null, 1));
  fs.writeFileSync(FUND, JSON.stringify(fund, null, 1));
  siglog.splice(0, Math.max(0, siglog.length - 500));
  fs.writeFileSync(SIGLOG, JSON.stringify(siglog, null, 1));
  console.error(`signals.json actualizado · ${newAlerts.length} alertas nuevas · paper A ${equity} / B ${equityB} / C ${equityC} USDT · fundamental ${fund.composite ? fund.composite.label : 'n/d'}`);
  const ctx = fundamental.resumen(fund);
  for(const msg of newAlerts) await telegram(msg + ctx + '\n\n<i>BTC Trading Agent · análisis educativo, no es asesoramiento financiero</i>');
}

main().catch(e=>{ console.error(e); process.exit(1); });
