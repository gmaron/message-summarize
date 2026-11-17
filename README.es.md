# message-summarize

[English](README.md)

Lee los mensajes que llegan a tu cuenta de mensajería, los resume con el modelo de lenguaje que elijas y te manda un resumen periódico: qué chats necesitan respuesta, qué quedó pendiente y qué podés ignorar.

La primera plataforma soportada es **WhatsApp**. El núcleo no depende de ella, así que otras plataformas (Telegram, Slack, correo) se pueden sumar más adelante como adaptadores nuevos.

## Estado

**Desarrollo temprano.** Todavía no hay instalador ni interfaz web. Se puede probar una versión de línea de comandos desde el código fuente (ver [Probarlo](#probarlo-versión-temprana)); esperá asperezas. Los requerimientos aprobados están en [docs/requirements.md](docs/requirements.md) y el trabajo se organiza en las fases de la [hoja de ruta](#hoja-de-ruta).

## Probarlo (versión temprana)

**Leé primero el [aviso importante](#aviso-importante): esto usa un cliente no oficial de WhatsApp y tu número puede ser bloqueado.** El programa es de solo lectura: nunca te marca "en línea", nunca responde y nunca manda nada salvo el resumen, que va a tu propio chat ("Mensaje a mí mismo").

Requisitos: Node 22.16 o posterior, y un proveedor de LLM: [Claude Code](https://claude.com/claude-code) con la sesión iniciada en esta máquina (`claude`), o un servidor local de [Ollama](https://ollama.com) con un modelo ya descargado. No hay proveedor por defecto: lo elegís en la configuración.

```sh
npm install
npm run build
node dist/main/cli.js init      # o `msum init` después de `npm link`; crea el directorio de datos y config.json
```

1. **Editá `config.json`** (en el directorio de datos que muestra `init`; con `MSUM_DATA_DIR` lo ponés en otro lado). No hay proveedor por defecto: `init` escribe `"primary": null` y **tenés que definir `provider.primary` explícitamente** (`"claude-cli"` u `"ollama"`; con Ollama configurá también `provider.ollama.model`) antes de que funcionen `digest` o los horarios. Revisá también tu `timezone` (`init` imprime la que escribió, la del sistema; **en Docker, definí `TZ` o `timezone` en la configuración**), tus `schedules` (expresiones cron, por ejemplo `["0 7 * * *", "0 19 * * *"]`) y tu `ownerName`. Un `promptFile` relativo se lee desde el directorio de datos. Los valores inválidos se rechazan con un mensaje que nombra la opción.
2. **`msum link`** muestra un código QR en la terminal (también queda como `qr.png` mientras es válido). Escaneálo desde WhatsApp, Ajustes > Dispositivos vinculados. Espera el historial inicial y termina.
3. **`msum daemon`** se conecta, captura los mensajes, ejecuta los horarios y entrega cada resumen a tu propio chat. Dejalo corriendo (Ctrl+C lo detiene de forma ordenada). Corre un solo daemon por instalación. Si WhatsApp cierra la sesión, rechaza la conexión (403) o la reemplaza, o la sesión es de otra cuenta, el daemon deja de conectarse, escribe `account/blocked.json` y queda inactivo (así un gestor de servicios que lo reinicia no reconecta en bucle, algo que podría hacer bloquear el número). `msum status` muestra el motivo; se resuelve con `msum link` o `msum unlink`, o con `msum daemon --retry` si la conexión fue rechazada o reemplazada.
4. **`msum digest --dry-run`** genera un resumen ahora y lo muestra, sin guardar ni enviar nada. Sin `--dry-run` el resumen queda en cola y lo entrega el daemon que esté corriendo. No abre una conexión a WhatsApp (la sesión es del daemon). Opciones: `--hours N`, `--from "AAAA-MM-DD HH:MM"`, `--to "AAAA-MM-DD HH:MM"`.

Otros comandos: `msum status` (cuenta, último resumen, envíos pendientes, próximas ejecuciones), `msum doctor` (revisa Node, permisos, configuración, proveedor y vinculación) y `msum unlink`, que **borra todos los datos de la cuenta** (sus mensajes, el historial de resúmenes, los envíos pendientes y la sesión de WhatsApp; la configuración queda) y pide confirmación. Después, quitá también el dispositivo en el celular (WhatsApp, Ajustes > Dispositivos vinculados).

Todo queda en tu máquina, en el directorio de datos (con permisos solo para tu usuario), salvo lo que recibe el proveedor de LLM que elegiste. Los textos de la línea de comandos están en español o inglés (`language` en `config.json`).

## Qué va a hacer

- **Vincular tu cuenta** escaneando un QR desde una página web local, y mantenerla conectada sin marcarte "en línea", para que el celular siga recibiendo notificaciones.
- **Guardar tus mensajes solo en tu máquina** (texto, y una representación en texto de imágenes, audios, documentos, encuestas, etc.). Sin telemetría.
- **Transcribir los audios localmente** con whisper.cpp (opcional). El audio nunca sale de tu máquina.
- **Resumir cada conversación** con el LLM que elijas:
  - por **API**: OpenAI (y cualquier API compatible), Anthropic, Gemini u Ollama;
  - por la **CLI** del proveedor (Claude Code, Gemini CLI, Codex o un comando genérico), aprovechando el plan que ya pagás. Las CLIs corren sin herramientas, en un directorio vacío y con tiempo máximo.
- **Marcar conversaciones como "solo local"**, para que únicamente las resuma un modelo que corre en tu máquina.
- **Mandarte el resumen a tu propio chat** ("Mensaje a mí mismo"), ordenado en secciones: necesitan respuesta, tienen pendientes, el resto. Nunca se envía a nadie más, ni siquiera a otra cuenta de la misma instalación.
- **Correr en los horarios** que definas desde la web (por ejemplo, 9:00 y 19:00 todos los días), además de "resumir ahora" y una vista previa que no envía nada.
- **Manejar varias cuentas** en una misma instalación, cada una con sus datos, configuración y horarios.
- **Instalarse con Docker o de forma nativa en macOS y Linux.** Windows nativo llega en la v1.1; mientras tanto, en Windows se usa Docker.

## Aviso importante

Leé esto antes de usar message-summarize con tu cuenta.

- **WhatsApp puede bloquear tu número.** message-summarize se conecta a WhatsApp a través de [Baileys](https://github.com/WhiskeySockets/Baileys), un cliente **no oficial**. WhatsApp no permite clientes no oficiales y puede bloquear el número que los usa, de forma temporal o permanente. El proyecto intenta reducir ese riesgo (solo lectura, sin mensajes a terceros, sin marcarse en línea), pero no lo puede eliminar.
- **Modificar el programa o usarlo mal aumenta la probabilidad de un bloqueo.** Cambios que manden mensajes a otras personas, manden muchos mensajes, automaticen respuestas o cambien la forma en que el cliente se conecta pueden hacer que WhatsApp bloquee tu número. Si modificás el código, el riesgo es tuyo.
- **Tus chats van al LLM que elijas.** Salvo que uses un modelo local (Ollama) o marques una conversación como "solo local", el texto de tus conversaciones se envía al proveedor que configures, bajo sus términos. Algunos planes gratuitos pueden usar ese contenido para mejorar sus productos, incluida la revisión humana.
- **La responsabilidad es tuya** de cumplir los términos de WhatsApp, los de tu proveedor de LLM y la privacidad de las personas que te escriben.

Este proyecto no está afiliado, respaldado ni patrocinado por WhatsApp ni por Meta.

## Hoja de ruta

| Fase | Objetivo |
|---|---|
| 0 | Tests de referencia (golden files) que capturan el comportamiento de la herramienta personal actual del autor, con conversaciones inventadas |
| 1 | Dominio y generación del resumen; fuente de WhatsApp y entrega al chat propio |
| 2 | Daemon, horarios, varias cuentas e importación desde la herramienta personal |
| 3 | Proveedores de LLM (API y CLI), proveedor de respaldo, conversaciones solo locales, transcripción con whisper.cpp y `doctor` |
| 4 | Web local: asistente de primer uso, vinculación por QR, panel, configuración, historial y logs |
| 5 | Empaquetado: imagen de Docker, instaladores nativos para macOS y Linux, servicio del sistema |
| 6 | CI, chequeo de licencias, documentación y primera versión (v0.1.0) |

## Licencia

[MIT](LICENSE)
