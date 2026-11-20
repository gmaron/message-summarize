# Usar una CLI como proveedor

Si ya pagás un plan, o no querés sacar una clave de API, un proveedor puede ser un programa de tu máquina que usa la sesión con la que ya iniciaste. Volver al [README](../../README.es.md).

Hay tres presets, `claude-cli`, `gemini-cli` y `codex-cli`, y un modo `generic-cli` (cualquier comando). Todas son **externas** igual que las APIs: las conversaciones de `localOnlyPatterns` nunca llegan a ellas.

## La regla (RF-49)

Los chats los escriben otras personas, y una CLI es un agente que puede leer archivos y ejecutar comandos: un texto de un chat podría intentar que lo haga (prompt injection). Por eso un preset de CLI solo se usa cuando se puede **verificar** que corre sin herramientas.

- Antes de la primera llamada, y en `msum doctor`, el programa ejecuta `<cli> --help` y `<cli> --version`. Nunca hace una llamada al modelo, y lo hace en un directorio temporal vacío, con el entorno de [más abajo](#qué-recibe-la-cli).
- Tienen que figurar todos los flags en los que se apoya el endurecimiento.
- Si falta uno, el proveedor queda no disponible con el motivo "esta versión de X no se puede ejecutar sin herramientas", y la conversación pasa al proveedor de respaldo.
- El resultado se recuerda por ruta y fecha de modificación del programa, así que una actualización se vuelve a revisar.

## Los presets

| Preset | Estado | Flags y para qué |
|---|---|---|
| `claude-cli` | habilitado | `claude -p --model <m> --system-prompt <s> --json-schema <schema> --output-format json --tools '' --strict-mcp-config --no-session-persistence --safe-mode --disable-slash-commands`. Ver la lista de abajo. |
| `gemini-cli` | **deshabilitado** | Gemini CLI (`-p`, `-o json`) no documenta ningún flag que apague sus herramientas: `--allowed-tools` está obsoleto, `--allowed-mcp-server-names` y `--extensions` solo seleccionan, `--approval-mode plan` es de solo lectura pero igual tiene herramientas (leer archivos, traer páginas web), y las sesiones no se pueden apagar. Existe una política que deniega todo, pero su flag (`--admin-policy`) se documenta sin decir si recibe un archivo o un directorio, y se ignora cuando hay archivos de política en la ubicación del sistema. |
| `codex-cli` | **deshabilitado** | `codex exec --sandbox read-only --ephemeral --ignore-user-config --output-schema <archivo>` restringe lo que los comandos pueden escribir, no guarda sesión y fuerza un esquema, pero la herramienta de shell sigue disponible: la documentación dice que el sandbox limita los "comandos de shell generados por el modelo", no que los quite, y ningún interruptor documentado apaga juntos el shell, MCP y la búsqueda web. |

Los flags de `claude-cli`:

- `-p` es el modo sin interfaz.
- `--json-schema` fuerza el formato del resumen de forma nativa.
- `--tools ''` apaga todas las herramientas.
- `--strict-mcp-config` no carga ningún servidor MCP.
- `--no-session-persistence` no guarda sesión.
- `--safe-mode` ignora tus personalizaciones (CLAUDE.md, skills, plugins, hooks, MCP), así que ningún hook recibe el chat.
- `--disable-slash-commands` apaga comandos y skills.
- El chat va por stdin, nunca como argumento.

Un preset deshabilitado hace fallar cada llamada en el acto con ese motivo y `msum doctor` lo dice; no se ejecuta nada. Se habilitarán cuando se pueda verificar en `--help` una forma documentada de apagar las herramientas. Mientras tanto la CLI genérica puede ejecutarlos, con el riesgo de [más abajo](#la-cli-genérica).

Fuentes: la documentación de [Claude Code](https://code.claude.com/docs/en/network-config), [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md) y [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Qué recibe la CLI

Solo estas variables, cuando están definidas, y nunca una de tus claves de API:

| Variable | Para qué |
|---|---|
| `PATH` | Encontrar el programa y su runtime. |
| `HOME`, `USER`, `LOGNAME` | Encontrar tu sesión existente. |
| `CLAUDE_CONFIG_DIR` | Una sesión guardada en otro lado (solo Claude). |
| `LANG`, `TZ` | Idioma y zona horaria. |

Las variables de proxy y certificados no se pasan: definilas donde la propia CLI las lee. La CLI corre sin shell, en un directorio temporal nuevo y vacío que se borra después, con un tiempo límite que mata todo el grupo de procesos (nietos incluidos), y como máximo 2 MB de salida.

## Iniciar sesión

La CLI usa la sesión que ya iniciaste para ella. Dentro de un contenedor Docker o sandbox la sesión se inicia adentro, una vez, y se guarda en un volumen. Para Claude:

1. Ejecutá `claude` en el contenedor (por ejemplo `docker exec -it <contenedor> claude`, o `sbx claude` si usás `sbx`).
2. Iniciá sesión.
3. Guardá su directorio de configuración (`~/.claude`, o el de `CLAUDE_CONFIG_DIR`) en un volumen para que el daemon lo vea.

Con Docker Compose, el perfil `cli` ya trae las CLIs: `docker compose -f docker/compose.yaml --profile cli up -d` (Gemini CLI y Codex están deshabilitadas por ahora). Paso a paso en [Instalar Claude Code e iniciar sesión](instalar-claude-y-login.md).

## El formato de la respuesta (RF-48)

- `claude-cli` fuerza el esquema con `--json-schema`; si aun así la respuesta no sirve, se le pide una vez más que la corrija.
- A una CLI sin flag de esquema nativo (la genérica) se le pone el esquema en el prompt, la respuesta se valida y, si es inválida, se le pide UNA vez más con un mensaje que dice qué estaba mal. Si falla otra vez, la conversación pasa al proveedor de respaldo (RF-42).

## La CLI genérica

`generic-cli` ejecuta cualquier comando que reciba el prompt e imprima texto con la respuesta:

```json
"provider": {
  "primary": "generic-cli",
  "genericCli": { "command": ["mi-llm", "--json", "{{prompt}}"], "timeoutMs": 180000, "acknowledgeRisk": true }
}
```

- `command` es una lista de argumentos, sin shell y sin interpolación dentro de un elemento. No hay comando por defecto.
- **Por defecto el prompt va por stdin, que es privado.**
- Un elemento que es exactamente `{{prompt}}` recibe en cambio el prompt completo. Usalo solo para una herramienta que no puede leer stdin, porque **los argumentos los ven otros usuarios de la máquina** (`ps`) y un chat largo puede pasar el límite de tamaño de los argumentos. `msum doctor` avisa cuando el comando lo usa. `{{prompt}}` nunca es el programa ni parte de un elemento más largo.
- **No se puede endurecer:** el comando puede ejecutar herramientas sobre texto escrito por terceros, así que se rechaza salvo que pongas `acknowledgeRisk` en `true`. `msum doctor`, `msum digest` y el daemon imprimen este aviso cada vez que está por usarse. Preferí un proveedor que corre sin herramientas.

---

Volver al [README](../../README.es.md) · [Índice de guías](README.md)
