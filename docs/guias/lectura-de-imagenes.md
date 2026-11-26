# Leer imágenes (opcional)

Viene desactivado. A diferencia de la [transcripción de audios](transcripcion.md), **la imagen sale de tu máquina**: leé esto antes de activarlo. Volver al [README](../../README.es.md).

## Qué hace

Cuando está activado, una imagen que llega con el daemon conectado (y las de los últimos `historyDays` días del historial que manda WhatsApp al vincular) se:

1. descarga del host de medios de WhatsApp, por la misma cola durable que los audios (mismos controles sobre lo que escribe quien la mandó, 10 MB como máximo, y cuenta para `transcription.maxMediaMb`);
2. lee con un modelo con visión, a través del **CLI de Claude Code** que ya usás como proveedor (`provider.primary` tiene que ser `claude-cli`), sin herramientas y en un directorio vacío, igual que el resumidor;
3. reemplaza, en el digest y en Ask, por lo que dice: `[imagen] epígrafe (lo que dice la imagen: «…»)`.

La imagen se borra apenas se lee. Lo que queda es el texto. Una foto personal, un meme o un sticker no tienen nada para leer: el modelo responde "nada" y la imagen sigue apareciendo como `[imagen]`, como antes.

## Qué sale de tu máquina

- **La imagen misma**, hacia Anthropic, por `claude`. Con la transcripción el audio nunca sale; acá sí. Por eso viene desactivado y `msum doctor` lo avisa, y advierte cuando no hay consentimiento registrado para el proveedor (`msum provider use claude-cli` lo registra).
- **Las conversaciones de `localOnlyPatterns` nunca se leen.** Se revisa dos veces: al capturar la imagen y otra vez justo antes de leerla (así un chat que marcás como solo local después también queda protegido). La imagen de uno de esos chats se descarta con el código `not-allowed`. El criterio es el de los digests: el patrón se compara con `<id> <nombre>` de la conversación, y una conversación que no se conoce no se lee.
- Cualquier otro proveedor (clave de API, Ollama, Gemini CLI, Codex) **no** lee imágenes por ahora: con ellos, `doctor` avisa y las imágenes quedan como `[imagen]`.

## Cómo activarlo

Usá `claude-cli` como proveedor principal y después, en `config.json` (o en el archivo de una cuenta):

```json
"imageReading": { "enabled": true, "historyDays": 7 }
```

Cambiarlo reinicia la unidad de la cuenta. No hay nada para instalar: solo el `claude` que ya tenés.

## Opciones

| Opción | Por defecto | Qué significa |
|---|---|---|
| `enabled` | `false` | Activa la lectura de imágenes. |
| `historyDays` | `7` | También se leen las imágenes del historial de los últimos N días. `0` es sin límite: todo el historial (pueden ser miles de imágenes, cada una es una llamada al modelo). |
| `timeoutMs` | `180000` | Lo máximo que puede tardar una imagen. |

Las imágenes comparten la cola y el cupo de la transcripción: `transcription.concurrency` acota cuántas cosas (audios e imágenes) se procesan a la vez, y el límite de carpeta `transcription.maxMediaMb` vale para las dos. No necesitan `transcription.enabled`: se pueden leer imágenes sin transcribir audios, y al revés.

## Límites

- Formatos: JPEG, PNG y WebP (lo que manda WhatsApp para las fotos). No se leen stickers, GIF ni videos.
- Se guardan hasta 2.000 caracteres de texto por imagen.
- Una imagen que no se pudo leer para siempre (dañada, falló el modelo) queda registrada como fallida y no se reintenta; si falta el CLI o se cayó la conexión, queda en la cola.
- El texto viene de una imagen que mandó otra persona: se transcribe, nunca se obedece. El modelo no tiene herramientas, así que una instrucción escrita en una imagen no puede hacer nada más que volver como texto.
