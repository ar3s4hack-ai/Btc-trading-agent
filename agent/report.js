#!/usr/bin/env node
/* Resumen semanal del paper trading A/B por Telegram (GitHub Actions,
   domingos). Lee data/trades.json y data/trades-b.json del repo (los publica
   el agente cada 30 min) y envía equity, P&L, operaciones de la semana y
   quién va ganando. Solo lectura: no modifica nada. Sin secrets de Telegram
   imprime el resumen y termina bien (útil para probar el workflow). */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function load(f){ try{ return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); }catch(e){ return null; } }
const fmt = n => n.toLocaleString('es-ES', {maximumFractionDigits: 2});
const sign = n => (n>=0?'+':'') + fmt(Math.round(n*100)/100);

async function telegram(text){
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if(!token || !chat){ console.error('telegram: secrets no configurados, resumen no enviado'); return; }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({chat_id: chat, text, parse_mode:'HTML'}),
  });
  if(!res.ok) console.error('telegram:', res.status, await res.text());
}

function resumen(nombre, led, semanaDesde){
  const eq = led.equity.length ? led.equity[led.equity.length-1].e : led.start_balance;
  const st = led.stats || {closed:0, wins:0, pnl_total:0};
  const semana = led.closed.filter(c => c.exit_time >= semanaDesde);
  const pnlSemana = semana.reduce((t,c) => t + c.pnl, 0);
  const abiertas = led.open.map(p => `${p.type==='BUY'?'▲':'▼'}${p.tf}`).join(' ') || 'ninguna';
  const linea =
    `<b>${nombre}</b>: ${fmt(eq)} USDT (${sign(eq - led.start_balance)})\n` +
    `· Esta semana: ${semana.length} cerradas, ${sign(pnlSemana)} USDT\n` +
    `· Total: ${st.closed} ops, ${st.closed ? Math.round(st.wins/st.closed*100) : 0}% con beneficio · abiertas: ${abiertas}`;
  return {eq, linea};
}

async function main(){
  const a = load('trades.json');
  const b = load('trades-b.json');
  if(!a){ console.error('sin data/trades.json: aún no hay nada que resumir'); return; }
  const semanaDesde = Math.floor(Date.now()/1000) - 7*86400;
  const ra = resumen('Cartera A · TP/SL actual', a, semanaDesde);
  const rb = b ? resumen('Cartera B · 2%/2% en 1h', b, semanaDesde) : null;

  let veredicto = '';
  if(rb){
    const d = Math.round((rb.eq - ra.eq)*100)/100;
    veredicto = d === 0 ? '\n\n🤝 Empate técnico esta semana.'
      : `\n\n${d > 0 ? '🔵 La <b>B</b>' : '🟢 La <b>A</b>'} va por delante por ${fmt(Math.abs(d))} USDT.`;
  }

  const msg = `📊 <b>Resumen semanal · Paper trading A/B</b>\n\n${ra.linea}` +
    (rb ? `\n\n${rb.linea}` : '') + veredicto +
    '\n\n<i>BTC Trading Agent · dinero ficticio, no es asesoramiento financiero</i>';
  console.error(msg.replace(/<[^>]+>/g, ''));
  await telegram(msg);
}

main().catch(e => { console.error(e); process.exit(1); });
