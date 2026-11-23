# A qué se conecta el programa

No se envía nada a ningún lado salvo lo que figura en esta guía. No hay telemetría, y la transcripción nunca abre una conexión de red. Volver al [README](../../README.es.md).

## Resumen

| Destino | Cuándo | Qué se envía |
|---|---|---|
| WhatsApp | Siempre que una cuenta está conectada | Tu propia conexión; la descarga de audios que recibís, si la transcripción está activa. |
| El proveedor de LLM que elegiste | Al resumir o al responder un pedido de "Pedir" | El texto de las conversaciones que no son "solo locales" y tu prompt (o tu pedido). |
| Lo que contacta Claude Code | Con `claude-cli` | Lo decide la propia CLI (ver abajo). |
| La lista de modelos del proveedor | Al abrir el asistente o Ajustes para elegir modelo | Un `GET` sin texto de chats. |
| Tu servidor de Ollama | `msum ollama pull`, `msum doctor` o el selector de modelos | El tag, o un pedido de la lista de modelos; sin texto de chats. |
| Hugging Face | Solo con `msum whisper download <nombre>` | El pedido del archivo del modelo. |

## En detalle

### WhatsApp

Por la conexión de tu propia cuenta (incluida la descarga de los audios que recibís, cuando la transcripción está activada).

### El proveedor de LLM que elegiste

Y nada más: con Ollama, la URL que configuraste; con un proveedor por API, exactamente uno entre `api.openai.com` (o tu `provider.openai.baseUrl`), `api.anthropic.com` o `generativelanguage.googleapis.com`.

- **El texto de las conversaciones que no son solo locales se envía ahí**, junto con tu prompt de resumen.
- Un pedido de la pestaña "Pedir" de la web envía lo mismo, de a una conversación, con tu pedido en lugar del prompt de resumen.
- Las claves viajan solo en los encabezados del pedido.

### Con `claude-cli`: lo que contacta el propio Claude Code

Son los servidores de su fabricante, según [su documentación de red](https://code.claude.com/docs/en/network-config):

- `api.anthropic.com`: los pedidos al modelo, que llevan el texto de las conversaciones que no son solo locales, y su propia telemetría operativa.
- `claude.ai`, `claude.com`, `platform.claude.com` y `sso.claude.com`: inicio de sesión.
- `http-intake.logs.us5.datadoghq.com` y `browser-intake-us5-datadoghq.com`: telemetría opcional de la CLI, que su configuración puede apagar (`DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`).

Ese tráfico es de la CLI, no de este programa, y el programa no le pasa esas variables: definilas en el archivo de configuración de Claude Code. `gemini-cli` y `codex-cli` están deshabilitados y no contactan nada. Un comando de `generic-cli` contacta lo que haga.

### El dictado de la pestaña "Pedir": lo que contacta tu navegador

El botón del micrófono usa el reconocimiento de voz del navegador (la Web Speech API). El programa recibe solo el texto que resulta, nunca el audio. Adónde va el audio lo decide el navegador: Chrome lo envía a los servidores de Google, y Safari a los de Apple. Si escribís el pedido, no se envía nada.

### La lista de modelos

Cuando abrís el asistente o los ajustes para elegir un modelo:

- **Con un proveedor por API**, un `GET` a su lista de modelos (`/v1/models` en `api.openai.com` o en tu `provider.openai.baseUrl`, en `api.anthropic.com`; `/v1beta/models` en `generativelanguage.googleapis.com`), hecho por el daemon con la clave que ya guardaste, al host ya declarado para ese proveedor y a ninguno más. Sin texto de chats, con tiempo máximo, sin redirecciones ni reintentos, y la respuesta se guarda en memoria diez minutos. La clave nunca llega a la página.
- **Con Ollama**, un pedido de los modelos instalados en la dirección que configuraste, o en la que escribiste en pantalla antes de guardarla (`/api/tags`; una dirección que no es de esta máquina se consulta solo después de que aceptes su aviso), también desde el selector de modelos de la página.
- Los modelos de Claude Code (`sonnet`, `opus`, `haiku`) son una lista fija y no consultan nada.
- El pedido es un `POST` de la página al daemon, con la misma verificación de origen que cualquier otra escritura.
- Si no se puede leer la lista, solo Anthropic tiene una lista corta de modelos conocidos (marcada como tal); para OpenAI y Gemini la página muestra el error y un botón "Volver a buscar". Un modelo nunca se escribe, salvo en un servidor compatible que no puede listar sus modelos.

### Tu propio servidor Ollama

Cuando corrés `msum ollama pull <tag>` o `msum doctor`: el tag a descargar, o un pedido de su lista de modelos, a la URL de `provider.ollama.baseUrl` y a ningún otro lado; sin texto de chats. La descarga la hace Ollama, no este programa.

### Hugging Face

Solo cuando corrés `msum whisper download <nombre>`: el modelo se baja del repositorio oficial de whisper.cpp, `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<nombre>.bin`.

- Hugging Face responde con una redirección a su red de contenido: un pedido a esa URL termina en **`us.aws.cdn.hf.co`** (verificado con un pedido `HEAD` al escribir esto).
- El programa sigue las redirecciones por su cuenta, de a una, y solo hacia direcciones `https` de `huggingface.co` o `*.hf.co`; cualquier otro servidor se rechaza.
- Solo se envía el pedido de ese archivo, y el **checksum (SHA-256) y el tamaño de cada modelo están fijados en el programa**: un archivo que no coincide se descarta.

## Qué hace cada proveedor con tus datos

Ver [Privacidad en la guía de proveedores](proveedores.md#privacidad-qué-hace-cada-proveedor-con-tus-datos).

---

Volver al [README](../../README.es.md) · [Índice de guías](README.md)
