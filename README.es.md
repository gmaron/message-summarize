# message-summarize

[English](README.md)

Lee los mensajes que llegan a tu cuenta de mensajería, los resume con el modelo de lenguaje que elijas y te manda un resumen periódico: qué chats necesitan respuesta, qué quedó pendiente y qué podés ignorar.

La primera plataforma soportada es **WhatsApp**. El núcleo no depende de ella, así que otras plataformas (Telegram, Slack, correo) se pueden sumar más adelante como adaptadores nuevos.

## Estado

**En diseño. Todavía no se puede usar.** No hay ninguna versión instalable. Este repositorio tiene los requerimientos aprobados ([docs/requirements.md](docs/requirements.md)) y el esqueleto del proyecto. El código se va a escribir en las fases de la [hoja de ruta](#hoja-de-ruta).

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
