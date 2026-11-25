# message-summarize: arquitectura

Cómo está construido el producto hoy, en el código de `main`. Qué hace está en [requirements.md](requirements.md) y por qué se decidió cada cosa, en [decisiones.md](decisiones.md). Si este documento y el código no coinciden, manda el código y se corrige este documento en el mismo PR.

Última revisión: 2026-11-25, sobre la versión `0.1.0-rc1`.

## 1. Capas

Puertos y adaptadores. Las dependencias apuntan solo hacia adentro.

![Capas: main crea los adaptadores y los conecta con los casos de uso; interfaces llama a los casos de uso; infrastructure implementa los puertos; application usa el dominio](images/diagrams/architecture.svg)

| Capa | Qué tiene | Puede importar |
|---|---|---|
| `src/domain/` | Entidades (`Conversation`, `Participant`, `Message`) y reglas puras del digest: ventana y puntero, no leídos, masivos propios, deduplicación, secciones, truncado, exclusiones, horarios, ajustes, selección y textos de Ask | Solo `domain/` |
| `src/application/` | Casos de uso (`CaptureMessages`, `TranscribeAudios`, descarga de audios, `GenerateDigest`, `DeliverPending`, `AskChats`) y `ports/`, las interfaces que necesitan | `domain/` y `application/` |
| `src/infrastructure/` | Adaptadores: `whatsapp/` (Baileys), `llm/api/`, `llm/cli/`, Ollama, `persistence/sqlite/`, `transcription/` (whisper.cpp), `scheduling/` (croner), `rendering/`, `service/` (launchd, systemd, clave `Run` de Windows), `secrets/`, `i18n/`, `legacy/` (importar la herramienta anterior) | Todo menos `interfaces/` y `main/` |
| `src/interfaces/` | `cli/` (parseo de argumentos), `http/` (router, SSE, archivos estáticos) y `web/` (Svelte 5) | Lo que exponga `main/` por tipos |
| `src/main/` | Raíz de composición: configuración, daemon, comandos de la CLI, rutas de la web y el cableado de todo lo anterior | Todo |

La regla para `domain/` y `application/` la verifica `test/unit/architecture.test.ts`: ni Node, ni paquetes de npm, ni imports hacia afuera. El resto de las direcciones es convención y la revisa el agente `reviewer`.

## 2. Procesos

Hay un solo proceso largo por instalación, el **daemon** (`msum daemon`), protegido por un archivo de lock.

- **`DaemonHost`** (`src/main/daemon-host.ts`) lleva todas las cuentas: cada 5 segundos reconcilia la lista de cuentas con las unidades que corren, arranca las cuentas vinculadas, deja quietas las bloqueadas y vincula cuentas nuevas desde la web.
- **`Daemon`** (`src/main/daemon.ts`) es la unidad de UNA cuenta: conexión, captura, horarios con croner, entrega y recuperación de ejecuciones perdidas. Ante un estado terminal (sesión cerrada, 403, reemplazada) frena la conexión, escribe `blocked.json` y queda quieta a propósito, para no reconectar en loop (RNF-17).
- **La web** la sirve el mismo daemon en `127.0.0.1` con token (RNF-03): `src/main/web.ts` arma el servidor, `src/main/web-*.ts` son las rutas por pantalla y `src/interfaces/http/` el router y el SSE.
- **La CLI** (`src/main/cli.ts`, `src/main/commands/`) corre comandos cortos. Los que tocan una cuenta en uso (`link`, `unlink`, `digest`) se coordinan con el daemon por archivos de lock y por el compare-and-set del puntero en la base.

## 3. Flujos

```mermaid
flowchart LR
  WA[WhatsApp<br/>Baileys] -->|eventos| TR[whatsapp/translate.ts]
  TR -->|eventos de captura| CM[CaptureMessages]
  CM --> CR[(CaptureRepository<br/>SQLite)]
  TR -->|audios| DQ[DownloadQueue] --> TA[TranscribeAudios<br/>whisper.cpp]
  TA --> CR
  SCH[croner / Resumir ahora] --> GD[GenerateDigest]
  CR --> DS[DigestSource] --> GD
  GD -->|una conversación| SUM[Summarizer<br/>LocalOnlyRouter → Fallback → proveedor]
  GD -->|commit: digest + puntero + outbox| ST[(DigestStore)]
  ST --> DP[DeliverPending] --> DC[DeliveryChannel<br/>solo el chat propio]
```

| Flujo | Entra por | Caso de uso | Puertos | Adaptadores |
|---|---|---|---|---|
| Captura (RF-10 a RF-19) | `infrastructure/whatsapp/translate.ts`, que traduce los eventos de Baileys | `CaptureMessages` (`application/capture-messages.ts`, eventos en `capture-events.ts`) | `CaptureRepository` | `SqliteCaptureRepository` |
| Audios (RF-15, RF-20 a RF-23) | El adaptador encola cada audio | Descarga en `download-audios.ts`, transcripción en `TranscribeAudios` con un pool de workers | `DownloadQueue`, `AudioDownloader`, `Transcriber`, `TranscriptionStore` | `whatsapp/media.ts`, `WhisperCppTranscriber`, `SqliteTranscriptionStore` |
| Digest (RF-30 a RF-39) | Un horario, "Resumir ahora", la vista previa o `msum digest` (`main/run-digest.ts`) | `GenerateDigest` | `DigestSource`, `Summarizer`, `DigestStore`, `Clock`, renderers de `ports/rendering.ts` | `SqliteDigestSource`, `composeSummarizer`, `rendering/`, `SqliteDigestStore` |
| Entrega (RF-50 a RF-52) | Después de cada commit y cada `sweepMs` mientras hay conexión | `DeliverPending` | `OutboxRepository`, `DeliveryChannel` | `SqliteOutboxRepository`, `WhatsAppSelfChatDelivery` |
| Ask (RF-76) | `POST /api/accounts/:id/ask` (`main/web-ask.ts`, `main/ask.ts`) | `AskChats`, envuelto por `AskService` (historial, una consulta a la vez, envío al chat propio) | `DigestSource`, `Answerer`, `AskHistory`, `OwnChatQueue` | `SqliteDigestSource`, `composeAnswerer`, `SqliteAskHistory`, `SqliteOutboxRepository` |
| Horarios (RF-60 a RF-66) | `Daemon` | Sin caso de uso propio: la regla está en `domain/schedule.ts` | Ninguno | `CronerScheduler`, `SqliteScheduleRepository` |
| Servicio del sistema (RF-80) | `msum service` | Sin caso de uso propio | `ServiceInstaller` | `LaunchdInstaller`, `SystemdInstaller`, `WindowsRunKeyInstaller` |

La lectura de mensajes no es un puerto: cada plataforma tiene un adaptador que traduce sus eventos a los de `capture-events.ts` (decisión 15). Una plataforma nueva agrega su traductor y, si entrega, su `DeliveryChannel`.

## 4. Proveedores de LLM

Todos implementan `Summarizer` (salida JSON validada contra `summary-schema.ts`) y, salvo `CliSummarizer`, también `Answerer` (texto libre, para Ask).

- **Por API:** `OpenAiCompatibleSummarizer` (OpenAI y cualquier API compatible), `AnthropicSummarizer`, `GeminiSummarizer`, `OllamaSummarizer`.
- **Por CLI:** `ClaudeCliSummarizer`, `GenericCliSummarizer` y `DisabledCliSummarizer` para los presets apagados. Todas corren con `llm/cli/run-process.ts`: sin herramientas, sin MCP, sin sesión, en un directorio temporal vacío y con tiempo máximo (RF-49).
- **Composición:** `composeSummarizer` arma siempre `LocalOnlyRouter` por fuera del `FallbackSummarizer`, así una conversación "solo local" nunca llega a un proveedor externo, ni siquiera por el respaldo (RF-43). No se arma a mano.

## 5. Datos en disco

Todo vive bajo el directorio de datos (`MSUM_DATA_DIR`, ver `src/main/paths.ts`), con permisos 0700 y 0600.

| Ruta | Qué guarda |
|---|---|
| `config.json`, `secrets.json` | Configuración y claves de API de la instalación |
| `app.db` | Cuentas, horarios, estado del asistente y consentimientos. Migraciones propias |
| `web-token`, `web-session`, `web.json` | Token de la web, secreto de las cookies y dirección donde escucha el daemon |
| `daemon.pid` | Lock del daemon: uno por instalación |
| `models/` | Modelos de whisper, compartidos |
| `accounts/<id>/db.sqlite` | Mensajes, no leídos, transcripciones, digests, outbox, historial de ejecuciones y de Ask. SQLite en modo WAL con `schema_version` (RNF-08, RNF-16) |
| `accounts/<id>/auth/` | Sesión de WhatsApp. Nunca se loguea (RNF-04) |
| `accounts/<id>/media/` | Audios esperando transcripción, hasta `transcription.maxMediaMb` |
| `accounts/<id>/config.json`, `secrets.json`, `state.json`, `blocked.json`, `link.lock` | Ajustes y claves que pisan los de la instalación, estado para la web, marca de bloqueo y lock de un `msum link` en curso |

Borrar `accounts/<id>/` borra la cuenta entera (RF-03).

## 6. Dónde está cada área

| Requerimientos | Código |
|---|---|
| RF-01 a RF-07, cuentas y vinculación | `main/daemon-host.ts`, `main/link-flow.ts`, `main/accounts.ts`, `infrastructure/whatsapp/connection.ts`, `account-binding.ts`, `infrastructure/legacy/` |
| RF-10 a RF-19, captura | `infrastructure/whatsapp/` (`translate.ts`, `content.ts`, `details.ts`, `raw.ts`), `application/capture-*.ts`, `persistence/sqlite/capture-*.ts` |
| RF-20 a RF-23, transcripción | `application/download-audios.ts`, `transcribe-audios.ts`, `infrastructure/transcription/` |
| RF-30 a RF-39, digest | `domain/` (`window.ts`, `unread.ts`, `mass.ts`, `dedupe.ts`, `sections.ts`, `truncate.ts`, `prompt.ts`), `application/generate-digest.ts`, `infrastructure/rendering/` |
| RF-40 a RF-49, proveedores | `infrastructure/llm/`, `main/providers.ts`, `main/provider-test.ts` |
| RF-50 a RF-53, entrega | `application/deliver-pending.ts`, `infrastructure/whatsapp/self-chat-delivery.ts`, `persistence/sqlite/outbox.ts` |
| RF-60 a RF-66, horarios | `main/daemon.ts`, `main/schedules.ts`, `domain/schedule.ts`, `infrastructure/scheduling/` |
| RF-70 a RF-76, web | `interfaces/web/`, `interfaces/http/`, `main/web*.ts`, `main/ask.ts`, `application/ask-chats.ts` |
| RF-80 a RF-82, CLI | `interfaces/cli/`, `main/cli.ts`, `main/commands/` |
| RNF-01, RNF-04, privacidad | `test/support/network-guard.ts`, `main/logger.ts`, `infrastructure/llm/api/redact.ts` |
| RNF-05 a RNF-07, instalación | `docker/`, `packaging/`, `infrastructure/service/` |

Qué test cubre un requerimiento se encuentra buscando su ID en `test/`.

## 7. Tests

| Carpeta | Qué prueba |
|---|---|
| `test/unit/` | Cada módulo, con la misma estructura que `src/` |
| `test/contract/` | Una suite por puerto (`*.contract.ts`) que corre contra cada adaptador (`*.test.ts`) |
| `test/golden/` | Escenarios inventados con la salida congelada de la herramienta anterior (OBJ-3) |
| `test/eval/` | Evaluación de modelos de Ollama contra los golden (RF-45). No corre en CI |
| `test/support/` | Fakes, arneses y la guardia de red que hace fallar un test que llama a la red sin declararlo |

`npm run test:mutation` corre StrykerJS sobre `domain/` y `application/`.

## 8. Deuda conocida

- **`src/main/` creció más allá de la raíz de composición:** 80 archivos y unas 15 000 líneas contando `commands/`, con rutas de la web (`web-*.ts`), el daemon y la lógica de Ask mezclados con el cableado. Una reorganización en subcarpetas (`main/web/`, `main/daemon/`) haría más fácil leerlo; no cambia comportamiento.
- **Votos de encuestas:** llegan cifrados y se guardan tal cual (`poll_votes`); descifrarlos queda pendiente.
- **Confirmación de entrega:** un envío cuenta como hecho cuando se escribe en el socket, no cuando el servidor lo recibe (ver `deliver-pending.ts`).
