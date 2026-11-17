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

1. **Editá `config.json`** (en el directorio de datos que muestra `init`; con `MSUM_DATA_DIR` lo ponés en otro lado). No hay proveedor por defecto: `init` escribe `"primary": null` y **tenés que definir `provider.primary` explícitamente** (`"claude-cli"` u `"ollama"`; con Ollama configurá también `provider.ollama.model`) antes de que funcionen `digest` o los horarios. Revisá también tu `timezone` (`init` imprime la que escribió, la del sistema; **en Docker, definí `TZ` o `timezone` en la configuración**), y tu `ownerName`. Las horas de los digests ya no están en este archivo: mirá `msum schedule` más abajo. Un `promptFile` relativo se lee desde el directorio del archivo que lo define (el directorio de datos para `config.json`, `accounts/<id>/` para el archivo propio de una cuenta). Los valores inválidos se rechazan con un mensaje que nombra la opción.
2. **`msum link`** muestra un código QR en la terminal (también queda como `qr.png` mientras es válido). Escaneálo desde WhatsApp, Ajustes > Dispositivos vinculados. Espera el historial inicial y termina.
3. **`msum daemon`** conecta todas las cuentas, captura los mensajes, ejecuta los horarios y entrega cada resumen al chat propio de esa cuenta. Dejalo corriendo (Ctrl+C lo detiene de forma ordenada). Corre un solo daemon por instalación, y corre TODAS las cuentas: cada una está aislada (su propia conexión, horarios, recuperación de ejecuciones perdidas y entrega), así que una cuenta bloqueada o que falla no detiene a las otras; una falla dentro de una cuenta reinicia solo esa cuenta, con una espera creciente. `msum daemon --account <id>` corre solo esa cuenta: sirve para depurar. Si WhatsApp cierra una sesión, rechaza la conexión (403) o la reemplaza, o la sesión es de otro número, el daemon deja de conectar ESA cuenta, escribe `accounts/<id>/blocked.json` y la deja inactiva (así un gestor de servicios que reinicia el daemon no reconecta en bucle, algo que podría hacer bloquear el número). Una cuenta sin nada vinculado también queda inactiva: no se abre ninguna conexión para ella. `msum status` muestra el motivo, y el estado de la conexión de cada cuenta mientras el daemon corre. Para arreglar un bloqueo: `msum retry --account <id>` si la conexión fue rechazada o reemplazada (el daemon en marcha vuelve a tomar la cuenta en pocos segundos), o vincular de nuevo si la sesión no sirve (`msum unlink --account <id>` y después `msum link --account <id>`). `msum daemon --retry` borra, antes de arrancar, exactamente los bloqueos que borra `msum retry` (una sesión muerta sigue bloqueada). Un bloqueo nunca se levanta solo: que falte `blocked.json` cuenta como "borrado" solo si el daemon sabe que estuvo en disco. Si la conexión de una cuenta sigue fallando (5 fallas seguidas, con esperas crecientes, y una unidad que se mantiene conectada 10 minutos reinicia la cuenta), el daemon deja de intentar y la bloquea (`socketFailed`) en vez de entrar en un bucle; `msum retry` la devuelve. Una cuenta con la configuración inválida, o con horarios y sin proveedor, se avisa y queda inactiva mientras las otras cuentas corren (el daemon se niega a arrancar solo si `--account` nombra una cuenta así, o si todas lo están).

El daemon sigue mirando la instalación mientras corre: una cuenta que vinculás después arranca sola, una que se borra se detiene, y un bloqueo borrado se reintenta. Podés correr `msum link --account <id-nuevo>` con el daemon corriendo: la cuenta queda bloqueada para el daemon mientras se vincula (`accounts/<id>/link.lock`), y el daemon la arranca recién cuando termina la vinculación. `msum link` y `msum unlink` rechazan una cuenta que el daemon está usando (vinculada y sin bloqueo), porque es dueño de su sesión: detené el daemon primero. Las cuentas que no usa (sin vincular, o bloqueadas) se pueden vincular o desvincular con el daemon corriendo.

Una instalación puede tener varias cuentas: `msum link --account trabajo` crea y vincula una (los ids son letras minúsculas, dígitos y guiones), `msum accounts` las lista, y `link`, `unlink`, `digest`, `daemon`, `status` y `doctor` aceptan `--account <id>` (opcional mientras haya una sola cuenta; `status` y `doctor` recorren todas las cuentas sin él). Cada cuenta puede tener su propio `config.json` en `accounts/<id>/` que pisa al del directorio de datos: sus opciones de primer nivel reemplazan a las de la instalación, `provider` se combina clave por clave, y las listas de privacidad `localOnlyPatterns` y `excludePatterns` se suman a las de la instalación (nunca las reemplazan), así que una cuenta solo puede volverlas más estrictas. `msum unlink --account trabajo` borra solo los datos de esa cuenta. Una instalación anterior a esta estructura (`account/`) se mueve sola a `accounts/default/`, sin ningún daemon corriendo.
**Horarios.** Cada cuenta corre sus digests en días de la semana a una hora local, guardados en la base de datos y manejados con `msum schedule` (agregá `--account <id>` cuando hay más de una cuenta):

- `msum schedule ls` los lista con su id, días, hora y próxima ejecución en la zona horaria de la cuenta.
- `msum schedule add --time 09:00 [--days daily|weekdays|weekends|mon,wed,fri|mon-fri]` agrega uno (todos los días si no ponés `--days`). Los nombres de los días valen en inglés y en español (`lun`, `mar`, `mie`/`mié`, `jue`, `vie`, `sab`/`sáb`, `dom`).
- `msum schedule rm <id>` borra uno de los horarios de esa cuenta. Para cambiar una hora, borrala y agregá la nueva.

Un daemon en marcha toma los cambios en unos cinco segundos, sin reiniciar. Estos comandos funcionan con el daemon corriendo. Las horas siguen la `timezone` de la cuenta y sus cambios de horario de verano: una hora que no existe el día del cambio corre en la primera hora válida posterior, y una hora que ocurre dos veces corre una sola vez. Una ejecución perdida (la máquina estaba apagada) se recupera una sola vez al arrancar el daemon. `msum init` no escribe horarios y una cuenta nueva empieza sin ninguno, así que no corre ningún digest por su cuenta hasta que agregues uno (`msum link` y `msum doctor` te lo recuerdan). Para las configuraciones escritas por versiones anteriores, la opción `schedules` de `config.json` (expresiones cron, en el archivo de la instalación o en el de una cuenta) se sigue importando una sola vez por cuenta, la primera vez que se usa la cuenta: las horas que se pueden expresar (una hora fija en cualquier día de la semana) pasan a ser horarios; las demás no se importan y `msum doctor` las lista como aviso. Después la opción se ignora (`doctor` avisa, y podés borrarla), así que un horario que borrás no vuelve, y `config.json` nunca se reescribe. La opción acepta cualquier lista de textos, así que un valor viejo nunca impide que la configuración cargue.

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
