# message-summarize: requerimientos

Versión 1.4 · 2026-11-19 · Estado: aprobado

## 1. Propósito

**message-summarize** lee los mensajes que llegan a una cuenta de mensajería, los resume con un modelo de lenguaje y entrega un resumen periódico ("digest") que dice qué chats necesitan respuesta, qué pendientes quedaron y qué se puede ignorar.

La primera plataforma soportada es **WhatsApp**. El núcleo no depende de ella: WhatsApp es una *fuente* (de donde salen los mensajes) y un *destino* (adonde va el digest). Telegram, Slack o el correo se agregan más adelante como adaptadores nuevos, sin tocar el dominio.

### 1.1 Objetivos

| ID | Objetivo | Cómo se mide |
|---|---|---|
| OBJ-1 | Que alguien sin conocimientos técnicos lo instale y reciba su primer digest | Desde cero hasta el primer digest en menos de 10 minutos, sin usar la terminal después del instalador |
| OBJ-2 | Que los datos queden bajo control del usuario | Los mensajes se guardan solo en la máquina; nada sale hacia afuera salvo hacia el proveedor de LLM que el usuario eligió, y eso se informa en la interfaz |
| OBJ-3 | Que el digest sea útil | Mismo resultado que la herramienta personal actual con los mismos datos (golden files de la fase 0) |
| OBJ-4 | Que se pueda sumar otra plataforma sin reescribir | Agregar una fuente nueva solo requiere implementar los puertos `MessageSource` y, si corresponde, `DeliveryChannel` |
| OBJ-5 | Que el proyecto sea mantenible por terceros | TypeScript estricto, CI en verde, cobertura del dominio de 90% o más |

### 1.2 Alcance de la v1

**Incluye:** una fuente (WhatsApp por Baileys), un destino (el chat propio de WhatsApp), varias cuentas por instalación, proveedores de LLM a elección del usuario (OpenAI, Anthropic, Gemini y Ollama), transcripción de audios local y opcional, web local, CLI, horarios configurables e instalación con Docker (`docker compose up`) y nativa en macOS, Linux y Windows (instalador `.exe` e `install.ps1`).

**No incluye:** otras plataformas de mensajería, responder mensajes en nombre del usuario, envío a terceros, mandar el digest de una cuenta a otra cuenta (cada digest es personal y solo lo recibe la cuenta resumida), acceso remoto a la web (fuera de la red local), app móvil, sincronización entre máquinas, modo multiusuario ni servicio en la nube.

## 2. Glosario

| Término | Significado |
|---|---|
| Cuenta | Una cuenta vinculada en una plataforma (por ejemplo, un número de WhatsApp). Una instalación puede tener varias |
| Fuente | Adaptador que obtiene mensajes de una plataforma (`MessageSource`) |
| Destino | Adaptador que entrega el digest (`DeliveryChannel`). En la v1, el chat "Mensaje a mí mismo" de la misma cuenta |
| Conversación | Un chat individual o un grupo |
| Digest | El resumen de todas las conversaciones de una ventana de tiempo, ordenado por secciones |
| Ventana | El intervalo de tiempo que cubre un digest. Arranca donde terminó el anterior (puntero) |
| Horario | Una regla que dispara un digest (por ejemplo, "lun a vie 9:00") |
| Proveedor | El LLM que resume. Hay dos formas de conectarlo: por **API** (OpenAI, Anthropic, Gemini u Ollama local, con clave de API) o por **CLI** (el programa de línea de comandos del proveedor, como Claude Code, Gemini CLI o Codex, con la sesión que el usuario ya tiene iniciada) |
| Solo local | Conversación que se resume únicamente con un proveedor que corre en la máquina |
| Daemon | El único proceso de larga duración que mantiene conexiones, planifica y sirve la web |

## 3. Usuarios

- **Usuario final:** recibe muchos mensajes y quiere saber qué atender. Usa la web y no tiene por qué saber qué es un cron.
- **Usuario técnico:** prefiere Docker o la CLI, usa Ollama, edita el prompt.
- **Contribuidor:** agrega una plataforma o un proveedor. Necesita puertos claros y tests de contrato.

## 4. Requerimientos funcionales

Prioridad: **v1** (necesario para la v0.1.0) o **Luego**. Cada requerimiento tiene un criterio de aceptación verificable.

### 4.1 Cuentas y vinculación

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-01 | Vincular una cuenta de WhatsApp escaneando un QR desde la web | v1 | El QR aparece en la web en menos de 5 s y se renueva solo cuando vence; al escanearlo, la cuenta pasa a "conectada" sin recargar la página |
| RF-02 | Mostrar el progreso de la sincronización inicial | v1 | Barra de progreso con porcentaje, cantidad de chats y de mensajes guardados, actualizada en vivo (SSE). Al terminar, indica "sincronización completa" |
| RF-03 | Manejar varias cuentas en una misma instalación | v1 | Se pueden vincular dos cuentas o más; cada una tiene sus datos, configuración, horarios y digest separados. Borrar una cuenta elimina solo sus datos |
| RF-04 | Mostrar el estado de cada cuenta | v1 | Estados: conectada, reconectando, sesión cerrada, error. Si la sesión se cierra desde el celular, la web lo avisa y ofrece volver a vincular |
| RF-05 | Reconectar solo ante cortes | v1 | Tras un corte de red, la cuenta vuelve a "conectada" sin intervención y sin perder los mensajes recibidos mientras tanto (los que la plataforma reenvía) |
| RF-06 | Importar una instalación de la herramienta personal anterior | v1 | `message-summarize import --from <ruta>` toma la sesión, la base y la configuración, y la cuenta queda conectada sin escanear el QR otra vez |
| RF-07 | Agregar otras plataformas (Telegram, Slack, correo) | Luego | Una plataforma nueva se suma implementando `MessageSource` y pasando sus tests de contrato |

### 4.2 Captura de mensajes

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-10 | Guardar los mensajes entrantes y salientes de todas las conversaciones | v1 | Se guardan texto, imagen, video, audio, documento, sticker, ubicación, contacto, encuesta y evento, con una representación de texto para cada tipo. Un mensaje sin texto que no es audio aparece en la transcripción con la representación de su tipo (por ejemplo, "[imagen]"), en grupos y en chats individuales, y nunca hace fallar el digest |
| RF-11 | Registrar las ediciones de mensajes | v1 | Un mensaje editado reemplaza al original en el digest |
| RF-12 | Llevar el estado de no leídos por conversación | v1 | El contador refleja lo que muestra el celular: se toma en la sincronización inicial, se actualiza al leer desde cualquier dispositivo, y marcar como no leído en el celular vuelve a incluir el chat. La foto inicial no pisa lo que llegó en vivo |
| RF-13 | Resolver la identidad de los remitentes | v1 | Se muestra el nombre de la agenda si existe; si no, el nombre público y el número con espacios (para poder tocarlo en WhatsApp Web). Los identificadores internos (LID) se traducen a número cuando es posible |
| RF-14 | Excluir conversaciones | v1 | Una conversación excluida (por nombre o identificador) no se guarda ni se resume. Sin exclusiones configuradas no se excluye nada: la falta de la opción no hace fallar ni la captura ni el digest |
| RF-15 | Descargar los audios para transcribirlos | v1 | Los audios de los últimos N días del historial (configurable, 14 por defecto) y todos los que llegan en vivo se descargan si la transcripción está activa |
| RF-16 | Pedir el historial completo al vincular (opt-in) | v1 | La opción `fullHistoryOnLink` (por cuenta, `false` por defecto) hace que el celular mande todo su historial al vincular. Es una excepción aprobada a RNF-17. Todos los tipos de sincronización de historial que entrega la plataforma (inicial, reciente, completo, bajo demanda, nombres) se guardan como historial, sin filtrar; el progreso se registra como `history.progress` con solo cantidades (bloques, mensajes, chats) |
| RF-17 | Conservar el contenido original de cada mensaje | v1 | Cada mensaje guarda en `messages.raw` el contenido decodificado como JSON (con los descriptores de los archivos: `directPath`, `mediaKey`, `url`, `mimetype`, `fileLength`, `seconds`, `fileSha256`, `fileEncSha256`), para poder armar reglas sobre cualquier tipo de mensaje más adelante. Se descartan las miniaturas y nunca se guardan claves de sesión o identidad de Signal |
| RF-18 | Modelar el contenido por tipo | v1 | Se guardan en columnas y tablas propias: a qué mensaje responde (`quoted_*`, incluido si es una respuesta a un estado), si fue reenviado y si es de ver una vez; archivos (`media`), ubicaciones (`locations`), contactos compartidos (`shared_contacts`, uno por contacto), encuestas (`polls`; los votos llegan cifrados y se guardan tal cual en `poll_votes`), pedidos y productos de WhatsApp Business (`orders`, `products`, con los tipos de mensaje `order` y `product`) y reacciones (`reactions`). Las reacciones y los votos no son mensajes: no aparecen en digests ni transcripciones. La transcripción muestra de forma compacta la respuesta a un estado (\"[respondió a tu estado: imagen «…»]\") y el mensaje citado de una respuesta solo si es corto |
| RF-19 | Registrar los mensajes que no se pueden descifrar | v1 | Un mensaje que llega sin contenido se cuenta (`droppedNoMessage`) y se registra como máximo un aviso `capture.undecryptable` por minuto, con la cantidad y sin identificadores |

### 4.3 Transcripción de audios

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-20 | Transcribir audios localmente con whisper.cpp | v1 | La transcripción reemplaza al "[audio]" en el digest. Nunca se envía audio a un servicio externo |
| RF-21 | Activar o desactivar la transcripción | v1 | Si está desactivada o falta whisper, el producto funciona igual y los audios aparecen como "[audio]" |
| RF-22 | Descargar el modelo de whisper desde la web | v1 | Se elige el modelo, se ve una barra de progreso y se verifica el checksum al terminar |
| RF-23 | Elegir el idioma de la transcripción | v1 | Configurable por cuenta, con detección automática como opción |

### 4.4 Generación del digest

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-30 | Resumir cada conversación con un LLM | v1 | Por cada conversación con mensajes en la ventana se obtiene: resumen, pendientes, si necesita respuesta y prioridad (alta, media, baja), con salida JSON validada contra un esquema. Una respuesta que no cumple el esquema (por ejemplo, una prioridad fuera de alta, media o baja) se trata como una llamada fallida de esa conversación: se reintenta y pasa al respaldo según RF-42 y RF-48, y si no se puede resumir se cuenta entre las que fallaron. No corta el digest |
| RF-31 | Resumir solo lo no leído | v1 | Con la opción activa, cada conversación se resume desde su primer mensaje no leído y las ya leídas no aparecen. Los mensajes previos se pasan como contexto, marcados para no resumirlos. Si la fuente no informa qué está leído, la opción no se ofrece y se resume por ventana de tiempo (RF-32) |
| RF-32 | Ventana de tiempo con puntero | v1 | Cada digest arranca donde terminó el anterior. El puntero nunca retrocede; la vista previa no lo mueve. Se puede pedir una ventana explícita (`--hours`, `--from`, `--to`). Sin puntero ni inicio explícito, la ventana cubre las N horas anteriores a su fin (N configurable, 24 por defecto). La ventana es inválida si una fecha no se puede interpretar, si `--hours` no es un número positivo o si un inicio explícito no es anterior al fin; en ese caso el digest falla con un error que lo explica y el puntero no se mueve. Una ventana válida sin mensajes no es un error, incluido el caso en que el inicio sale del puntero y es posterior al fin pedido |
| RF-33 | Ignorar mensajes masivos propios | v1 | Un texto propio de 40 caracteres o más que aparece igual en 3 conversaciones o más no se resume, no cuenta como respuesta y no marca la conversación como leída. La longitud se mide en caracteres Unicode (puntos de código), con el mismo criterio al recibir el mensaje y al resumir |
| RF-34 | Deduplicar avisos repetidos en varios grupos | v1 | El mismo aviso de otra persona en varios grupos se resume una sola vez |
| RF-35 | Ordenar el digest en secciones | v1 | Orden: contactos sin agendar (opcional, destacados), necesitan respuesta, con pendientes, el resto. Dentro de cada sección, por prioridad y luego por cantidad de mensajes |
| RF-36 | Ocultar el detalle de "el resto" | v1 | Con la opción activa, el mensaje enviado muestra solo cuántas conversaciones hay en esa sección; el historial guarda el detalle completo |
| RF-37 | Limitar el tamaño por conversación | v1 | Si una conversación supera el máximo de caracteres (24 000 por defecto), se recortan los mensajes más viejos y se indica. Si la opción falta en la configuración, se usa el valor por defecto |
| RF-38 | Editar el prompt | v1 | El prompt se edita desde la web, admite la variable `{{name}}` y tiene un botón para volver al original. El esquema de salida no es editable |
| RF-39 | Idioma del digest | v1 | Español o inglés, configurable por cuenta: afecta títulos de sección, fechas y prompt por defecto |

### 4.5 Proveedores de LLM

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-40 | Usar el LLM que prefiera el usuario, por API | v1 | Proveedores por API: OpenAI, Anthropic, Gemini y Ollama. El adaptador de OpenAI acepta una URL base, así que también sirve para cualquier API compatible (LM Studio, OpenRouter, etc.). Todos pasan el mismo test de contrato |
| RF-41 | Elegir proveedor y modelo por cuenta | v1 | No hay proveedor por defecto: el asistente pide elegir uno y la forma de conectarlo (API o CLI), pide la clave de API cuando corresponde y tiene un botón "Probar conexión" que hace una llamada real y muestra el resultado o el error. Para cada proveedor muestra si cobra, si los datos salen de la máquina y qué hace el proveedor con ellos. El modelo nunca se escribe: se elige de una lista (los alias de Claude Code; los modelos instalados en Ollama; y, para OpenAI, Anthropic y Gemini, la lista que da el proveedor, pedida por el daemon con la clave ya guardada). Si la lista no se puede leer, solo Anthropic ofrece una corta de modelos conocidos, marcada como tal; para OpenAI y Gemini se muestra el error y se puede volver a buscar. Un modelo fuera de la última lista conocida (misma dirección y misma clave, vigente) se rechaza al guardar; solo un servidor compatible que no da lista admite un nombre escrito |
| RF-42 | Proveedor de respaldo | v1 | Si una llamada falla, esa conversación se reintenta con el proveedor de respaldo configurado, y el digest indica cuáles se resumieron con el respaldo |
| RF-43 | Conversaciones solo locales | v1 | Una conversación marcada como "solo local" se resume siempre con un proveedor local (Ollama). Si no hay ninguno disponible, se omite y se avisa; nunca se envía a un proveedor externo |
| RF-44 | Informar el costo o consumo | Luego | El historial muestra tokens usados por digest y proveedor |
| RF-45 | Modelo local chico para Ollama | v1 | El asistente recomienda un modelo según la RAM disponible y lo descarga con barra de progreso. El modelo recomendado se elige con una evaluación contra el set de golden files: tiene que devolver JSON válido en el 100% de los casos y coincidir con el resumen de referencia en "necesita respuesta" en el 90% o más. Candidatos a evaluar en la fase 3: modelos de 3 a 8 mil millones de parámetros (familias Qwen, Gemma, Llama, Phi), revisando cuáles son los vigentes en ese momento |
| RF-46 | Respetar los límites de los planes gratuitos | v1 | Si el proveedor responde por límite de uso (por ejemplo, el plan gratuito de Gemini), se espera y se reintenta respetando el tiempo que indica; si no alcanza, el digest sale con las conversaciones que se pudieron resumir y avisa cuáles faltaron |
| RF-47 | Usar el LLM por su propia CLI | v1 | Para quien ya paga un plan (Claude, ChatGPT, Gemini) o tiene una cuenta gratuita y no quiere sacar una clave de API: se usa la CLI del proveedor con la sesión que el usuario ya inició. Vienen configuradas Claude Code (`claude -p`, la que usa hoy la instalación personal), Gemini CLI y Codex CLI. Además hay un modo **CLI genérica**: cualquier comando que reciba el prompt por stdin y devuelva texto por stdout, configurado como plantilla de comando. Pasa el mismo test de contrato que los proveedores por API |
| RF-48 | Salida estructurada con CLIs | v1 | Si la CLI permite forzar un esquema JSON (como `--json-schema` de Claude Code), se usa. Si no, el esquema va en el prompt, la respuesta se valida y, si es inválida, se reintenta una vez pidiendo corregirla; si vuelve a fallar, esa conversación pasa al respaldo (RF-42) |
| RF-49 | Ejecutar las CLIs sin herramientas | v1 | Las CLIs de proveedores son agentes que pueden leer archivos y ejecutar comandos, y el texto de los chats lo escriben terceros (riesgo de *prompt injection*). Cada llamada corre con las herramientas, MCP y la persistencia de sesión desactivadas (hoy: `--tools ''`, `--strict-mcp-config`, `--no-session-persistence`), en un directorio temporal vacío y con un tiempo máximo. Una CLI configurada solo se habilita si el producto puede verificar que corre así; la CLI genérica muestra la advertencia y pide confirmación explícita |

### 4.6 Entrega

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-50 | Enviar el digest al chat propio | v1 | Llega al chat "Mensaje a mí mismo" de la cuenta, dividido en partes de 3 500 caracteres como máximo, con formato de WhatsApp |
| RF-51 | No enviar nunca a terceros ni a otra cuenta | v1 | El digest de una cuenta solo se entrega al chat propio de esa misma cuenta. El destino de WhatsApp rechaza con error cualquier otro identificador, incluido el de otra cuenta vinculada en la misma instalación. El motivo: el digest contiene conversaciones privadas de terceros |
| RF-52 | Reintentar envíos pendientes | v1 | Si la cuenta está desconectada al terminar el digest, queda en una cola persistente y se envía al reconectar, aun después de reiniciar el daemon |
| RF-53 | Otros destinos (correo, Telegram, archivo, webhook) | Luego | Implementando `DeliveryChannel` |

### 4.7 Horarios y ejecución

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-60 | Programar digests desde la web | v1 | Un editor visual (días de la semana + hora) crea el horario; se ve la próxima ejecución calculada. Ejemplo: 9:00 y 18:00 todos los días; el asistente crea esos dos horarios al terminar |
| RF-61 | Cambios de horario en caliente | v1 | Crear, editar o borrar un horario se aplica sin reiniciar el daemon |
| RF-62 | Zona horaria | v1 | Se toma la zona de la computadora (la del navegador, sin consultar la red) al configurar y se puede cambiar después en los Ajustes. Los horarios respetan los cambios de horario de verano |
| RF-63 | Resumir ahora | v1 | Botón en la web y comando en la CLI que genera y envía el digest en el momento |
| RF-64 | Vista previa | v1 | Genera el digest y lo muestra en la web sin enviarlo ni mover el puntero |
| RF-65 | Ejecuciones perdidas | v1 | Si la máquina estaba apagada a la hora programada, al arrancar el daemon corre el digest pendiente una sola vez (no uno por cada horario perdido) |
| RF-66 | Evitar ejecuciones simultáneas | v1 | Si un digest de una cuenta está en curso, otro pedido para esa cuenta espera o se rechaza con un aviso; nunca corren dos a la vez |

### 4.8 Web local

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-70 | Asistente de primer uso | v1 | Pasos: tu nombre y el de la cuenta → proveedor (con prueba y consentimiento) → QR y sincronización. La página empieza en español; en una instalación nueva sigue el idioma del navegador (español o inglés) y la zona horaria del navegador, y el primer paso tiene un selector Español | English (se escribe el idioma que se ve al guardarlo); después ambos se cambian en los Ajustes; al terminar se crean los horarios por defecto. La transcripción de audios no es un paso: está desactivada hasta que se activa en los Ajustes (RF-21). Se puede retomar si se cierra a mitad |
| RF-71 | Panel | v1 | Estado de cada cuenta, último digest, próxima ejecución, botones de resumir ahora y vista previa |
| RF-72 | Gestión de conversaciones | v1 | Listar y buscar conversaciones; marcarlas como excluidas o solo locales |
| RF-73 | Configuración | v1 | Todas las opciones editables (solo no leídos, ocultar el resto, sin agendar destacados, máximo de caracteres, días de audios del historial, idioma, zona horaria). La configuración se valida al cargarla y al guardarla: un valor inválido se rechaza con un mensaje que indica la opción y el motivo, y una opción que falta toma su valor por defecto |
| RF-74 | Historial | v1 | Lista de digests anteriores con su contenido completo, proveedor usado, duración y errores de cada ejecución |
| RF-75 | Logs | v1 | Ver los últimos logs del daemon, filtrables por cuenta y nivel |
| RF-76 | Pedir algo sobre los chats | v1 | Una pestaña de la cuenta recibe una consulta escrita o dictada (resumen a medida, lista de pedidos, qué dijo alguien) sobre los chats de un período (hoy, 24 h, 3 o 7 días), con un filtro opcional de chats. Cada conversación se consulta por separado con el `Summarizer` y la consulta en el prompt; las que no tienen nada relevante se omiten y no se sintetiza entre chats. Respeta las exclusiones (el filtro no las pisa) y RF-43; las que solo tienen mensajes propios o masivos no se consultan y, si la cuenta tiene "solo no leídos", se lee solo la parte no leída de cada chat con su contexto (como en el digest); se consultan de a 80, las de mensaje recibido más reciente primero, y la respuesta avisa cuántas quedaron afuera y permite seguir con las siguientes sobre la misma ventana. Solo lee: no envía nada a WhatsApp ni mueve el puntero. Las respuestas quedan en memoria (las últimas 20 por cuenta) y se pierden al reiniciar; corre una consulta a la vez por cuenta. El dictado usa el reconocimiento de voz del navegador, que puede enviar el audio a Google o Apple, y la web lo avisa. Cada cuenta puede definir `askHints`: contexto propio que se suma al prompt solo cuando la consulta contiene alguna de sus palabras como palabra entera (sin distinguir mayúsculas ni tildes); nunca se usa en el digest, y el de la cuenta reemplaza al de la instalación |

### 4.9 CLI

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-80 | Comandos | v1 | Se instala como `message-summarize` y con el alias corto `msum`. Comandos: `init`, `daemon`, `open`, `link`, `digest [--dry-run --hours --from --to --account]`, `schedule add/ls/rm`, `accounts`, `import`, `doctor`, `service install/uninstall` |
| RF-81 | Diagnóstico | v1 | `doctor` verifica versión de Node, ffmpeg, whisper, modelo, proveedor de LLM, permisos del directorio de datos y estado de cada cuenta, y explica cómo resolver cada problema |
| RF-82 | Abrir la web autenticada | v1 | `open` abre el navegador en la URL local con el token de acceso |

## 5. Requerimientos no funcionales

| ID | Atributo | Requerimiento | Métrica o verificación |
|---|---|---|---|
| RNF-01 | Privacidad | Mensajes, audios, transcripciones y digests se guardan solo en el directorio de datos local. No hay telemetría | Revisión de código + test que falla si hay llamadas de red no declaradas. Las llamadas declaradas incluyen pedir la lista de modelos al proveedor ya elegido, con su clave y solo a su host |
| RNF-02 | Privacidad | Antes de activar un proveedor externo, la web muestra qué datos se envían y a quién | Paso obligatorio del asistente; queda registrado el consentimiento |
| RNF-03 | Seguridad | La web escucha solo en `127.0.0.1` por defecto y exige un token generado en la instalación | Test de integración: sin token responde 401; exponerla en otra interfaz requiere una opción explícita |
| RNF-04 | Seguridad | Las claves de API y la sesión de WhatsApp se guardan con permisos 600 (o ACL equivalente en Windows) y nunca aparecen en logs | Test que verifica permisos; los logs pasan por una lista de campos a ocultar |
| RNF-05 | Portabilidad | Funciona en macOS (arm64 y x64), Linux (x64 y arm64) y Docker (amd64 y arm64). Windows 11 nativo (x64) con instalador `.exe` o `install.ps1`; también por Docker | Matriz de CI con macOS, Linux y Windows + build multi-arch |
| RNF-06 | Instalación | Instalación completa en menos de 10 minutos con buena conexión, sin contar la descarga del modelo de whisper | Prueba cronometrada en VMs limpias antes de cada release |
| RNF-07 | Disponibilidad | El daemon arranca solo con el sistema (servicio del usuario o `restart: unless-stopped`) y se recupera de caídas | Matar el proceso → vuelve en menos de 30 s |
| RNF-08 | Durabilidad | Ningún mensaje recibido ni digest generado se pierde por un reinicio | SQLite en modo WAL; cola de envíos persistente; test de reinicio en mitad de un digest |
| RNF-09 | Rendimiento | Menos de 150 MB de RAM en reposo con una cuenta y sin whisper | Medición en CI |
| RNF-10 | Rendimiento | Un digest de 50 conversaciones tarda menos de 5 minutos con un proveedor en la nube | Medición con proveedor falso con latencia simulada; las conversaciones se resumen en paralelo con un límite configurable |
| RNF-11 | Escala | Funciona con 1 000 conversaciones y 1 millón de mensajes por cuenta | Base sintética en tests de rendimiento; consultas con índices |
| RNF-12 | Observabilidad | Logs estructurados (JSON) con rotación; estado y última ejecución por cuenta visibles en la web | Tamaño máximo de logs configurable (50 MB por defecto) |
| RNF-13 | Internacionalización | Interfaz, digest, prompt por defecto y mensajes de la CLI en español e inglés | Ningún texto de interfaz fuera de los archivos de traducción (regla de lint) |
| RNF-14 | Extensibilidad | Plataformas y proveedores se agregan como adaptadores sin modificar `domain/` ni `application/` | Tests de contrato por puerto; el dominio no importa infraestructura (regla de lint de dependencias) |
| RNF-15 | Mantenibilidad | TypeScript estricto, Biome, Vitest, CI obligatorio en cada PR | Cobertura de dominio de 90% o más y de casos de uso de 80% o más |
| RNF-16 | Compatibilidad | Los datos sobreviven a las actualizaciones | Migraciones versionadas (`schema_version`), probadas desde cada versión publicada |
| RNF-17 | Respeto a la plataforma | El cliente de WhatsApp no se marca "en línea" al conectarse, para que el celular siga recibiendo notificaciones, y no envía nada fuera del chat propio. **Dos excepciones, aprobadas explícitamente por la persona dueña del proyecto:** (1) la opción `fullHistoryOnLink` de cada cuenta (apagada por defecto, ver RF-16) crea el socket con `syncFullHistory: true`. Es opt-in y solo cambia cuánto historial manda el celular al vincular el dispositivo: el navegador sigue siendo uno de escritorio (WhatsApp lo exige para mandarlo), no se marca "en línea" y no se envía nada; (2) cuando un audio ya no está en los servidores de WhatsApp, se le pide al celular propio que lo vuelva a subir (`updateMediaMessage`, un recibo de reintento de media dirigido solo a la cuenta misma), con un pedido cada 2 s como máximo y hasta 4 intentos por audio. Ninguna de las dos manda nada a terceros | Configuración fija en el adaptador, cubierta por test; el test verifica que sin la opción el socket sigue con `syncFullHistory: false` y que con ella solo cambia ese valor |
| RNF-18 | Licencia | MIT, con dependencias de licencias compatibles | Chequeo de licencias en CI |
| RNF-19 | Peso de la web | La web es lo más liviana posible: Svelte 5 compilado con Vite, sin librería de componentes. El daemon la sirve como archivos estáticos | Bundle de JS de menos de 100 KB comprimido (gzip), verificado en CI |

## 6. Restricciones y supuestos

- **Node 22 o superior.** Se usan `node:sqlite` y ESM; no hay módulos nativos de npm, lo que permite empaquetar un binario único más adelante.
- **Baileys** es un cliente no oficial de WhatsApp y hoy se usa una versión RC. Su API puede cambiar; queda aislado detrás de `MessageSource` y `DeliveryChannel`.
- **ffmpeg y whisper.cpp** son dependencias del sistema y opcionales.
- **Un solo daemon por instalación.** Los horarios viven en la base y los ejecuta el daemon (con `croner`); no se escribe en el crontab ni en el planificador del sistema operativo. Lo único que se registra en el sistema es el daemon como servicio.
- Los horarios solo se cumplen si la máquina está encendida y el daemon corriendo. Para garantizarlos hace falta un servidor (Docker en un VPS o una Raspberry Pi).

## 7. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| WhatsApp bloquea la cuenta por usar un cliente no oficial | Alto | Aviso legal claro en el README y en el asistente; comportamiento de solo lectura; sin envíos a terceros; sin marcarse en línea |
| Cambios en Baileys o en el protocolo de WhatsApp rompen la conexión | Alto | Versión fijada, Renovate, tests de contrato del adaptador con fixtures grabados |
| El contenido de los chats sale hacia el proveedor de LLM | Alto | Consentimiento explícito (RNF-02), opción solo local (RF-43), Ollama como opción totalmente local |
| El plan gratuito de Gemini puede usar el contenido para mejorar los productos de Google (incluida revisión humana), según sus términos | Alto | El asistente lo advierte al elegir Gemini sin facturación (RF-41) y sugiere marcar como solo locales los chats sensibles. Revisar los términos vigentes antes de cada release |
| Un mensaje de un tercero contiene instrucciones que una CLI con herramientas podría ejecutar en la máquina del usuario (*prompt injection*) | Alto | CLIs sin herramientas, en directorio vacío y con tiempo máximo (RF-49); test que verifica las opciones con las que se lanza cada CLI |
| Los términos de algunos planes de suscripción podrían no permitir el uso automatizado de su CLI | Medio | Revisar los términos de Claude, ChatGPT/Codex y Gemini antes de la v0.1.0 y documentar en el README qué permite cada uno; la responsabilidad de cumplirlos queda del lado del usuario |
| Las CLIs cambian sus opciones entre versiones | Medio | `doctor` verifica la versión y las opciones de cada CLI configurada; tests de contrato con una CLI falsa |
| Un modelo chico de Ollama resume mal o devuelve JSON inválido | Medio | Evaluación contra golden files (RF-45); salida forzada con esquema JSON (`format`) de Ollama; reintento con el respaldo |
| La web expuesta da acceso a todos los chats | Alto | Solo localhost + token (RNF-03) |
| Instalación nativa difícil en Windows (whisper, ffmpeg) | Medio | Transcripción opcional; Docker como vía recomendada; `doctor` |
| El nombre o el logo se confunden con la marca WhatsApp | Medio | Nombre neutro (`message-summarize`); WhatsApp se menciona solo como plataforma soportada |

## 8. Trazabilidad con la implementación

| Requerimientos | Componente (ver plan de arquitectura) | Fase |
|---|---|---|
| RF-30 a RF-39, RF-33, RF-34 | `domain/` (`UnreadTracker`, `MassMessagePolicy`, `CrossGroupDeduplicator`, `SummaryWindow`, `DigestComposer`) + `GenerateDigest` | 0 (caracterización) y 1 |
| RF-10 a RF-15 | `infrastructure/whatsapp/BaileysSource` + `MessageParser` + `HandleIncomingMessage` | 1 |
| RF-50 a RF-52 | `DeliveryChannel` + `WhatsAppSelfChatDelivery` + `OutboxRepository` + `WhatsAppTextRenderer` | 1 |
| RF-03, RF-06, RF-60 a RF-66 | Daemon, `CronerScheduler`, `ScheduleRepository`, `app.db`, `import` | 2 |
| RF-20 a RF-23, RF-40 a RF-47, RF-81 | `infrastructure/llm/api/` (`OpenAISummarizer`, `AnthropicSummarizer`, `GeminiSummarizer`, `OllamaSummarizer`), `infrastructure/llm/cli/` (`CliSummarizer` con presets de Claude Code, Gemini CLI y Codex, más la plantilla genérica; `SandboxedProcessRunner`), `StructuredOutputValidator`, `FallbackSummarizer`, `LocalOnlyRouter`, `RateLimitRetry`, `WhisperCppTranscriber`, `ModelDownloader`, `doctor` | 3 |
| RF-01, RF-02, RF-04, RF-70 a RF-75, RF-82 | API HTTP con node:http + SSE, SPA, autenticación con token | 4 |
| RF-76 | `AskChats` (caso de uso sobre `Summarizer`), `AskService` en memoria, rutas `/api/accounts/:id/ask` y pestaña "Pedir" | Posterior a v0.1.0-rc1 |
| RNF-05 a RNF-07, RF-80 (`service`) | Imagen Docker, `install.sh`, `install.ps1`, `ServiceInstaller` | 5 |
| RNF-15, RNF-18, documentación | CI, licencia, aviso legal, README | 6 |

Cambio respecto del plan original: como WhatsApp es la primera plataforma y no la única, el puerto `WhatsAppGateway` se divide en dos, `MessageSource` (leer) y `DeliveryChannel` (entregar), y las entidades del dominio usan nombres genéricos (`Conversation`, `Participant`, `Message`). Lo propio de WhatsApp (LID, contador de no leídos del celular, `read-self`) queda en el adaptador, que lo traduce a eventos del dominio.

## 9. Decisiones tomadas (2026-11-05)

1. **Fuentes sin estado de leído:** se resume solo por ventana de tiempo (RF-31).
2. **Destino:** el digest es personal; nunca se manda a otra cuenta, ni siquiera a otra cuenta de la misma instalación (RF-51 y alcance).
3. **Web:** la opción más liviana posible, Svelte 5 compilado con Vite (RNF-19).
4. **CLI:** alias corto `msum` (RF-80).
5. **Proveedor:** sin proveedor por defecto; el usuario conecta el LLM que prefiera entre OpenAI, Anthropic, Gemini y Ollama. Gemini es atractivo por su plan gratuito, con la advertencia de privacidad de la sección 7. Para Ollama se elige un modelo chico por evaluación (RF-45). Cada proveedor se puede conectar por API o por su propia CLI (Claude Code, Gemini CLI, Codex o una CLI genérica), aprovechando el plan que el usuario ya tiene (RF-47 a RF-49).
6. **Transcripción:** whisper.cpp local, igual que en la herramienta actual (RF-20).

## 10. Decisiones de implementación (2026-11-05)

1. **Datos de prueba de la fase 0:** conversaciones inventadas que cubren cada regla; nunca datos reales, porque el repo es público.
2. **CLIs dentro de Docker:** imagen base sin CLIs (API u Ollama) y una variante `-cli` que incluye Claude Code, Gemini CLI y Codex, con la sesión iniciada adentro del contenedor.
3. **Instaladores nativos:** Docker, macOS, Linux y Windows en la v1 (decisión del 2026-11-19, antes Windows quedaba para la v1.1). En Windows el daemon se registra con una entrada de inicio de sesión del usuario (clave `Run`), sin permisos de administrador y sin el planificador de tareas. El instalador `.exe` se arma en CI y se distribuye en los releases de GitHub; `npm` es la vía de distribución del paquete.
4. **Publicación:** repo público `message-summarize` en la cuenta personal de GitHub del autor, con licencia MIT.
5. **Idioma:** código, commits y nombres en inglés; README en inglés y español; los documentos de diseño en español hasta la v0.1.0.
6. **Autoría:** los commits van solo a nombre del autor, sin coautoría de herramientas de IA.
7. **Fallas de la herramienta anterior:** los casos de `test/golden/README.md` que no se congelaron porque la herramienta se cae o pierde datos ("Legacy failures that are not frozen") no se reproducen. El comportamiento heredado que sí está congelado se mantiene. Un mensaje sin texto que no es audio se muestra por su tipo (RF-10); toda opción del digest tiene un valor por defecto (el proveedor no lo tiene: se elige en el asistente, RF-41) y la configuración se valida al cargarla (RF-14, RF-32, RF-37, RF-73); una ventana inválida no mueve el puntero (RF-32); una prioridad desconocida es un error de esquema (RF-30). Cada caso tiene un test unitario.
8. **Mensajes masivos propios:** la longitud mínima de un mensaje masivo propio se mide en puntos de código al recibir el mensaje y al resumir (RF-33), como ya hacía la herramienta anterior al resumir (golden 03, caso E39); al recibir medía unidades UTF-16.
