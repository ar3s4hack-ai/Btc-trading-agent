# Backlog de mejoras del agente

Acumulado y priorizado por el ciclo diario de investigación. Regla: nada entra en producción sin evidencia y sin pasar por paper trading. Las fuentes, en los informes diarios de esta carpeta.

| # | Idea | Evidencia | Esfuerzo | Impacto esperado | Estado |
|---|------|-----------|----------|------------------|--------|
| 1 | **Slippage en los fills del paper trading** (0,03 % por lado) | En vivo se pierde 30-50 % del edge del backtest (informe 2026-07-04 §3) | Bajo (unas líneas en `paper.js`) | Simulación más honesta; evita sorpresas si algún día se pasa a real | ✅ Hecho 2026-07-04 |
| 2 | **Kill-switch por drawdown**: pausar aperturas si la cartera cae >10 % desde máximos | Práctica estándar de gestión de riesgo (informe 2026-07-04 §4) | Bajo | Protección; imprescindible antes de considerar dinero real | ✅ Hecho 2026-07-04 |
| 3 | **Cartera C "rupturas con recorrido"**: TP largo/SL corto (1h solo rupturas 3%/1.5%; 4h todas 4%/2%) | Backtest anual con costes: +1,43 y +1,74 USD — mejor que A y B; win rate bajo (31-47%) con umbral de equilibrio aún más bajo | Hecho como tercera cartera paper | El mayor P&L del grid; rachas de pérdidas largas esperables | ✅ En vivo desde 2026-07-06 |
| 4 | **Registrar señales descartadas** con su probabilidad (`data/signals-log.json`, cap 500) | Permite recalibrar el umbral 64 % con datos vivos en vez de backtest | Bajo | Mejor calibración continua del filtro | ✅ Hecho 2026-07-04 |
| 5 | **Ampliar ventana de frescura a 3 velas en 1h** por la cadencia real (~2 h) de Actions | Cadencia medida el 2026-07-04: ~127 min entre pasadas | Trivial | Evita perder operaciones del experimento | ✅ Hecho 2026-07-04 |

| 6 | **Contexto fundamental en modo sombra**: F&G, prima Coinbase y red Bitcoin publicados, alertados y registrados junto a cada señal | Fuentes públicas sin clave; lectura contraria del sentimiento y prima como proxy institucional | Bajo | Credibilidad + histórico para decidir con datos si merece ser feature del modelo | ✅ Hecho 2026-07-05 (sombra) |
| 7 | **Promover el fundamental a feature del modelo** si el histórico de signals-log muestra correlación con el resultado de las señales | Pendiente de acumular ≥2-3 meses de registro | Medio (feature nueva + reentrenar + espejo JS/Python) | Según lo que digan los datos | Esperando histórico |
| 8 | **Filtro de régimen explícito**: pausar cruces EMA cuando no hay tendencia (ADX bajo / canal estrecho) y en volatilidad extrema | Causa nº 1 de muerte de bots: estrategia de tendencia en mercado sin tendencia (informe 2026-07-06) | Medio (indicador + backtest + espejo) | Menos operaciones perdedoras en lateral | Propuesta (evaluar con la cartera C) |
| 9 | **Aviso Telegram al publicarse un informe de investigación** | Los informes no sirven si nadie los ve | Bajo (workflow con filtro de rutas) | Visibilidad del ciclo de investigación | ✅ Hecho 2026-07-06 |

## Descartado (con motivo)

- **Modelos transformer/deep learning**: mejoras marginales publicadas, coste alto, se pierde la evaluación en navegador y la interpretabilidad (informe 2026-07-04 §5).
- **Bajar el umbral de convicción a <64 %**: el backtest muestra que el acierto cae hacia la tasa base; la escasez de señales es diseño, no defecto.
