/* Paper trading del BTC Trading Agent: cartera simulada que opera sola con
   las señales de convicción del agente (las mismas que se alertan por
   Telegram). No toca dinero real: mantiene data/trades.json con el balance,
   las posiciones y la curva de equity, y el dashboard lo pinta.
   Comisión 0.1% por lado (taker de Binance), aplicada al cerrar. */
'use strict';

const START_BALANCE = 200;     // USDT virtuales (espejo de una cartera real pequeña)
const STAKE_FRACTION = 0.10;   // fracción del balance por operación (~20 USDT)
const FEE = 0.001;             // 0.1% por lado
const SLIPPAGE = 0.0003;       // 0.03% por lado: en vivo se pierde parte del edge
                               // del backtest (research/2026-07-04.md §3)
const MAX_DRAWDOWN = 0.10;     // kill-switch: sin aperturas nuevas si la cartera
                               // cae >10% desde su máximo histórico
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
function netPnl(pos, price){ return grossPnl(pos, price) - 2*(FEE + SLIPPAGE)*pos.stake; }

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
   timeframe: señal contraria cierra la actual (flip) y abre la nueva; señal
   en la misma dirección se ignora. execPrice es el precio del momento de la
   pasada: en real solo puedes operar al precio de ahora, no al del cierre de
   la vela de la señal — se guarda signal_price aparte para auditoría. */
function trade(ledger, tf, sigs, tpPct, slPct, execPrice){
  const events = [];
  // kill-switch: en drawdown profundo se dejan de abrir posiciones (las
  // abiertas se gestionan igual); se rearma solo si el equity se recupera
  const lastEq = ledger.equity.length ? ledger.equity[ledger.equity.length-1].e : ledger.balance;
  if(ledger.peak && lastEq < ledger.peak*(1-MAX_DRAWDOWN)){
    if(sigs.length) console.error(`paper: kill-switch activo (equity ${lastEq} < ${Math.round(ledger.peak*(1-MAX_DRAWDOWN)*100)/100}), ${sigs.length} señal(es) sin operar`);
    return events;
  }
  for(const s of sigs){
    const px = execPrice ?? s.price;
    const cur = ledger.open.find(p => p.tf === tf);
    if(cur){
      if(cur.type === s.type) continue;
      events.push({...closePos(ledger, cur, px, s.time, 'flip'), event:'close'});
    }
    const stake = r2(ledger.balance * STAKE_FRACTION);
    if(stake < 5) continue; // mínimo de orden tipo Binance; cartera agotada no abre más
    const dir = s.type==='BUY' ? 1 : -1;
    const pos = {
      id: `${tf}-${s.time}-${s.type}`, tf, type: s.type,
      time: s.time, entry: px, signal_price: s.price, stake,
      tp: r2(px * (1 + dir*tpPct)),
      sl: r2(px * (1 - dir*slPct)),
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
  ledger.peak = r2(Math.max(ledger.peak || START_BALANCE, eq));
  ledger.equity.push({t: nowSec, e: eq});
  if(ledger.equity.length > MAX_EQUITY_POINTS)
    ledger.equity.splice(0, ledger.equity.length - MAX_EQUITY_POINTS);
  ledger.updated_at = new Date(nowSec*1000).toISOString();
  return eq;
}

module.exports = {init, settle, trade, mark, grossPnl, netPnl,
                  START_BALANCE, STAKE_FRACTION, FEE, SLIPPAGE, MAX_DRAWDOWN};
