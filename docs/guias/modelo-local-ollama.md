# Elegir un modelo local (Ollama)

Un modelo chico, de 3 a 8 mil millones de parámetros, puede resumir en tu propia máquina. Cuál conviene depende de la RAM y de qué tan bien hace el trabajo, así que el programa tiene una tabla de candidatos y una forma de medirlos (RF-45). Volver al [README](../../README.es.md).

**El modelo lo elegís vos; el programa no elige uno por vos.** Lista los candidatos que entran en tu RAM, muestra qué se midió de cada uno y te deja la decisión.

## Qué se midió

Cuatro candidatos fueron evaluados hasta ahora (81 conversaciones, 2026-11-18, en un Ollama local); los otros seis no.

| Modelo | JSON válido | Coincidencia, casos claros | Casos dudosos | Promedio por resumen | RF-45 |
|---|---|---|---|---|---|
| `qwen3.5:4b` | 100% | 92,1% | 66,7% | 3,6 s | cumple |
| `qwen3:8b` | 100% | 90,5% | 41,7% | 4,3 s | cumple |
| `qwen2.5:3b` | 100% | 87,3% | 58,3% | 2,1 s | no cumple |
| `qwen3:4b` | 100% | 63,5% | 41,7% | 3,1 s | no cumple |

Hasta ahora `qwen3.5:4b` es la mejor opción evaluada: cumplió con la coincidencia más alta y es más chico y más rápido que `qwen3:8b`. Es información, no un valor por defecto: no se configura nada hasta que corras los comandos de abajo.

Los números salen de una corrida por modelo en una máquina, con el conjunto de evaluación que se describe [más abajo](#evaluar-un-modelo). Un modelo que no está en la tabla no fue medido, lo que no es lo mismo que ser malo.

## Comandos

### `msum ollama recommend [--all]`

Lee la RAM de esta máquina y lista los candidatos que entran, en este orden: los que pasaron la evaluación (mejor coincidencia primero), después los sin evaluar y después los que no cumplieron.

- De cada uno muestra el tamaño de descarga, la RAM mínima y su evaluación, con los números.
- Los candidatos que necesitan más RAM de la que tenés quedan ocultos (dice cuántos); `--all` los muestra marcados.
- No hace ninguna llamada de red, no elige nada y no escribe nada: termina con los comandos para correr una vez que elegiste (`msum ollama pull <tag>`, y después `msum provider use ollama --model <tag>`, o `provider.ollama.model` en `config.json`).

La tabla está en `src/infrastructure/llm/ollama-candidates.ts`: los tags, parámetros y tamaños salen de las páginas de la biblioteca de Ollama (leídas el 2026-11-17, listadas en ese archivo). La **RAM mínima es una estimación** (tamaño de descarga por 1,25 más 3 GB), no un número que publique Ollama. Los candidatos son `qwen3.5:4b`, `qwen3:4b`, `qwen3:8b`, `qwen2.5:3b`, `qwen2.5:7b`, `gemma3:4b`, `gemma4:e4b`, `llama3.2:3b`, `llama3.1:8b` y `phi4-mini:3.8b`. En la biblioteca aparecen tags nuevos todo el tiempo, así que revisala y editá la tabla.

### `msum ollama pull <tag> [--account <id>]`

Le pide al Ollama configurado en `provider.ollama.baseUrl` que descargue el modelo (su `/api/pull`), con una línea de progreso y la verificación de que Ollama termine con `success`.

- Envía solo el tag, nunca texto de chats.
- **Solo funciona contra un Ollama en esta máquina** salvo que agregues `--allow-remote` (el modelo se descarga en el servidor que recibe el pedido, así que hacerlo en otra computadora tiene que ser una decisión).
- Los errores del servidor se muestran sin texto con forma de clave.
- Después elegilo con `msum provider use ollama --model <tag>` y probalo con `msum provider test`.

### `msum doctor`

También le pide a tu Ollama su lista de modelos (`/api/tags`, 3 segundos, sin texto de chats) cuando Ollama es el principal, el respaldo o atiende tus chats "solo locales", y falla si el modelo configurado no está instalado, con el comando `msum ollama pull` para arreglarlo. `msum doctor --skip-model-check` se salta esa llamada (la revisión de que Ollama responda es aparte y se mantiene).

## Evaluar un modelo

```sh
npm run eval:ollama -- --models qwen3.5:4b,gemma3:4b [--base-url URL] [--runs N] [--allow-remote]
```

### El conjunto de evaluación

Está en `test/eval/ollama/`: **81 conversaciones tomadas de los golden files** (todas inventadas).

- Cada una tiene el texto exacto que recibe el resumidor (`transcripts.json`, generado por `test/eval/extract-cases.mjs`) y una **etiqueta escrita a mano** de si el dueño tiene que responder, con el motivo en una línea (`labels.json`; `doubtful` marca las que un lector podría discutir).
- Las respuestas de la herramienta anterior se usaron solo para contrastar, nunca como verdad.
- Para cada modelo y caso el script llama al `OllamaSummarizer` real con el prompt y el esquema de producción y registra si el JSON fue válido, si "necesita respuesta" coincide con la etiqueta (una respuesta inválida cuenta como diferencia), la latencia y el error.
- Imprime una tabla y escribe `test/eval/ollama/results/<fecha>-<modelo>.json` (ids y números, sin texto de chats).

### Cómo se juzga

La regla de etiquetado está escrita en `test/eval/ollama/README.md` (en inglés).

- **El JSON válido se juzga en todos los casos; la coincidencia se juzga solo en los casos claros.** Los casos claros son los que no están marcados `doubtful` ni son los seis casos de relleno marcados `jsonOnly` (que cuentan para el JSON válido y no para la coincidencia).
- La coincidencia en los casos dudosos y la general se imprimen y guardan como columnas aparte, a modo informativo.
- Los archivos de resultados subidos a `test/eval/ollama/results/` no se ignoran: son los que promueven a un candidato a evaluado.
- **Un modelo cumple RF-45 con 100% de JSON válido y al menos 90% de coincidencia en "necesita respuesta" (casos claros).** El script termina con 1 si un modelo no cumple.
- Rechaza un `--base-url` que no esté en esta máquina salvo que pases `--allow-remote`. Necesita tu propio Ollama corriendo con los modelos ya descargados; nunca arranca uno.

### Registrar una evaluación

Para registrar una evaluación, que cumpla o no, poné `evaluated: true` y `result: { date, validJsonRate, needsReplyAgreement, meanLatencyMs, passed }` en su entrada de `ollama-candidates.ts` (el script imprime la línea) y subilo junto con el archivo de resultados. Un test falla si un archivo de resultados subido y la tabla no coinciden. Los modelos sin archivo de resultados quedan "sin evaluar".

---

Volver al [README](../../README.es.md) · [Índice de guías](README.md)
