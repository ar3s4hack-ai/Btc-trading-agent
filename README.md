# BTC Trading Agent · Rango 9h 🤖📈

`agent/rango9h.js` + workflow `.github/workflows/rango9h.yml`. Estrategia "Rango 9h" y manda las señales por Telegram.

- **Regla:** rango 09:00-10:00 (UTC+2 fijo). Desde las 10:00 y hasta las 22:00, la primera vela de 5 min que cierra fuera del rango da la entrada, una al día por activo, de lunes a viernes. Cierre por hora a las 22:50.
- **SL/TP:** BTC 600/900 puntos (filtro de amplitud del rango 250-600), SOL 0,72/1,62, resto 0,5 % / 1,125 % (ajustado con las señales del bot del 14/10/2026, que cuadran al céntimo a 20.000 $ de poder).
- **Activos:** BTC, HYPE, TAO, HBAR, UNI, SUI, SOL y LINK (Binance; KuCoin de respaldo).
- **Filtro de tendencia (anti falsa ruptura):** BTC solo entra con ADX 5m ≥ 20; altcoins solo con Supertrend 1h a favor (2,5 · ATR 14) y ADX 1h ≥ 20. Si no se cumple avisa "ruptura descartada". Variables `TREND_FILTER`, `ADX_BTC`, `ADX_ALT`, `ST_FAC`. Backtest 1 año (L-V, cierre 22:50): BTC +16 R → +30 R; altcoins −46 R → +90 R (positivo en las dos mitades, 6 de 7 activos). En altcoins marca además "RUPTURA DEBIL" si la vela cierra lejos de su extremo.
- **Telegram** (secrets `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`): aviso previo *ROTURA INMINENTE*, la señal con el análisis tipo bot (dudosa por spread, poder/ROI/% del saldo en $ y €, conveniencia, camino al TP, SL protegido, presión con % de compras a mercado, EQH/EQL de 48 h) y el cierre por TP, SL o por hora.
- **Cartera simulada:** empieza con 500 $ (`CAPITAL`) y cada operación usa 500 $ (`POSITION_USD`); se cambian en `rango9h.yml`. Libro en `data/rango9h-trades.json`.
- Corre en bucle dentro de Actions (revisa cada minuto) de lunes a viernes.

> Backtest de 1 año: BTC con esta regla quedó en torno a +12 R; las altcoins en negativo.

## Aviso

Proyecto educativo. **No es asesoramiento financiero**: no operes con dinero real basándote en estas señales.
