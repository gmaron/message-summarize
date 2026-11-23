# La página web, el asistente y las cuentas

Mientras corre, el daemon sirve una página local. Esta guía explica qué se puede hacer desde ella. Volver al [README](../../README.es.md).

## Dirección, token y red

- Por defecto está en `http://127.0.0.1:8787`. Se configura con la opción `web` del `config.json` de la instalación: `port`, `host`, `enabled`.
- `msum open` la abre con la sesión ya iniciada. La dirección lleva un token de acceso, generado una sola vez en el directorio de datos (`web-token`): no la compartas.
- Escucha solo en esta máquina. Otro `host` (por ejemplo `0.0.0.0` dentro de Docker, publicando el puerto solo en `127.0.0.1`) es una elección explícita.
- Detrás de un proxy inverso que reenvía el nombre por el que se llegó (por ejemplo `tailscale serve`), la web responde 403 a ese nombre, porque solo acepta IPs y los nombres de loopback. `web.allowedHosts` en el `config.json` de la instalación (vacío por defecto) lista los nombres que sí acepta, sin esquema ni puerto: `"allowedHosts": ["mi-equipo", "mi-equipo.mi-red.ts.net"]`. Un nombre listado se acepta sin puerto y su `Origin` también por `https`; el token sigue siendo obligatorio y cualquier otro nombre sigue dando 403.

## Qué se puede hacer

Las secciones de cada cuenta son Resumen, Conversaciones, Pedir, Horarios, Historial y Ajustes.

- **Cuentas.** Agregar una cuenta y vincularla escaneando el QR, seguir la sincronización del historial y ver el estado de cada cuenta.
- **Destrabar un bloqueo.** Vincular de nuevo o reintentar. Después de una conexión rechazada o reemplazada, la página hace esperar 30 minutos.
- **Horarios.** Editarlos, usar "resumir ahora" y ver una vista previa que no envía nada ni mueve el puntero.
- **Conversaciones.** Listar y buscar las conversaciones de una cuenta y marcar cada una como excluida o solo local (ver [abajo](#excluir-y-solo-local)).
- **Pedir.** Pedir algo sobre tus chats, escribiendo o dictando: un resumen a medida, una lista de pedidos, qué dijo alguien (ver [abajo](#pedir-algo-sobre-tus-chats)).
- **Prompt.** Editar el prompt de cada cuenta y volver al original, que guarda tu texto en `prompt.previous.md`. La única variable es `{{name}}`; el formato de la respuesta es fijo y se agrega solo.
- **Logs.** El botón "Logs" muestra las últimas líneas de log del daemon, filtrables por nivel y cuenta; nunca incluyen mensajes, nombres ni secretos.
  - El daemon además las escribe en `logs/daemon.log` dentro del directorio de datos (rota a `daemon.log.1`).
  - Los dos archivos juntos quedan por debajo de `logs.maxBytes` (solo en el `config.json` de la instalación, 50 MB por defecto, mínimo 1 MB).
- **Ajustes.** La configuración, las conversaciones, el prompt, el historial, los logs y la configuración inicial ya están en la web.

La web todavía no configura la transcripción: se activa en `config.json` (ver la [guía de transcripción](transcripcion.md)). Codex está deshabilitado (RF-49) hasta poder verificar cómo apagar sus herramientas; cualquier otro comando se sigue eligiendo con `msum provider use generic-cli`.

## Excluir y "solo local"

- **Excluir un chat borra los mensajes y la fila del chat guardados hasta ese momento.** No quita los resúmenes que ya están dentro de digests pasados (el historial de digests se conserva) ni las partes que ya esperan en la cola de envío. Quitar la exclusión no recupera nada.
- Una marca cubre los ids de esa persona que WhatsApp le contó a esta computadora (un número y un id interno). Si la misma persona aparece como un segundo chat, marcá también ese.
- **"Solo local"** necesita un modelo de Ollama en la configuración (ver [modelo local](modelo-local-ollama.md)).

## Pedir algo sobre tus chats

La pestaña "Pedir" responde un pedido sobre los chats de un período (hoy, 24 horas, 3 o 7 días), por ejemplo "la lista de pedidos que me hicieron esta semana, quién pidió qué y si ya respondí". Solo lee: no envía nada a WhatsApp.

- **Cómo responde.** Lee cada conversación del período por separado con tu proveedor y muestra solo las que tienen algo para tu pedido, primero las que esperan tu respuesta. No junta varios chats en una sola respuesta.
- **Qué chats.** Los mismos que resumiría un digest: los chats excluidos y tu propio chat nunca se leen, aunque los nombres en el filtro opcional "Solo estos chats" (nombres o números, separados por comas). Los chats "solo locales" los responde solo tu modelo local, igual que en el digest. Un período con más de 60 chats se rechaza: elegí menos días o filtrá.
- **Dictado.** El botón del micrófono usa el reconocimiento de voz de tu navegador, no este programa: según el navegador, el audio puede ir a Google (Chrome) o a Apple (Safari). Escribir no envía nada a ningún lado. Algunos navegadores, como Firefox, no pueden dictar.
- **Dónde quedan las respuestas.** Solo en la memoria del daemon, las últimas 20 por cuenta, y se pierden al reiniciarlo. Cada una se puede copiar o borrar. La cuenta tiene que estar conectada y corre un pedido a la vez por cuenta.
- **Límites.** El pedido admite hasta 1000 caracteres. No usa tu prompt personalizado: tiene sus propias instrucciones. Tampoco transcribe antes los audios pendientes: un audio que el digest todavía no transcribió figura como "audio sin transcribir", y la respuesta puede sugerir escucharlo.

## El asistente de primer uso

La primera vez que se abre la página en una instalación sin ninguna cuenta vinculada, empieza un asistente de tres pasos.

| Paso | Qué se hace |
|---|---|
| **Vos** | Tu nombre y el nombre de la cuenta. La página empieza en español; en una instalación nueva sigue el idioma del navegador (español o inglés, el primero que pida). Hay un selector Español \| English en este primer paso, y el idioma que se ve al guardar el paso es el que se escribe. La zona horaria es la del navegador, sin consultar la red. Los dos se cambian después en Ajustes. |
| **Resumen** | El proveedor, con su prueba y su aceptación. |
| **Vincular** | El QR y la sincronización del historial. |

- Al terminar crea los horarios por defecto, 09:00 y 18:00 todos los días, que se editan en la pestaña Horarios. La zona horaria en uso se muestra junto a los horarios (un daemon solo, como en Docker, usaría UTC salvo que pongas `TZ`).
- Se puede cerrar a mitad y retomar (su estado se guarda en `app.db`), o saltear. Una instalación que ya tiene una cuenta vinculada (hecha con la línea de comandos o con `msum import`) nunca lo ve.
- Es el único lugar donde la web escribe el `config.json` de la instalación, y solo su `language` y `timezone`, y solo en una instalación recién hecha (sin cuentas y con el idioma que escribe `msum init`).

### Elegir el proveedor en el asistente

Al elegir el proveedor, el asistente muestra:

- cuánto cuesta cada uno;
- si los datos salen de tu computadora, hacia quién y qué hace el proveedor con ellos;
- un botón **Probar conexión**, que hace una llamada real con un chat corto inventado y solo corre cuando hacés clic.

En el asistente, "Probar conexión" puede probar una clave que escribiste sin guardarla (Ajustes no ofrece esa prueba).

## Aceptación de un proveedor externo

Un proveedor que envía el texto de tus chats fuera de esta máquina necesita una aceptación explícita: hay que marcar la casilla y queda registrada (cuenta, proveedor, versión del texto y hora) en `app.db`. Son externos:

- Claude Code, que lo manda a Anthropic bajo tu cuenta de Claude;
- OpenAI, Anthropic y Gemini por sus APIs;
- cualquier servidor compatible con la API de OpenAI, incluso uno en tu propia computadora.

Más detalles:

- La configuración pide la misma aceptación la primera vez que elegís un proveedor así para una cuenta.
- Ollama en tu propia máquina no necesita ninguna. Pero un servidor de Ollama cuya dirección no es de esta máquina (ni `localhost`, ni `127.0.0.0/8`, ni `::1`) también cuenta como destinatario externo: la página nombra el equipo, avisa que las conversaciones "solo locales" también van ahí y pide la misma aceptación.
- Una configuración escrita a mano o con la línea de comandos no se bloquea por esto: la aceptación se refiere a la elección hecha en la web.
- Cada proveedor muestra su propio aviso antes de usarse (OpenAI, Anthropic, Google o el host del servidor), dice que los chats "solo locales" nunca van a un proveedor externo, y para Gemini suma la advertencia del plan gratuito. Cambiar la dirección de un servidor compatible pide la aceptación de nuevo.

## Claves de API en la web

OpenAI, Anthropic y Gemini se eligen en el asistente y en Ajustes con su modelo y su clave de API. Para OpenAI además podés poner la dirección de cualquier servidor compatible (LM Studio, OpenRouter...), que se considera externo aunque sea `localhost` y usa su propia clave (`openai-compatible`), aparte de la de OpenAI.

- La página muestra si hay una clave y de dónde viene (variable de entorno, archivo de claves de la cuenta o de la instalación), pero nunca la clave.
- Se guarda en el `secrets.json` de la instalación (modo 0600) y no se escribe nunca en `config.json` ni en `app.db`.
- El campo se vacía apenas la clave se guarda o se prueba.

Más en la [guía de proveedores](proveedores.md).

## Varias cuentas

Ver [El daemon, las cuentas y los horarios](demonio-y-horarios.md#varias-cuentas).

---

Volver al [README](../../README.es.md) · [Índice de guías](README.md)
