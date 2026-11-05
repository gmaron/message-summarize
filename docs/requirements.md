# message-summarize: requerimientos

Versión 1.2 · 2026-11-05 · Estado: aprobado

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

**Incluye:** una fuente (WhatsApp por Baileys), un destino (el chat propio de WhatsApp), varias cuentas por instalación, proveedores de LLM a elección del usuario (OpenAI, Anthropic, Gemini y Ollama), transcripción de audios local y opcional, web local, CLI, horarios configurables e instalación con Docker y nativa en macOS y Linux.

**No incluye:** otras plataformas de mensajería, responder mensajes en nombre del usuario, envío a terceros, mandar el digest de una cuenta a otra cuenta (cada digest es personal y solo lo recibe la cuenta resumida), acceso remoto a la web (fuera de la red local), app móvil, sincronización entre máquinas, modo multiusuario ni servicio en la nube. La instalación nativa en Windows queda para la v1.1 (en la v1, Windows usa Docker).

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
| RF-10 | Guardar los mensajes entrantes y salientes de todas las conversaciones | v1 | Se guardan texto, imagen, video, audio, documento, sticker, ubicación, contacto, encuesta y evento, con una representación de texto para cada tipo |
| RF-11 | Registrar las ediciones de mensajes | v1 | Un mensaje editado reemplaza al original en el digest |
| RF-12 | Llevar el estado de no leídos por conversación | v1 | El contador refleja lo que muestra el celular: se toma en la sincronización inicial, se actualiza al leer desde cualquier dispositivo, y marcar como no leído en el celular vuelve a incluir el chat. La foto inicial no pisa lo que llegó en vivo |
| RF-13 | Resolver la identidad de los remitentes | v1 | Se muestra el nombre de la agenda si existe; si no, el nombre público y el número con espacios (para poder tocarlo en WhatsApp Web). Los identificadores internos (LID) se traducen a número cuando es posible |
| RF-14 | Excluir conversaciones | v1 | Una conversación excluida (por nombre o identificador) no se guarda ni se resume |
| RF-15 | Descargar los audios para transcribirlos | v1 | Los audios de los últimos N días del historial (configurable, 14 por defecto) y todos los que llegan en vivo se descargan si la transcripción está activa |

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
| RF-30 | Resumir cada conversación con un LLM | v1 | Por cada conversación con mensajes en la ventana se obtiene: resumen, pendientes, si necesita respuesta y prioridad (alta, media, baja), con salida JSON validada contra un esquema |
| RF-31 | Resumir solo lo no leído | v1 | Con la opción activa, cada conversación se resume desde su primer mensaje no leído y las ya leídas no aparecen. Los mensajes previos se pasan como contexto, marcados para no resumirlos. Si la fuente no informa qué está leído, la opción no se ofrece y se resume por ventana de tiempo (RF-32) |
| RF-32 | Ventana de tiempo con puntero | v1 | Cada digest arranca donde terminó el anterior. El puntero nunca retrocede; la vista previa no lo mueve. Se puede pedir una ventana explícita (`--hours`, `--from`, `--to`) |
| RF-33 | Ignorar mensajes masivos propios | v1 | Un texto propio de 40 caracteres o más que aparece igual en 3 conversaciones o más no se resume, no cuenta como respuesta y no marca la conversación como leída |
| RF-34 | Deduplicar avisos repetidos en varios grupos | v1 | El mismo aviso de otra persona en varios grupos se resume una sola vez |
| RF-35 | Ordenar el digest en secciones | v1 | Orden: contactos sin agendar (opcional, destacados), necesitan respuesta, con pendientes, el resto. Dentro de cada sección, por prioridad y luego por cantidad de mensajes |
| RF-36 | Ocultar el detalle de "el resto" | v1 | Con la opción activa, el mensaje enviado muestra solo cuántas conversaciones hay en esa sección; el historial guarda el detalle completo |
| RF-37 | Limitar el tamaño por conversación | v1 | Si una conversación supera el máximo de caracteres (24 000 por defecto), se recortan los mensajes más viejos y se indica |
| RF-38 | Editar el prompt | v1 | El prompt se edita desde la web, admite la variable `{{name}}` y tiene un botón para volver al original. El esquema de salida no es editable |
| RF-39 | Idioma del digest | v1 | Español o inglés, configurable por cuenta: afecta títulos de sección, fechas y prompt por defecto |

### 4.5 Proveedores de LLM

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-40 | Usar el LLM que prefiera el usuario, por API | v1 | Proveedores por API: OpenAI, Anthropic, Gemini y Ollama. El adaptador de OpenAI acepta una URL base, así que también sirve para cualquier API compatible (LM Studio, OpenRouter, etc.). Todos pasan el mismo test de contrato |
| RF-41 | Elegir proveedor y modelo por cuenta | v1 | No hay proveedor por defecto: el asistente pide elegir uno y la forma de conectarlo (API o CLI), pide la clave de API cuando corresponde y tiene un botón "Probar conexión" que hace una llamada real y muestra el resultado o el error. Para cada proveedor muestra si cobra, si los datos salen de la máquina y qué hace el proveedor con ellos |
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
| RF-60 | Programar digests desde la web | v1 | Un editor visual (días de la semana + hora) crea el horario; se ve la próxima ejecución calculada. Ejemplo: 9:00 y 19:00 todos los días |
| RF-61 | Cambios de horario en caliente | v1 | Crear, editar o borrar un horario se aplica sin reiniciar el daemon |
| RF-62 | Zona horaria | v1 | Se detecta la del sistema y se puede cambiar por cuenta. Los horarios respetan los cambios de horario de verano |
| RF-63 | Resumir ahora | v1 | Botón en la web y comando en la CLI que genera y envía el digest en el momento |
| RF-64 | Vista previa | v1 | Genera el digest y lo muestra en la web sin enviarlo ni mover el puntero |
| RF-65 | Ejecuciones perdidas | v1 | Si la máquina estaba apagada a la hora programada, al arrancar el daemon corre el digest pendiente una sola vez (no uno por cada horario perdido) |
| RF-66 | Evitar ejecuciones simultáneas | v1 | Si un digest de una cuenta está en curso, otro pedido para esa cuenta espera o se rechaza con un aviso; nunca corren dos a la vez |

### 4.8 Web local

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-70 | Asistente de primer uso | v1 | Pasos: idioma → nombre → proveedor (con prueba) → transcripción → QR → sincronización → primer horario. Se puede retomar si se cierra a mitad |
| RF-71 | Panel | v1 | Estado de cada cuenta, último digest, próxima ejecución, botones de resumir ahora y vista previa |
| RF-72 | Gestión de conversaciones | v1 | Listar y buscar conversaciones; marcarlas como excluidas o solo locales |
| RF-73 | Configuración | v1 | Todas las opciones editables (solo no leídos, ocultar el resto, sin agendar destacados, máximo de caracteres, días de audios del historial, idioma) |
| RF-74 | Historial | v1 | Lista de digests anteriores con su contenido completo, proveedor usado, duración y errores de cada ejecución |
| RF-75 | Logs | v1 | Ver los últimos logs del daemon, filtrables por cuenta y nivel |

### 4.9 CLI

| ID | Requerimiento | Prioridad | Criterio de aceptación |
|---|---|---|---|
| RF-80 | Comandos | v1 | Se instala como `message-summarize` y con el alias corto `msum`. Comandos: `init`, `daemon`, `open`, `link`, `digest [--dry-run --hours --from --to --account]`, `schedule add/ls/rm`, `accounts`, `import`, `doctor`, `service install/uninstall` |
| RF-81 | Diagnóstico | v1 | `doctor` verifica versión de Node, ffmpeg, whisper, modelo, proveedor de LLM, permisos del directorio de datos y estado de cada cuenta, y explica cómo resolver cada problema |
| RF-82 | Abrir la web autenticada | v1 | `open` abre el navegador en la URL local con el token de acceso |

## 5. Requerimientos no funcionales

| ID | Atributo | Requerimiento | Métrica o verificación |
|---|---|---|---|
| RNF-01 | Privacidad | Mensajes, audios, transcripciones y digests se guardan solo en el directorio de datos local. No hay telemetría | Revisión de código + test que falla si hay llamadas de red no declaradas |
| RNF-02 | Privacidad | Antes de activar un proveedor externo, la web muestra qué datos se envían y a quién | Paso obligatorio del asistente; queda registrado el consentimiento |
| RNF-03 | Seguridad | La web escucha solo en `127.0.0.1` por defecto y exige un token generado en la instalación | Test de integración: sin token responde 401; exponerla en otra interfaz requiere una opción explícita |
| RNF-04 | Seguridad | Las claves de API y la sesión de WhatsApp se guardan con permisos 600 (o ACL equivalente en Windows) y nunca aparecen en logs | Test que verifica permisos; los logs pasan por una lista de campos a ocultar |
| RNF-05 | Portabilidad | Funciona en macOS (arm64 y x64), Linux (x64 y arm64) y Docker (amd64 y arm64). Windows 11 nativo en la v1.1; en la v1, por Docker | Matriz de CI con macOS y Linux + build multi-arch; Windows se suma a la matriz en la v1.1 |
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
| RNF-17 | Respeto a la plataforma | El cliente de WhatsApp no se marca "en línea" al conectarse, para que el celular siga recibiendo notificaciones, y no envía nada fuera del chat propio | Configuración fija en el adaptador, cubierta por test |
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
| RF-01, RF-02, RF-04, RF-70 a RF-75, RF-82 | API Fastify + SSE, SPA, autenticación con token | 4 |
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
3. **Instaladores nativos:** Docker, macOS y Linux en la v1; Windows nativo en la v1.1.
4. **Publicación:** repo público `message-summarize` en la cuenta personal de GitHub del autor, con licencia MIT.
5. **Idioma:** código, commits y nombres en inglés; README en inglés y español; los documentos de diseño en español hasta la v0.1.0.
6. **Autoría:** los commits van solo a nombre del autor, sin coautoría de herramientas de IA.
