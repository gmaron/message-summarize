# message-summarize

[English](README.md)

Lee los mensajes que llegan a tu cuenta de mensajería, los resume con el modelo de lenguaje que elijas y te manda un resumen periódico: qué chats necesitan respuesta, qué quedó pendiente y qué podés ignorar.

La primera plataforma soportada es **WhatsApp**. El núcleo no depende de ella, así que otras plataformas (Telegram, Slack, correo) se pueden sumar más adelante como adaptadores nuevos.

## Estado

**Desarrollo temprano.** Todavía no hay instalador ni interfaz web. Se puede probar una versión de línea de comandos desde el código fuente (ver [Probarlo](#probarlo-versión-temprana)); esperá asperezas. Los requerimientos aprobados están en [docs/requirements.md](docs/requirements.md) y el trabajo se organiza en las fases de la [hoja de ruta](#hoja-de-ruta).

## Probarlo (versión temprana)

**Leé primero el [aviso importante](#aviso-importante): esto usa un cliente no oficial de WhatsApp y tu número puede ser bloqueado.** El programa es de solo lectura: nunca te marca "en línea", nunca responde y nunca manda nada salvo el resumen, que va a tu propio chat ("Mensaje a mí mismo").

Requisitos: Node 22.16 o posterior, y un proveedor de LLM: [Claude Code](https://claude.com/claude-code) con la sesión iniciada en esta máquina (`claude`), un servidor local de [Ollama](https://ollama.com) con un modelo ya descargado, o una clave de API de OpenAI, Anthropic o Gemini (ver [Elegir el proveedor de LLM](#elegir-el-proveedor-de-llm)). No hay proveedor por defecto: lo elegís en la configuración.

```sh
npm install
npm run build
node dist/main/cli.js init      # o `msum init` después de `npm link`; crea el directorio de datos y config.json
```

1. **Editá `config.json`** (en el directorio de datos que muestra `init`; con `MSUM_DATA_DIR` lo ponés en otro lado). No hay proveedor por defecto: `init` escribe `"primary": null` y **tenés que definir `provider.primary` explícitamente** (`"claude-cli"`, `"ollama"`, `"openai"`, `"anthropic"` o `"gemini"`; con todos menos `claude-cli` configurá también el modelo, `provider.<nombre>.model`; ver [Elegir el proveedor de LLM](#elegir-el-proveedor-de-llm)) antes de que funcionen `digest` o los horarios. Revisá también tu `timezone` (`init` imprime la que escribió, la del sistema; **en Docker, definí `TZ` o `timezone` en la configuración**), y tu `ownerName`. Las horas de los digests ya no están en este archivo: mirá `msum schedule` más abajo. Un `promptFile` relativo se lee desde el directorio del archivo que lo define (el directorio de datos para `config.json`, `accounts/<id>/` para el archivo propio de una cuenta). Los valores inválidos se rechazan con un mensaje que nombra la opción.
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

Otros comandos: `msum status` (cuenta, último resumen, envíos pendientes, próximas ejecuciones), `msum doctor` (revisa Node, permisos, configuración, proveedor, vinculación y, si está activada, la transcripción), `msum whisper models|download <nombre>` (mirá [Transcribir notas de voz](#transcribir-notas-de-voz-opcional)) y `msum unlink`, que **borra todos los datos de la cuenta** (sus mensajes, los audios que descargó, el historial de resúmenes, los envíos pendientes y la sesión de WhatsApp; la configuración queda) y pide confirmación. Después, quitá también el dispositivo en el celular (WhatsApp, Ajustes > Dispositivos vinculados).

Todo queda en tu máquina, en el directorio de datos (con permisos solo para tu usuario), salvo lo que recibe el proveedor de LLM que elegiste. Los textos de la línea de comandos están en español o inglés (`language` en `config.json`).

## Transcribir notas de voz (opcional)

Viene desactivada. Cuando está activada, las notas de voz y los audios que llegan **mientras el daemon está conectado**, y los de los **últimos 14 días del historial** que WhatsApp manda al vincular (`historyAudioDays`; los más viejos quedan como `🎤 (audio sin transcribir)`), se descargan de WhatsApp a `accounts/<id>/media/` (directorio 0700, archivos 0600), se transcriben **en tu máquina** con [whisper.cpp](https://github.com/ggml-org/whisper.cpp), y el resumen muestra el texto donde diría `🎤 (audio sin transcribir)`. El audio nunca se envía a ningún servicio. **Lo que se conserva es el texto:** el archivo de audio se borra apenas se transcribe, o falla definitivamente. `msum unlink` borra lo que quede, junto con el resto de la cuenta.

Con la transcripción desactivada, o si falta whisper, ffmpeg o el modelo, **todo lo demás funciona igual** y los audios aparecen como `🎤 (audio sin transcribir)`; `msum doctor` dice qué falta. Un audio que no se puede transcribir queda registrado como fallido y no se reintenta.

**Límites, porque el audio viene de otras personas:**

- Las descargas solo vienen del servidor de medios de WhatsApp, y solo para un mensaje que trae una ruta de medios de WhatsApp común; cualquier otra cosa que el remitente escriba en el mensaje (una dirección, un servidor) se ignora y el audio queda registrado como fallido (`invalid-media-path`).
- Un archivo de más de 25 MB no se descarga; una descarga se corta a los 60 segundos; y los audios que una cuenta guarda en disco no pueden pasar de `maxMediaMb` (500 por defecto; pasado ese límite los nuevos se rechazan, `media-cap`, y `msum doctor` avisa antes).
- **Nada se pierde por un reinicio.** Los audios por descargar esperan en una cola guardada en la base de la cuenta (con lo necesario para descargar cada uno), y el daemon la recorre de a uno, del más viejo al más nuevo: una primera vinculación con cientos de audios solo tarda, y la memoria guarda un audio a la vez. Una descarga cortada por una parada, un reinicio o una conexión caída sigue en la cola y se retoma. Una falla de descarga pasajera se reintenta con espera creciente (30 segundos, luego 1, 2 y 4 minutos: 5 intentos), y después el audio queda registrado como fallido (`download-failed`); un audio pendiente de más de 30 días se abandona (`expired`), igual que un archivo que WhatsApp ya no tiene; uno demasiado grande o una carpeta llena fallan en el acto. La clave para descifrar cada archivo vive solo en esa base mientras espera, y se borra apenas el archivo se guarda o la descarga falla definitivamente; nunca se escribe en los logs.
- Solo se convierten los formatos de audio de WhatsApp (notas de voz Ogg Opus, MP3, M4A/MP4, AAC, AMR). ffmpeg corre con el formato de entrada forzado, solo puede leer un archivo (`-protocol_whitelist file`), lee como máximo 30 minutos (`-t 1800`) y escribe como máximo unos 60 MB (`-fs`).

Para activarla:

1. **Instalá whisper.cpp**, que trae el programa `whisper-cli` (por ejemplo `brew install whisper-cpp` en macOS, o compilalo desde el código fuente siguiendo su README en Linux).
2. **Instalá ffmpeg** (`brew install ffmpeg`, `apt install ffmpeg`...): convierte el audio al formato que lee whisper.
3. **Descargá un modelo:** `msum whisper models` lista los modelos ggml conocidos con su tamaño, y `msum whisper download base` descarga uno en `<directorio de datos>/models/`, mostrando el progreso y verificando un checksum SHA-256 fijado en el programa. Un archivo que no coincide se descarta y no queda nada. `base` y `small` son un buen comienzo para notas de voz; los modelos más grandes son más precisos y más lentos.
4. **Activala** en `config.json` (o en el archivo propio de una cuenta):

   ```json
   "transcription": { "enabled": true, "model": "base", "language": "auto" }
   ```

   | Opción | Por defecto | Qué significa |
   |---|---|---|
   | `enabled` | `false` | Activa la transcripción. |
   | `model` | ninguno | El nombre de un modelo en `<directorio de datos>/models/` (`base`, `small.en`...), o la ruta de un archivo ggml. |
   | `language` | `auto` | `auto` detecta el idioma de cada audio; o un código como `es` o `en`. Cada cuenta puede tener el suyo. |
   | `whisperCommand` | `whisper-cli` | El programa de whisper.cpp (un nombre del `PATH`, o una ruta). |
   | `ffmpegCommand` | `ffmpeg` | El programa ffmpeg. |
   | `timeoutMs` | `300000` | Lo máximo que puede tardar un audio, ffmpeg incluido. Un programa que tarda más se mata. |
   | `historyAudioDays` | `14` | También se descargan y transcriben los audios del historial de los últimos N días. |
   | `maxMediaMb` | `500` | Lo máximo que pueden ocupar juntos los audios descargados de una cuenta, en MB. |

**Un solo whisper a la vez en todo el programa,** sin importar cuántas cuentas haya: los audios se transcriben en segundo plano, en orden, a medida que llegan. Justo antes de cada resumen, los audios de su ventana que todavía esperan se transcriben primero, y el resumen los espera como máximo dos minutos: lo que no está listo sale como sin transcribir y se termina después.

**`msum digest` y el daemon.** Mientras el daemon corre, es el dueño de la transcripción: `msum digest` no ejecuta whisper, solo espera (como máximo los mismos dos minutos) a que el daemon termine los audios de su ventana. Sin daemon, `msum digest` transcribe por su cuenta. Esto vale también para `--dry-run`: una transcripción es un dato capturado, como un mensaje, no un resultado del resumen, así que una vista previa puede guardarla, y aun así no mueve el puntero ni escribe nada en el historial ni en la cola de envío.

Los programas corren sin shell, en un directorio temporal vacío, con un entorno mínimo, y se matan si pasan el tiempo límite. Si al daemon mismo lo matan con `SIGKILL` nadie puede matarlos por él (Node no puede pedirle eso al sistema), así que un audio en curso termina solo; una parada normal (Ctrl+C, `SIGTERM`) sí los mata.

## Elegir el proveedor de LLM

Se elige en `config.json` (o en el archivo propio de una cuenta): `provider.primary` y, opcionalmente, `provider.backup`, que se hace cargo de una conversación cuando falla el principal (un límite de uso que no se levanta a tiempo, una respuesta que no cumple el formato del resumen...). Ambos aceptan `claude-cli`, `gemini-cli`, `codex-cli`, `generic-cli` (ver [Usar una CLI como proveedor](#usar-una-cli-como-proveedor)), `ollama`, `openai`, `anthropic` y `gemini`. **Los proveedores por API no tienen modelo por defecto** (los nombres de los modelos cambian seguido, y uno por defecto desactualizado fallaría más tarde): `provider.<nombre>.model` es obligatorio cuando se usa uno, y la configuración se rechaza sin él.

| Proveedor | Configuración | Se conecta a |
|---|---|---|
| `openai` | `"provider": { "primary": "openai", "openai": { "model": "<modelo>" } }`. También `baseUrl` (por defecto `https://api.openai.com/v1`), `timeoutMs` y `structuredOutput` (`json_schema` por defecto; `json_object` o `prompt` para servidores compatibles que no lo tienen). | `api.openai.com`, o tu `baseUrl` |
| `anthropic` | `"anthropic": { "model": "claude-sonnet-5-5", "effort": "low" }` (o `claude-haiku-5-5`). También `timeoutMs`, `maxTokens` (16000 por defecto: los modelos actuales piensan por defecto y eso cuenta contra el límite) y `effort` (`low`, `medium`, `high`, `xhigh` o `max`; sin definir usa el valor del modelo). `low` conviene para resúmenes: menos costo y latencia. | `api.anthropic.com` |
| `gemini` | `"gemini": { "model": "<modelo>" }`. También `timeoutMs`. | `generativelanguage.googleapis.com` |

`openai` con un `baseUrl` sirve para cualquier servidor con la API Chat Completions (LM Studio, OpenRouter...); para esos la clave es opcional. Un proveedor por API es **externo aunque el servidor esté en `localhost`**: no se puede verificar que una URL se quede en la máquina, así que las conversaciones de `localOnlyPatterns` nunca se le envían. "Solo local" significa **tu servidor de Ollama**: las conversaciones de `localOnlyPatterns` van al Ollama configurado en `provider.ollama.baseUrl` y a nada más. Si esa dirección es de esta máquina (`localhost`, una dirección de loopback como `127.0.0.1`, o `host.docker.internal` para el host de Docker) nada sale de la máquina. Si es otra computadora, los chats sí salen hacia ese servidor, que es tuyo pero no es esta máquina: `msum provider ls` y `msum doctor` lo dicen, y `msum provider use ollama` muestra la información y pide consentimiento. Usá una URL de loopback si lo necesitás en esta máquina.

**Las claves de API nunca van en `config.json`** (una clave escrita ahí se rechaza, con un mensaje que apunta a esta sección). Se guarda con:

```sh
msum secret set openai        # o anthropic, gemini; con --account <id> para una sola cuenta
```

La clave se lee de la entrada (oculta mientras la escribís, o por pipe: `msum secret set openai < clave.txt`), nunca de un argumento, que se vería en `ps` y en el historial de tu shell. Se guarda en `secrets.json` del directorio de datos (`accounts/<id>/secrets.json` con `--account`), con permisos 600, y nunca se imprime ni se escribe en los logs. `msum secret ls` muestra qué proveedores tienen clave y de dónde sale (nunca la clave) y `msum secret rm <proveedor>` quita una. La clave se busca en este orden: **variable de entorno** (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`), luego `accounts/<id>/secrets.json`, luego `secrets.json`. Hay dos claves de OpenAI, para que la verdadera nunca vaya a otro servidor: **`openai`** (`msum secret set openai`, o `OPENAI_API_KEY`) se usa solo cuando el origen de `baseUrl` es exactamente `https://api.openai.com`, y **`openai-compatible`** (`msum secret set openai-compatible`, o `MSUM_OPENAI_API_KEY`) se usa para cualquier otro `baseUrl`. La misma regla vale para los archivos de la cuenta y de la instalación y para el entorno: un servidor compatible nunca recibe la entrada `openai`, y si no necesita clave no se le envía ninguna. `msum secret ls` muestra todas las claves, y `msum doctor` dice cuál va a usar tu configuración, verifica que el modelo esté definido, que haya una clave y que `secrets.json` (el de la instalación y el de cada cuenta) solo lo pueda leer tu usuario, sin conectarse a nada.

Si un proveedor responde "demasiados pedidos", el programa espera el tiempo que indica (`Retry-After`, o el tiempo de espera que Gemini pone en el error) y reintenta; un servidor sobrecargado (503, 529) o un error de red se reintenta con una espera creciente. Cada conversación tiene su propio presupuesto, por defecto 3 reintentos y 120 segundos de espera en total (`provider.retry.maxRetries` y `provider.retry.maxWaitMs`), y la llamada completa, intentos y esperas juntos, no puede pasar de 300 segundos (`provider.retry.maxTotalMs`). Un proveedor que redirige, o que responde con más de 2 MB, hace fallar la llamada: las redirecciones nunca se siguen, porque reenviarían tu chat y tu clave a un servidor que no elegiste. Si no alcanza, esa conversación pasa al proveedor de respaldo si hay uno, y si no el resumen sale con las conversaciones que se pudieron resumir y avisa cuáles quedaron afuera.

**Privacidad: el texto de tus chats sale de tu máquina** hacia el proveedor que elijas, salvo las conversaciones de `localOnlyPatterns` (las resume Ollama). Qué hace cada uno con él, según sus propias páginas (revisalas, los términos cambian):

- **OpenAI:** por defecto los datos de la API no se usan para entrenar sus modelos, y los registros de monitoreo de abuso se guardan hasta 30 días. [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data).
- **Anthropic:** por defecto no entrena con las entradas ni las salidas de sus productos comerciales, la API incluida. [Is my data used for model training?](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)
- **Gemini:** con una clave gratuita (sin facturación), Google puede usar lo que enviás para mejorar sus productos, y revisores humanos pueden leerlo; con facturación activada eso no es lo habitual. **No uses una clave gratuita para chats que no quisieras que alguien lea**, y marcá los chats sensibles como solo locales. [Gemini API data logging and sharing](https://aistudio.google.com/docs/logs-policy).
- **Claude Code (`claude-cli`):** lo que hace Anthropic depende del tipo de cuenta: con un plan de consumo (Free, Pro, Max) tus datos pueden usarse para mejorar sus modelos si esa opción está activada, y se guardan 30 días o 5 años según eso; bajo términos comerciales (Team, Enterprise, API) no se usan para entrenar. [Uso de datos de Claude Code](https://code.claude.com/docs/en/data-usage).

## Usar una CLI como proveedor

Si ya pagás un plan, o no querés sacar una clave de API, un proveedor puede ser un programa de tu máquina que usa la sesión con la que ya iniciaste. Hay tres modos: `claude-cli`, `gemini-cli` y `codex-cli` (presets) y `generic-cli` (cualquier comando). Todas son **externas** igual que las APIs: las conversaciones de `localOnlyPatterns` nunca llegan a ellas.

**La regla (RF-49).** Los chats los escriben otras personas, y una CLI es un agente que puede leer archivos y ejecutar comandos: un texto de un chat podría intentar que lo haga (prompt injection). Por eso un preset de CLI solo se usa cuando se puede **verificar** que corre sin herramientas. Antes de la primera llamada, y en `msum doctor`, el programa ejecuta `<cli> --help` y `<cli> --version` (nunca una llamada al modelo, en un directorio temporal vacío, con el entorno de más abajo) y tienen que figurar todos los flags en los que se apoya el endurecimiento. Si falta uno, el proveedor queda no disponible con el motivo "esta versión de X no se puede ejecutar sin herramientas", y la conversación pasa al proveedor de respaldo. El resultado se recuerda por ruta y fecha de modificación del programa, así que una actualización se vuelve a revisar.

| Preset | Estado | Flags y para qué |
|---|---|---|
| `claude-cli` | habilitado | `claude -p --model <m> --system-prompt <s> --json-schema <schema> --output-format json --tools '' --strict-mcp-config --no-session-persistence --safe-mode --disable-slash-commands`. `-p` es el modo sin interfaz; `--json-schema` fuerza el formato del resumen de forma nativa; `--tools ''` apaga todas las herramientas; `--strict-mcp-config` no carga ningún servidor MCP; `--no-session-persistence` no guarda sesión; `--safe-mode` ignora tus personalizaciones (CLAUDE.md, skills, plugins, hooks, MCP), así que ningún hook recibe el chat; `--disable-slash-commands` apaga comandos y skills. El chat va por stdin, nunca como argumento. |
| `gemini-cli` | **deshabilitado** | Gemini CLI (`-p`, `-o json`) no documenta ningún flag que apague sus herramientas: `--allowed-tools` está obsoleto, `--allowed-mcp-server-names` y `--extensions` solo seleccionan, `--approval-mode plan` es de solo lectura pero igual tiene herramientas (leer archivos, traer páginas web), y las sesiones no se pueden apagar. Existe una política que deniega todo, pero su flag (`--admin-policy`) se documenta sin decir si recibe un archivo o un directorio, y se ignora cuando hay archivos de política en la ubicación del sistema. |
| `codex-cli` | **deshabilitado** | `codex exec --sandbox read-only --ephemeral --ignore-user-config --output-schema <archivo>` restringe lo que los comandos pueden escribir, no guarda sesión y fuerza un esquema, pero la herramienta de shell sigue disponible: la documentación dice que el sandbox limita los "comandos de shell generados por el modelo", no que los quite, y ningún interruptor documentado apaga juntos el shell, MCP y la búsqueda web. |

Un preset deshabilitado hace fallar cada llamada en el acto con ese motivo y `msum doctor` lo dice; no se ejecuta nada. Se habilitarán cuando se pueda verificar en `--help` una forma documentada de apagar las herramientas. Mientras tanto la CLI genérica puede ejecutarlos, con el riesgo de más abajo. Fuentes: la documentación de [Claude Code](https://code.claude.com/docs/en/network-config), [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md) y [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

**Qué recibe la CLI.** Solo estas variables, cuando están definidas, y nunca una de tus claves de API: `PATH` (para encontrar el programa y su runtime), `HOME`, `USER` y `LOGNAME` (para encontrar tu sesión existente), `CLAUDE_CONFIG_DIR` (una sesión guardada en otro lado; solo Claude), `LANG` y `TZ`. Las variables de proxy y certificados no se pasan: definilas donde la propia CLI las lee. Corre sin shell, en un directorio temporal nuevo y vacío que se borra después, con un tiempo límite que mata todo el grupo de procesos (nietos incluidos), y como máximo 2 MB de salida.

**Iniciar sesión.** La CLI usa la sesión que ya iniciaste para ella. Dentro de un contenedor Docker o sandbox la sesión se inicia adentro, una vez, y se guarda en un volumen: para Claude, ejecutá `claude` en el contenedor (por ejemplo `docker exec -it <contenedor> claude`, o `sbx claude` si usás `sbx`), iniciá sesión y guardá su directorio de configuración (`~/.claude`, o el de `CLAUDE_CONFIG_DIR`) en un volumen para que el daemon lo vea.

**El formato de la respuesta (RF-48).** `claude-cli` fuerza el esquema con `--json-schema`; si aun así la respuesta no sirve, se le pide una vez más que la corrija. A una CLI sin flag de esquema nativo (la genérica) se le pone el esquema en el prompt, la respuesta se valida y, si es inválida, se le pide UNA vez más con un mensaje que dice qué estaba mal; si falla otra vez, la conversación pasa al proveedor de respaldo (RF-42).

**La CLI genérica** (`generic-cli`) ejecuta cualquier comando que reciba el prompt e imprima texto con la respuesta:

```json
"provider": {
  "primary": "generic-cli",
  "genericCli": { "command": ["mi-llm", "--json", "{{prompt}}"], "timeoutMs": 180000, "acknowledgeRisk": true }
}
```

`command` es una lista de argumentos, sin shell y sin interpolación dentro de un elemento. **Por defecto el prompt va por stdin, que es privado.** Un elemento que es exactamente `{{prompt}}` recibe en cambio el prompt completo: usalo solo para una herramienta que no puede leer stdin, porque **los argumentos los ven otros usuarios de la máquina** (`ps`) y un chat largo puede pasar el límite de tamaño de los argumentos; `msum doctor` avisa cuando el comando lo usa. `{{prompt}}` nunca es el programa ni parte de un elemento más largo. No hay comando por defecto. **No se puede endurecer:** el comando puede ejecutar herramientas sobre texto escrito por terceros, así que se rechaza salvo que pongas `acknowledgeRisk` en `true`; `msum doctor`, `msum digest` y el daemon imprimen este aviso cada vez que está por usarse. Preferí un proveedor que corre sin herramientas.

## Elegir y probar tu proveedor

Cuatro comandos, en este orden (agregá `--account <id>` cuando hay más de una cuenta):

1. **`msum provider ls`** lista cada proveedor con cuánto cuesta (una API cobra por uso, una CLI usa tu plan, Ollama es gratis), si tus chats salen de la máquina y hacia qué servidores, un enlace a su política de datos, si está configurado acá (principal o respaldo), si su clave está presente (de dónde sale, nunca la clave) y si es usable ahora (las CLIs se verifican, los presets deshabilitados lo dicen). No hace ninguna llamada de red.
2. **`msum provider use <nombre> [--model <m>] [--backup] [--yes]`** elige el proveedor y su modelo. Escribe `provider.primary` (o `provider.backup`) en el `config.json` de la cuenta, que crea si hace falta, y **dice qué archivo escribió**. Nunca escribe el `config.json` de la instalación, ni siquiera con una sola cuenta: el consentimiento de más abajo es por cuenta, así que el proveedor que cubre también tiene que serlo (una cuenta vinculada después heredaría, si no, un proveedor externo que nunca vio explicado). Conserva todas las demás claves, escribe de forma atómica y valida el resultado antes: un resultado inválido no escribe nada. **Antes de activar un proveedor que envía tus chats afuera te dice qué recibe** (el texto de las conversaciones que no son solo locales, los nombres de los chats y contactos como aparecen en ellos, los números de teléfono de los contactos que no guardaste, las transcripciones de las notas de voz, y tu nombre como dueño), hacia qué servidores y dónde está su política, y te pide confirmar; `--yes` salta la pregunta, no la información. **Tu respuesta queda registrada** (RNF-02) para esa cuenta, con la fecha y los servidores que se mostraron: un servidor distinto, por ejemplo otro `--base-url` u otra dirección de Ollama, necesita un consentimiento nuevo, y para `generic-cli` el consentimiento se asocia al comando que se mostró, así que cambiar el comando pide uno nuevo. `msum provider ls` muestra la fecha (o "ninguno registrado"), y `msum doctor` avisa, sin bloquear nada, cuando un proveedor elegido que envía tus chats afuera no tiene consentimiento registrado. El consentimiento es un registro y un recordatorio, no un candado: editar `config.json` a mano es el camino experto y sigue funcionando (una instalación configurada así, por ejemplo con `claude-cli`, anda como antes); el camino guiado es el que lo registra, y `doctor` hace visible la falta. Borrar la cuenta (`msum unlink`) borra sus consentimientos. Rechaza `gemini-cli` y `codex-cli` (deshabilitados), y para `generic-cli` explica `acknowledgeRisk`, que ponés vos y él nunca pone. `openai-compatible` necesita `--base-url <url>`.
3. **`msum secret set <nombre>`** guarda la clave de API cuando el proveedor la necesita (ver [Elegir el proveedor de LLM](#elegir-el-proveedor-de-llm)). `provider use` nunca toca las claves; te avisa cuando falta una.
4. **`msum provider test [--backup] [--kind <nombre>]`** es el "probar conexión": UNA llamada real al proveedor, con una **conversación inventada** incluida en el programa (nombres inventados), nunca tus mensajes. Antes de la llamada dice adónde va. Muestra la latencia y un resumen de la respuesta validada, o el error (sin ninguna clave) y una pista: falta la clave, la clave fue rechazada, el modelo no existe, un límite de uso, un tiempo agotado, un preset deshabilitado, una CLI que no se puede verificar, o un servidor al que no se llega. Código de salida 0 si anda, 1 si no. `msum doctor` nunca llama a un proveedor; te manda acá.

Las configuraciones habituales:

- **Claude Code con tu plan (sin clave):** `msum provider use claude-cli`, iniciá sesión una vez con `claude` (dentro de un contenedor, ver [Usar una CLI como proveedor](#usar-una-cli-como-proveedor)), y después `msum provider test`.
- **API de Anthropic:** `msum provider use anthropic --model claude-sonnet-5-5`, `msum secret set anthropic`, `msum provider test`.
- **OpenAI:** `msum provider use openai --model <modelo>`, `msum secret set openai`, `msum provider test`. Para LM Studio, OpenRouter y parecidos: `msum provider use openai-compatible --base-url <url> --model <modelo>`, y `msum secret set openai-compatible` si necesita clave.
- **Gemini, plan gratuito:** `msum provider use gemini --model <modelo>`, `msum secret set gemini`, `msum provider test`. Google puede usar una clave gratuita para mejorar sus productos: mirá la nota de privacidad de arriba, y marcá los chats sensibles como solo locales.
- **Ollama, todo en tu máquina:** `ollama pull <modelo>`, `msum provider use ollama --model <modelo>`, `msum provider test`. Con Ollama en esta máquina nada sale de ella, así que no pregunta nada; con `provider.ollama.baseUrl` en otra computadora muestra la información y pregunta, como cualquier proveedor que recibe tus chats.

Agregá un segundo como respaldo con `--backup`, por ejemplo `msum provider use ollama --backup --model <modelo>`.

## Elegir un modelo local (Ollama)

Un modelo chico, de 3 a 8 mil millones de parámetros, puede resumir en tu propia máquina. Cuál conviene depende de la RAM y de qué tan bien hace el trabajo, así que el programa tiene una tabla de candidatos y una forma de medirlos (RF-45).

**La recomendación que viene hoy es provisoria.** Ningún candidato fue evaluado todavía contra las conversaciones de referencia, así que `msum ollama recommend` elige el candidato más grande que entra en tu RAM, lo dice claramente y marca todos como "sin evaluar". Deja de ser provisoria solo cuando se sube una evaluación que cumple (ver abajo).

- **`msum ollama recommend`** lee la RAM de esta máquina y lista los candidatos (tag, parámetros, tamaño de descarga, RAM mínima; los que entran van marcados con `*`), y después recomienda uno y los comandos para usarlo. No hace ninguna llamada de red. La tabla está en `src/infrastructure/llm/ollama-candidates.ts`: los tags, parámetros y tamaños salen de las páginas de la biblioteca de Ollama (leídas el 2026-11-17, listadas en ese archivo). La **RAM mínima es una estimación** (tamaño de descarga por 1,25 más 3 GB), no un número que publique Ollama. Los candidatos son `qwen3.5:4b`, `qwen3:4b`, `qwen3:8b`, `qwen2.5:3b`, `qwen2.5:7b`, `gemma3:4b`, `gemma4:e4b`, `llama3.2:3b`, `llama3.1:8b` y `phi4-mini:3.8b`; en la biblioteca aparecen tags nuevos todo el tiempo, así que revisala y editá la tabla.
- **`msum ollama pull <tag> [--account <id>]`** le pide al Ollama configurado en `provider.ollama.baseUrl` que descargue el modelo (su `/api/pull`), con una línea de progreso y la verificación de que Ollama termine con `success`. Envía solo el tag, nunca texto de chats, y **solo funciona contra un Ollama en esta máquina** salvo que agregues `--allow-remote` (el modelo se descarga en el servidor que recibe el pedido, así que hacerlo en otra computadora tiene que ser una decisión). Los errores del servidor se muestran sin texto con forma de clave. Después elegilo con `msum provider use ollama --model <tag>` y probalo con `msum provider test`.
- **`msum doctor`** también le pide a tu Ollama su lista de modelos (`/api/tags`, 3 segundos, sin texto de chats) cuando Ollama es el principal, el respaldo o atiende tus chats "solo locales", y falla si el modelo configurado no está instalado, con el comando `msum ollama pull` para arreglarlo. `msum doctor --skip-model-check` se salta esa llamada (la revisión de que Ollama responda es aparte y se mantiene).

### Evaluar un modelo

`npm run eval:ollama -- --models qwen3:4b,gemma3:4b [--base-url URL] [--runs N] [--allow-remote]`

El conjunto de evaluación está en `test/eval/ollama/`: **81 conversaciones tomadas de los golden files** (todas inventadas), cada una con el texto exacto que recibe el resumidor (`transcripts.json`, generado por `test/eval/extract-cases.mjs`) y una **etiqueta escrita a mano** de si el dueño tiene que responder, con el motivo en una línea (`labels.json`; `doubtful` marca las que un lector podría discutir). Las respuestas de la herramienta anterior se usaron solo para contrastar, nunca como verdad. Para cada modelo y caso el script llama al `OllamaSummarizer` real con el prompt y el esquema de producción y registra si el JSON fue válido, si "necesita respuesta" coincide con la etiqueta (una respuesta inválida cuenta como diferencia), la latencia y el error. Imprime una tabla y escribe `test/eval/ollama/results/<fecha>-<modelo>.json` (ids y números, sin texto de chats).

La regla de etiquetado está escrita en `test/eval/ollama/README.md` (en inglés). **El JSON válido se juzga en todos los casos; la coincidencia se juzga solo en los casos claros** (los que no están marcados `doubtful` ni son los seis casos de relleno marcados `jsonOnly`, que cuentan para el JSON válido y no para la coincidencia). La coincidencia en los casos dudosos y la general se imprimen y guardan como columnas aparte, a modo informativo. Los archivos de resultados subidos a `test/eval/ollama/results/` no se ignoran: son los que promueven a un candidato a evaluado.

**Un modelo cumple RF-45 con 100% de JSON válido y al menos 90% de coincidencia en "necesita respuesta" (casos claros).** El script termina con 1 si un modelo no cumple. Rechaza un `--base-url` que no esté en esta máquina salvo que pases `--allow-remote`. Necesita tu propio Ollama corriendo con los modelos ya descargados; nunca arranca uno.

Para registrar un modelo que cumple, poné `evaluated: true` y `result: { date, validJsonRate, needsReplyAgreement }` en su entrada de `ollama-candidates.ts` (el script imprime la línea) y subilo junto con el archivo de resultados; un test falla si un resultado subido dice que un modelo cumplió y la tabla no. Desde ahí `recommend` elige entre los modelos que cumplieron y deja de llamar provisoria a su elección.

## A qué se conecta el programa

No se envía nada a ningún lado salvo:

- **WhatsApp**, por la conexión de tu propia cuenta (incluida la descarga de los audios que recibís, cuando la transcripción está activada).
- **El proveedor de LLM que elegiste**, y nada más: con Ollama, la URL que configuraste; con un proveedor por API, exactamente uno entre `api.openai.com` (o tu `provider.openai.baseUrl`), `api.anthropic.com` o `generativelanguage.googleapis.com`. **El texto de las conversaciones que no son solo locales se envía ahí**, junto con tu prompt de resumen. Las claves viajan solo en los encabezados del pedido.
- **Con `claude-cli`, lo que contacta el propio Claude Code**, que son los servidores de su fabricante, según [su documentación de red](https://code.claude.com/docs/en/network-config): `api.anthropic.com` (los pedidos al modelo, que llevan el texto de las conversaciones que no son solo locales, y su propia telemetría operativa), `claude.ai`, `claude.com`, `platform.claude.com` y `sso.claude.com` (inicio de sesión), y `http-intake.logs.us5.datadoghq.com` y `browser-intake-us5-datadoghq.com` (telemetría opcional de la CLI, que su configuración puede apagar: `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). Ese tráfico es de la CLI, no de este programa, y el programa no le pasa esas variables: definilas en el archivo de configuración de Claude Code. `gemini-cli` y `codex-cli` están deshabilitados y no contactan nada. Un comando de `generic-cli` contacta lo que haga.
- **Tu propio servidor Ollama, cuando corrés `msum ollama pull <tag>` o `msum doctor`:** el tag a descargar, o un pedido de su lista de modelos, a la URL de `provider.ollama.baseUrl` y a ningún otro lado; sin texto de chats. La descarga la hace Ollama, no este programa.
- **Hugging Face, solo cuando corrés `msum whisper download <nombre>`:** el modelo se baja del repositorio oficial de whisper.cpp, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<nombre>.bin` Hugging Face responde con una redirección a su red de contenido: un pedido a esa URL termina en **`us.aws.cdn.hf.co`** (verificado con un pedido `HEAD` al escribir esto). El programa sigue las redirecciones por su cuenta, de a una, y solo hacia direcciones `https` de `huggingface.co` o `*.hf.co`; cualquier otro servidor se rechaza. Solo se envía el pedido de ese archivo, y el **checksum (SHA-256) y el tamaño de cada modelo están fijados en el programa**: un archivo que no coincide se descarta.

No hay telemetría, y la transcripción nunca abre una conexión de red.

## Importar desde la herramienta anterior

Si usabas la instalación anterior de esta idea (la herramienta summaryzing-whatsapp), `msum import --from <ruta>` la trae sin volver a escanear el QR. Solo **copia**: la instalación anterior nunca se modifica, así que queda como camino de vuelta.

- **Qué toma:** la sesión de WhatsApp (byte por byte, privada: directorio 0700, archivos 0600), los mensajes con sus ediciones, transcripciones y marcas de leído, el estado de no leídos de cada chat, los contactos y sus nombres, el puntero del último digest (para que el primer digest no vuelva a resumir el pasado), la configuración (traducida a las opciones de este programa, escribiendo solo lo que difiere de tu `config.json`) y el prompt (`{{nombre}}` pasa a `{{name}}`). La cuenta queda atada al número de la sesión, así que los digests solo van al chat propio de ese número.
- **Qué no toma, y lo dice:** los archivos de audio e imagen (solo sus textos y transcripciones), el texto leído de las imágenes, los errores de transcripción, los digests que esperaban en la cola de envío, los archivos de digests guardados, las opciones sin equivalente acá (lectura de imágenes, Whisper, la web) y su estado interno. Se cuentan en el resumen.
- **Horarios:** la herramienta anterior los guardaba fuera de sus datos (el cron de su sandbox, o launchd), así que no se pueden leer de la carpeta. Pasá las horas con `--schedule 07:00,19:00`, o agregalas después con `msum schedule add`.
- **Qué cuenta:** `--account <id>` (por defecto `default`) nombra la cuenta de la instalación principal. `--instance <nombre>` importa una de sus instancias (`instancias/<nombre>/`, otro celular) con ese nombre, y `--all` importa la instalación principal y todas las instancias, cada una como su propia cuenta.
- **Antes de correrlo, detené la herramienta anterior.** La misma sesión de WhatsApp no puede correr en dos lugares a la vez, o WhatsApp desconecta a una. El comando te avisa y pide confirmación (o `--yes`), y se niega mientras la herramienta anterior parezca estar corriendo (no guarda ningún archivo de bloqueo, así que se deduce, solo de los metadatos de los archivos): un `whatsapp.db-wal` o `-shm` junto a su base (SQLite los borra cuando se cierra la última conexión), su base escrita en el último minuto, o sus archivos de sesión escritos en los últimos diez minutos. El mensaje dice qué señal saltó; detener la herramienta anterior las hace desaparecer, y `--force` se salta la comprobación (el aviso y la pregunta quedan). Si corren las dos, el daemon bloquea la cuenta como `replaced` (mirá `msum retry`) en vez de pelear por ella.
- **Seguro de correr:** se niega con una cuenta que ya está vinculada o tiene datos (desvinculala antes) o que el daemon en marcha está usando, y es todo o nada por cuenta: arma todo aparte y lo mueve a su lugar con un solo rename, así que una falla no deja cuenta ni archivos. Al terminar abre lo que armó, sin conexión, e imprime un resumen con el número enmascarado.

- **Dónde están sus datos:** si la herramienta anterior guardaba sus datos en otro lugar (`WA_DATA_DIR`), la importación se niega y lo dice; indicalo con `--data <dir>` (solo se lee). `--session-only` trae solo la sesión, la configuración y el prompt, sin mensajes.
- **Las listas de privacidad nunca se descartan en silencio:** tus chats de `excluir` no se guardan acá (RF-14; el resumen cuenta lo que quedó afuera), y si `soloLocal` (chats que nunca deben salir de tu computadora) no se puede importar, por ejemplo porque no hay modelo de Ollama, se rechaza toda la importación y dice qué arreglar.
- **Caídas:** la importación trabaja en un directorio oculto `accounts/.import-*` con un archivo de pid; el que deja una caída lo borra la próxima importación o el arranque del daemon, y `msum doctor` lo informa (tiene una copia de una sesión). Mientras la importación corre, el bloqueo de la cuenta viaja con ella, así que un daemon en marcha nunca arranca la cuenta a medias.

Después comprobalo con `msum digest --dry-run --account <id>` y arrancá el daemon.

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
