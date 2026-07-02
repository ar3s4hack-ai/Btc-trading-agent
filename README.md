# BTC Trading Agent 🤖📈

Dashboard de señales de Bitcoin con detección de **consolidaciones y rupturas**, un modelo de **machine learning entrenado con 1 año de datos de Binance** (validación walk-forward) y un **agente autónomo** que analiza el mercado cada 30 minutos y envía alertas por Telegram.

**Demo en vivo:** <https://ar3s4hack-ai.github.io/btc-trading-agent/>

> ⚠️ Proyecto **educativo**. Nada de lo que genera es asesoramiento financiero.

## ¿Qué hace?

- **Dashboard web** (`index.html`): gráfico de velas BTC/USDT (1h y 4h) con [Lightweight Charts](https://github.com/tradingview/lightweight-charts), zonas de consolidación detectadas automáticamente, señales de compra/venta por cruces de EMA 9/21 y rupturas de rango, backtest en vivo con TP/SL fijos y la probabilidad estimada por el modelo ML para cada señal.
- **Modelo ML** (`agent/train.py`): regresión logística estandarizada (con HistGradientBoosting como referencia de techo) entrenada sobre ~17.000 muestras etiquetadas de 1 año de velas de Binance. Cada muestra simula una entrada larga o corta y se etiqueta según si el take profit se alcanza antes que el stop loss. **Validación walk-forward honesta**: entrena con el primer 75 % del año y evalúa con el 25 % final, sin barajar. El modelo se exporta a `data/model.json` (pesos + escalado) y se evalúa igual en el navegador y en Node, sin dependencias.
- **Agente autónomo** (`agent/run.js`): se ejecuta cada 30 minutos en GitHub Actions, descarga las velas recientes de Binance, recalcula señales, las puntúa con el modelo ML, publica `data/signals.json` (lo lee el dashboard) y envía las señales nuevas a **Telegram**.

### Filtro de calidad de señales

Para evitar el ruido típico de los cruces de EMA en mercado lateral, las señales pasan dos filtros:

1. **En el motor** (`lib/agent-core.js`): los cruces EMA 9/21 solo cuentan a favor de la tendencia (precio por encima/debajo de la EMA50), con bandas de RSI estrictas (48–68 compra, 32–52 venta) y un enfriamiento mínimo de 10 velas entre señales del mismo tipo.
2. **En las alertas de Telegram** (`agent/run.js`): solo se avisa de señales con probabilidad ML ≥ 64 % de alcanzar el take profit antes que el stop. Calibrado con 1 año de backtest: ~5 alertas al mes entre 1h y 4h con ~75 % de acierto, frente a la tasa base del ~62 %. El resto de señales sigue visible en el dashboard, pero no interrumpe.

## Arquitectura

```
index.html                      ← dashboard (GitHub Pages)
lib/
  agent-core.js                 ← indicadores, señales, backtest y scoring ML
                                   (compartido entre navegador y Node)
  lightweight-charts-4.1.3.js   ← librería de gráficos (local, sin CDN)
agent/
  fetch_data.py                 ← descarga 1 año de velas 1h/4h de Binance
  train.py                      ← entrena y exporta el modelo a data/model.json
  run.js                        ← análisis cada 30 min + alertas Telegram
.github/workflows/
  train-model.yml               ← "Entrenar modelo ML (1 año Binance)" — manual
                                   y cada lunes de madrugada
  trading-agent.yml             ← "Agente autónomo (análisis + alertas)" — manual
                                   y cada 30 min
data/                           ← generado por los workflows (velas, modelo, señales)
```

Los indicadores y *features* de `agent/train.py` espejan 1:1 los de `lib/agent-core.js`: lo que se entrena en Python es exactamente lo que se evalúa en JavaScript.

## Puesta en marcha

1. **Clona o haz fork** de este repositorio.
2. **Activa GitHub Pages**: *Settings → Pages → Deploy from a branch → `main` / root*. El dashboard quedará en `https://<usuario>.github.io/<repo>/`.
3. **Entrena el modelo**: pestaña *Actions → "Entrenar modelo ML (1 año Binance)" → Run workflow*. Descarga 1 año de velas de Binance, entrena y publica `data/model.json` con un commit automático. Después se reentrena solo cada lunes.
4. **Lanza el agente**: *Actions → "Agente autónomo (análisis + alertas)" → Run workflow*. A partir de ahí se ejecuta solo cada 30 minutos y mantiene `data/signals.json` al día.
5. **(Opcional) Alertas por Telegram**: crea un bot con [@BotFather](https://t.me/BotFather) y añade en *Settings → Secrets and variables → Actions*:
   - `TELEGRAM_BOT_TOKEN` — token del bot
   - `TELEGRAM_CHAT_ID` — id del chat o canal de destino

   Sin estos secrets el agente funciona igual, solo que no envía alertas.

No hace falta ninguna clave de Binance: se usa la API pública de solo lectura (`data-api.binance.vision`, con `api.binance.com` como respaldo).

## Ejecución local (opcional)

```bash
# datos + entrenamiento (Python 3.10+)
pip install numpy scikit-learn
python agent/fetch_data.py
python agent/train.py

# análisis del agente (Node 18+, sin dependencias)
node agent/run.js

# dashboard
python -m http.server 8000   # → http://localhost:8000
```

## Métricas del modelo

Cada entrenamiento imprime y guarda en `data/model.json` las métricas sobre el tramo de test walk-forward (nunca visto): AUC y accuracy de la regresión logística y del gradient boosting de referencia, junto con la tasa base. Así se puede comprobar en cada reentrenamiento que el modelo aporta señal real por encima del azar.

## Licencia y aviso

Proyecto educativo para experimentar con análisis técnico, ML aplicado a series temporales y automatización con GitHub Actions. **No es asesoramiento financiero**: no operes con dinero real basándote en estas señales.
