# Backlog de mejoras del agente

Acumulado y priorizado por el ciclo diario de investigación. Regla: nada entra en producción sin evidencia y sin pasar por paper trading. Las fuentes, en los informes diarios de esta carpeta.

| # | Idea | Evidencia | Esfuerzo | Impacto esperado | Estado |
|---|------|-----------|----------|------------------|--------|
| 1 | **Slippage en los fills del paper trading** (0,02-0,05 % por lado) | En vivo se pierde 30-50 % del edge del backtest (informe 2026-07-04 §3) | Bajo (unas líneas en `paper.js`) | Simulación más honesta; evita sorpresas si algún día se pasa a real | Propuesta |
| 2 | **Kill-switch por drawdown**: pausar aperturas si la cartera cae >10 % desde máximos | Práctica estándar de gestión de riesgo (informe 2026-07-04 §4) | Bajo | Protección; imprescindible antes de considerar dinero real | Propuesta |
| 3 | **Salidas ATR o canal (cartera C)**: TP/SL = k×ATR14, o salida al perder el mínimo de N velas | Donchian: Sharpe 1,95 vs cruce EMA con DD 51 % (informe 2026-07-04 §1-2) | Medio (nueva cartera paper + reentrenar si cambia el etiquetado) | Potencialmente el mayor salto de calidad de salidas | Esperando veredicto del A/B actual |
| 4 | **Registrar señales descartadas** con su probabilidad en `signals.json` | Permite recalibrar el umbral 64 % con datos vivos en vez de backtest | Bajo | Mejor calibración continua del filtro | Propuesta |
| 5 | **Ampliar ventana de frescura a 3 velas en 1h** si la cadencia real (~2 h) hace perder entradas | Cadencia medida el 2026-07-04: ~127 min entre pasadas | Trivial | Evita perder operaciones del experimento | Vigilando (aún sin caso perdido confirmado) |

## Descartado (con motivo)

- **Modelos transformer/deep learning**: mejoras marginales publicadas, coste alto, se pierde la evaluación en navegador y la interpretabilidad (informe 2026-07-04 §5).
- **Bajar el umbral de convicción a <64 %**: el backtest muestra que el acierto cae hacia la tasa base; la escasez de señales es diseño, no defecto.
