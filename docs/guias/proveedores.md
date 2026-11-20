# Elegir y probar el proveedor de LLM

Esta guía explica cómo elegir el proveedor que escribe los resúmenes, cómo guardar su clave, cómo probarlo y qué hace cada uno con tus datos. Volver al [README](../../README.es.md).

## Los proveedores

Se elige en `config.json` (o en el archivo propio de una cuenta): `provider.primary` y, opcionalmente, `provider.backup`, que se hace cargo de una conversación cuando falla el principal (un límite de uso que no se levanta a tiempo, una respuesta que no cumple el formato del resumen...).

Ambos aceptan `claude-cli`, `gemini-cli`, `codex-cli`, `generic-cli` (ver [Usar una CLI como proveedor](cli-como-proveedor.md)), `ollama`, `openai`, `anthropic` y `gemini`.

**Los proveedores por API no tienen modelo por defecto** (los nombres de los modelos cambian seguido, y uno por defecto desactualizado fallaría más tarde): `provider.<nombre>.model` es obligatorio cuando se usa uno, y la configuración se rechaza sin él.

| Proveedor | Configuración | Se conecta a |
|---|---|---|
| `openai` | `"provider": { "primary": "openai", "openai": { "model": "<modelo>" } }`. También `baseUrl` (por defecto `https://api.openai.com/v1`), `timeoutMs` y `structuredOutput` (`json_schema` por defecto; `json_object` o `prompt` para servidores compatibles que no lo tienen). | `api.openai.com`, o tu `baseUrl` |
| `anthropic` | `"anthropic": { "model": "claude-sonnet-5-5", "effort": "low" }` (o `claude-haiku-5-5`). También `timeoutMs`, `maxTokens` (16000 por defecto: los modelos actuales piensan por defecto y eso cuenta contra el límite) y `effort` (`low`, `medium`, `high`, `xhigh` o `max`; sin definir usa el valor del modelo). `low` conviene para resúmenes: menos costo y latencia. | `api.anthropic.com` |
| `gemini` | `"gemini": { "model": "<modelo>" }`. También `timeoutMs`. | `generativelanguage.googleapis.com` |

### Servidores compatibles y "solo local"

`openai` con un `baseUrl` sirve para cualquier servidor con la API Chat Completions (LM Studio, OpenRouter...); para esos la clave es opcional.

Un proveedor por API es **externo aunque el servidor esté en `localhost`**: no se puede verificar que una URL se quede en la máquina, así que las conversaciones de `localOnlyPatterns` nunca se le envían.

"Solo local" significa **tu servidor de Ollama**: las conversaciones de `localOnlyPatterns` van al Ollama configurado en `provider.ollama.baseUrl` y a nada más.

- Si esa dirección es de esta máquina (`localhost`, una dirección de loopback como `127.0.0.1`, o `host.docker.internal` para el host de Docker) nada sale de la máquina.
- Si es otra computadora, los chats sí salen hacia ese servidor, que es tuyo pero no es esta máquina: `msum provider ls` y `msum doctor` lo dicen, y `msum provider use ollama` muestra la información y pide consentimiento. Usá una URL de loopback si lo necesitás en esta máquina.

## Elegir y probar, paso a paso

Cuatro comandos, en este orden (agregá `--account <id>` cuando hay más de una cuenta).

### 1. `msum provider ls`

Lista cada proveedor con:

- cuánto cuesta (una API cobra por uso, una CLI usa tu plan, Ollama es gratis);
- si tus chats salen de la máquina y hacia qué servidores, y un enlace a su política de datos;
- si está configurado acá (principal o respaldo);
- si su clave está presente (de dónde sale, nunca la clave);
- si es usable ahora (las CLIs se verifican, los presets deshabilitados lo dicen).

No hace ninguna llamada de red.

### 2. `msum provider use <nombre> [--model <m>] [--backup] [--yes]`

Elige el proveedor y su modelo.

- Escribe `provider.primary` (o `provider.backup`) en el `config.json` de la cuenta, que crea si hace falta, y **dice qué archivo escribió**.
- Nunca escribe el `config.json` de la instalación, ni siquiera con una sola cuenta: el consentimiento es por cuenta, así que el proveedor que cubre también tiene que serlo (una cuenta vinculada después heredaría, si no, un proveedor externo que nunca vio explicado).
- Conserva todas las demás claves, escribe de forma atómica y valida el resultado antes: un resultado inválido no escribe nada.
- Rechaza `gemini-cli` y `codex-cli` (deshabilitados), y para `generic-cli` explica `acknowledgeRisk`, que ponés vos y él nunca pone. `openai-compatible` necesita `--base-url <url>`.

**Antes de activar un proveedor que envía tus chats afuera te dice qué recibe:**

- el texto de las conversaciones que no son solo locales;
- los nombres de los chats y contactos como aparecen en ellos;
- los números de teléfono de los contactos que no guardaste;
- las transcripciones de las notas de voz;
- tu nombre como dueño.

También dice hacia qué servidores va, dónde está su política, y te pide confirmar. `--yes` salta la pregunta, no la información.

**Tu respuesta queda registrada** (RNF-02) para esa cuenta, con la fecha y los servidores que se mostraron.

- Un servidor distinto (por ejemplo otro `--base-url` u otra dirección de Ollama) necesita un consentimiento nuevo. Para `generic-cli` el consentimiento se asocia al comando que se mostró, así que cambiar el comando pide uno nuevo.
- `msum provider ls` muestra la fecha (o "ninguno registrado"), y `msum doctor` avisa, sin bloquear nada, cuando un proveedor elegido que envía tus chats afuera no tiene consentimiento registrado.
- El consentimiento es un registro y un recordatorio, no un candado: editar `config.json` a mano es el camino experto y sigue funcionando (una instalación configurada así, por ejemplo con `claude-cli`, anda como antes). El camino guiado es el que lo registra, y `doctor` hace visible la falta.
- Borrar la cuenta (`msum unlink`) borra sus consentimientos.

### 3. `msum secret set <nombre>`

Guarda la clave de API cuando el proveedor la necesita (ver [Claves de API](#claves-de-api)). `provider use` nunca toca las claves; te avisa cuando falta una.

### 4. `msum provider test [--backup] [--kind <nombre>]`

Es el "probar conexión": UNA llamada real al proveedor, con una **conversación inventada** incluida en el programa (nombres inventados), nunca tus mensajes. Antes de la llamada dice adónde va.

- Muestra la latencia y un resumen de la respuesta validada, o el error (sin ninguna clave) y una pista: falta la clave, la clave fue rechazada, el modelo no existe, un límite de uso, un tiempo agotado, un preset deshabilitado, una CLI que no se puede verificar, o un servidor al que no se llega.
- Código de salida 0 si anda, 1 si no.
- `msum doctor` nunca llama a un proveedor; te manda acá.

## Las configuraciones habituales

| Quiero usar | Comandos |
|---|---|
| **Claude Code con tu plan (sin clave)** | `msum provider use claude-cli`, iniciá sesión una vez con `claude` (dentro de un contenedor, ver [Usar una CLI como proveedor](cli-como-proveedor.md#iniciar-sesión)), y después `msum provider test`. |
| **API de Anthropic** | `msum provider use anthropic --model claude-sonnet-5-5`, `msum secret set anthropic`, `msum provider test`. |
| **OpenAI** | `msum provider use openai --model <modelo>`, `msum secret set openai`, `msum provider test`. Para LM Studio, OpenRouter y parecidos: `msum provider use openai-compatible --base-url <url> --model <modelo>`, y `msum secret set openai-compatible` si necesita clave. |
| **Gemini, plan gratuito** | `msum provider use gemini --model <modelo>`, `msum secret set gemini`, `msum provider test`. Google puede usar una clave gratuita para mejorar sus productos (ver [Privacidad](#privacidad-qué-hace-cada-proveedor-con-tus-datos)): marcá los chats sensibles como solo locales. |
| **Ollama, todo en tu máquina** | `ollama pull <modelo>`, `msum provider use ollama --model <modelo>`, `msum provider test`. Con Ollama en esta máquina nada sale de ella, así que no pregunta nada; con `provider.ollama.baseUrl` en otra computadora muestra la información y pregunta, como cualquier proveedor que recibe tus chats. Ver [Elegir un modelo local](modelo-local-ollama.md). |

Agregá un segundo como respaldo con `--backup`, por ejemplo `msum provider use ollama --backup --model <modelo>`.

## Claves de API

**Las claves de API nunca van en `config.json`**: una clave escrita ahí se rechaza, con un mensaje que apunta a esta sección. Se guarda con:

```sh
msum secret set openai        # o anthropic, gemini; con --account <id> para una sola cuenta
```

- La clave se lee de la entrada (oculta mientras la escribís, o por pipe: `msum secret set openai < clave.txt`), nunca de un argumento, que se vería en `ps` y en el historial de tu shell.
- Se guarda en `secrets.json` del directorio de datos (`accounts/<id>/secrets.json` con `--account`), con permisos 600, y nunca se imprime ni se escribe en los logs.
- `msum secret ls` muestra qué proveedores tienen clave y de dónde sale (nunca la clave), y `msum secret rm <proveedor>` quita una.
- La clave se busca en este orden: **variable de entorno** (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`), luego `accounts/<id>/secrets.json`, luego `secrets.json`.

### Las dos claves de OpenAI

Hay dos claves de OpenAI, para que la verdadera nunca vaya a otro servidor.

| Clave | Cómo se guarda | Cuándo se usa |
|---|---|---|
| **`openai`** | `msum secret set openai`, o `OPENAI_API_KEY` | Solo cuando el origen de `baseUrl` es exactamente `https://api.openai.com`. |
| **`openai-compatible`** | `msum secret set openai-compatible`, o `MSUM_OPENAI_API_KEY` | Para cualquier otro `baseUrl`. |

La misma regla vale para los archivos de la cuenta y de la instalación y para el entorno: un servidor compatible nunca recibe la entrada `openai`, y si no necesita clave no se le envía ninguna.

`msum doctor` dice cuál va a usar tu configuración, verifica que el modelo esté definido, que haya una clave y que `secrets.json` (el de la instalación y el de cada cuenta) solo lo pueda leer tu usuario, sin conectarse a nada.

## Límites de uso y reintentos

- Si un proveedor responde "demasiados pedidos", el programa espera el tiempo que indica (`Retry-After`, o el tiempo de espera que Gemini pone en el error) y reintenta.
- Un servidor sobrecargado (503, 529) o un error de red se reintenta con una espera creciente.
- Cada conversación tiene su propio presupuesto, por defecto 3 reintentos y 120 segundos de espera en total (`provider.retry.maxRetries` y `provider.retry.maxWaitMs`). La llamada completa, intentos y esperas juntos, no puede pasar de 300 segundos (`provider.retry.maxTotalMs`).
- Un proveedor que redirige, o que responde con más de 2 MB, hace fallar la llamada: las redirecciones nunca se siguen, porque reenviarían tu chat y tu clave a un servidor que no elegiste.
- Si no alcanza, esa conversación pasa al proveedor de respaldo si hay uno. Si no, el resumen sale con las conversaciones que se pudieron resumir y avisa cuáles quedaron afuera.

## Privacidad: qué hace cada proveedor con tus datos

**El texto de tus chats sale de tu máquina** hacia el proveedor que elijas, salvo las conversaciones de `localOnlyPatterns` (las resume Ollama). Qué hace cada uno con él, según sus propias páginas (revisalas, los términos cambian):

- **OpenAI:** por defecto los datos de la API no se usan para entrenar sus modelos, y los registros de monitoreo de abuso se guardan hasta 30 días. [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data).
- **Anthropic:** por defecto no entrena con las entradas ni las salidas de sus productos comerciales, la API incluida. [Is my data used for model training?](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)
- **Gemini:** con una clave gratuita (sin facturación), Google puede usar lo que enviás para mejorar sus productos, y revisores humanos pueden leerlo; con facturación activada eso no es lo habitual. **No uses una clave gratuita para chats que no quisieras que alguien lea**, y marcá los chats sensibles como solo locales. [Gemini API data logging and sharing](https://aistudio.google.com/docs/logs-policy).
- **Claude Code (`claude-cli`):** lo que hace Anthropic depende del tipo de cuenta: con un plan de consumo (Free, Pro, Max) tus datos pueden usarse para mejorar sus modelos si esa opción está activada, y se guardan 30 días o 5 años según eso; bajo términos comerciales (Team, Enterprise, API) no se usan para entrenar. [Uso de datos de Claude Code](https://code.claude.com/docs/en/data-usage).

## Guías paso a paso

- [Sacar una clave de API de Google (Gemini)](sacar-clave-api-google.md)
- [Instalar Claude Code e iniciar sesión](instalar-claude-y-login.md)

---

Volver al [README](../../README.es.md) · [Índice de guías](README.md)
