/* Paper trading del BTC Trading Agent: cartera simulada que opera sola con
   las señales de convicción del agente (las mismas que se alertan por
   Telegram). No toca dinero real: mantiene data/trades.json con el balance,
   las posiciones y la curva de equity, y el dashboard lo pinta.
   Comisión 0.1% por lado (taker de Binance), aplicada al cerrar. */
'use strict';

const START_BALANCE = 10000;   // USDT virtuales
const STAKE_FRACTION = 0.10;   // fracción del balance por operación
const FEE = 0.001;             // 0.1% por lado
const MAX_EQUITY_POINTS = 3000; // ~2 meses de puntos cada 30 min
const MAX_CLOSED = 200;         // historial de cerradas en el JSON

function init(){
  return {
    start_balance: START_BALANCE, balance: START_BALANCE,
    stats: {closed: 0, wins: 0, pnl_total: 0},
    open: [], closed: [], equity: [], updated_at: null,
  };
}

const r2 = n => Math.round(n*100)/100;

function grossPnl(pos, price){
  const ret = pos.type==='BUY' ? price/pos.entry - 1 : 1 - price/pos.entry;
  return pos.stake * ret;
}
function netPnl(pos, price){ return grossPnl(pos, price) - 2*FEE*pos.stake; }

function closePos(ledger, pos, exit, exitTime, reason){
  const pnl = r2(netPnl(pos, exit));
  ledger.balance = r2(ledger.balance + pos.stake + pnl);
  ledger.open = ledger.open.filter(p => p.id !== pos.id);
  const done = {...pos, exit: r2(exit), exit_time: exitTime, pnl, reason};
  delete done.checked;
  ledger.closed.push(done);
  if(ledger.closed.length > MAX_CLOSED) ledger.closed.splice(0, ledger.closed.length - MAX_CLOSED);
  ledger.stats.closed++;
  if(pnl > 0) ledger.stats.wins++;
  ledger.stats.pnl_total = r2(ledger.stats.pnl_total + pnl);
  return done;
}

/* Resuelve TP/SL de las posiciones abiertas de un timeframe con las velas
   cerradas nuevas. SL se comprueba primero dentro de la misma vela, igual
   que el backtest: si una vela toca ambos, cuenta como pérdida. */
function settle(ledger, tf, candles){
  const events = [];
  for(const pos of [...ledger.open]){
    if(pos.tf !== tf) continue;
    for(const c of candles){
      if(c.time <= pos.time || c.time <= (pos.checked||0)) continue;
      let exit = null, reason = null;
      if(pos.type==='BUY'){
        if(c.low  <= pos.sl){ exit = pos.sl; reason = 'sl'; }
        else if(c.high >= pos.tp){ exit = pos.tp; reason = 'tp'; }
      } else {
        if(c.high >= pos.sl){ exit = pos.sl; reason = 'sl'; }
        else if(c.low  <= pos.tp){ exit = pos.tp; reason = 'tp'; }
      }
      if(exit){ events.push({...closePos(ledger, pos, exit, c.time, reason), event:'close'}); break; }
      pos.checked = c.time;
    }
  }
  return events;
}

/* Abre posiciones con las señales de convicción nuevas. Una posición por
   timeframe: señal contraria cierra la actual al precio de la señal (flip)
   y abre la nueva; señal en la misma dirección se ignora. */
function trade(ledger, tf, sigs, tpPct, slPct){
  const events = [];
  for(const s of sigs){
    const cur = ledger.open.find(p => p.tf === tf);
    if(cur){
      if(cur.type === s.type) continue;
      events.push({...closePos(ledger, cur, s.price, s.time, 'flip'), event:'close'});
    }
    const stake = r2(ledger.balance * STAKE_FRACTION);
    if(stake < 10) continue; // cartera agotada: no se abre más
    const dir = s.type==='BUY' ? 1 : -1;
    const pos = {
      id: `${tf}-${s.time}-${s.type}`, tf, type: s.type,
      time: s.time, entry: s.price, stake,
      tp: r2(s.price * (1 + dir*tpPct)),
      sl: r2(s.price * (1 - dir*slPct)),
      kind: s.kind, prob: s.prob ?? null,
    };
    ledger.balance = r2(ledger.balance - stake);
    ledger.open.push(pos);
    events.push({...pos, event:'open'});
  }
  return events;
}

/* Valora la cartera a precio de mercado y añade un punto a la curva. */
function mark(ledger, prices, nowSec){
  let eq = ledger.balance;
  for(const p of ledger.open) eq += p.stake + grossPnl(p, prices[p.tf] ?? p.entry);
  eq = r2(eq);
  ledger.equity.push({t: nowSec, e: eq});
  if(ledger.equity.length > MAX_EQUITY_POINTS)
    ledger.equity.splice(0, ledger.equity.length - MAX_EQUITY_POINTS);
  ledger.updated_at = new Date(nowSec*1000).toISOString();
  return eq;
}

module.exports = {init, settle, trade, mark, grossPnl, netPnl,
                  START_BALANCE, STAKE_FRACTION, FEE};
