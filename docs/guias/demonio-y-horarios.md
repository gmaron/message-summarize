# El daemon, las cuentas y los horarios

Esta guía explica la configuración inicial (`config.json`), cómo vincular cuentas, qué hace el daemon y cómo se manejan los horarios. Volver al [README](../../README.es.md).

## Configuración inicial (`config.json`)

Desde el código fuente, el primer comando crea el directorio de datos y el archivo:

```sh
npm install
npm run build
node dist/main/cli.js init      # o `msum init` después de `npm link`; crea el directorio de datos y config.json
```

Editá `config.json` en el directorio de datos que muestra `init` (con `MSUM_DATA_DIR` lo ponés en otro lado).

- **Proveedor.** No hay proveedor por defecto: `init` escribe `"primary": null`. Tenés que definir `provider.primary` explícitamente (`"claude-cli"`, `"ollama"`, `"openai"`, `"anthropic"` o `"gemini"`) antes de que funcionen `digest` o los horarios. Con todos menos `claude-cli`, configurá también el modelo: `provider.<nombre>.model`. Mirá la [guía de proveedores](proveedores.md).
- **Zona horaria.** Revisá `timezone`: `init` imprime la que escribió, la del sistema. **En Docker, definí `TZ` o `timezone` en la configuración.**
- **Nombre.** Revisá `ownerName`.
- **Horarios.** Las horas de los digests ya no están en este archivo: mirá [Horarios](#horarios).
- **`promptFile`.** Un `promptFile` relativo se lee desde el directorio del archivo que lo define: el directorio de datos para `config.json`, `accounts/<id>/` para el archivo propio de una cuenta.
- **`askHints`.** Contexto opcional para la pestaña "Pedir", escrito por vos: una lista de `{ "when": [...], "text": "..." }`. Cuando la consulta contiene alguna palabra o frase de `when` (palabras completas, sin distinguir mayúsculas ni acentos: `"pedido"` no coincide con `"pedidos"` salvo que también la listes), el `text` se agrega al prompt como contexto que viene de vos, para que el modelo entienda tu vocabulario. Ejemplo: `"askHints": [{ "when": ["encargo", "encargos"], "text": "Un encargo es una torta por pedido, no una consulta." }]`. Hasta 20 contextos, 20 palabras por contexto y 2000 caracteres por texto. El digest no lo usa. El valor de una cuenta reemplaza al de la instalación (no se suma).
- **Errores.** Los valores inválidos se rechazan con un mensaje que nombra la opción.

Los textos de la línea de comandos están en español o inglés (`language` en `config.json`). Todo queda en tu máquina, en el directorio de datos (con permisos solo para tu usuario), salvo lo que recibe el proveedor de LLM que elegiste.

## Vincular una cuenta

`msum link` muestra un código QR en la terminal (también queda como `qr.png` mientras es válido). Escaneálo desde WhatsApp, Ajustes > Dispositivos vinculados. Espera el historial inicial y termina. La página web hace lo mismo: ver [la web y las cuentas](web-y-cuentas.md).

## El daemon

`msum daemon` conecta todas las cuentas, captura los mensajes, ejecuta los horarios y entrega cada resumen al chat propio de esa cuenta. Dejalo corriendo: Ctrl+C lo detiene de forma ordenada.

- Corre **un solo daemon por instalación**, y corre **todas las cuentas**.
- Cada cuenta está aislada (su propia conexión, horarios, recuperación de ejecuciones perdidas y entrega): una cuenta bloqueada o que falla no detiene a las otras.
- Una falla dentro de una cuenta reinicia solo esa cuenta, con una espera creciente.
- `msum daemon --account <id>` corre solo esa cuenta: sirve para depurar.
- Una cuenta con la configuración inválida, o con horarios y sin proveedor, se avisa y queda inactiva mientras las otras corren. El daemon se niega a arrancar solo si `--account` nombra una cuenta así, o si todas lo están.
- Una cuenta sin nada vinculado queda inactiva: no se abre ninguna conexión para ella.

### Bloqueos

Si WhatsApp cierra una sesión, rechaza la conexión (403) o la reemplaza, o la sesión es de otro número, el daemon deja de conectar **esa** cuenta, escribe `accounts/<id>/blocked.json` y la deja inactiva. Así un gestor de servicios que reinicia el daemon no reconecta en bucle, algo que podría hacer bloquear el número. `msum status` muestra el motivo, y el estado de la conexión de cada cuenta mientras el daemon corre.

| Situación | Cómo se arregla |
|---|---|
| Conexión rechazada o reemplazada | `msum retry --account <id>`. El daemon en marcha vuelve a tomar la cuenta en pocos segundos. |
| La sesión no sirve | Vincular de nuevo: `msum unlink --account <id>` y después `msum link --account <id>`. |
| Arrancar el daemon limpiando bloqueos | `msum daemon --retry` borra, antes de arrancar, exactamente los bloqueos que borra `msum retry` (una sesión muerta sigue bloqueada). |

Un bloqueo nunca se levanta solo: que falte `blocked.json` cuenta como "borrado" solo si el daemon sabe que estuvo en disco.

Si la conexión de una cuenta sigue fallando (5 fallas seguidas, con esperas crecientes; una unidad que se mantiene conectada 10 minutos reinicia el conteo de fallas), el daemon deja de intentar y la bloquea (`socketFailed`) en vez de entrar en un bucle. `msum retry` la devuelve.

### El daemon sigue mirando la instalación

- Una cuenta que vinculás después arranca sola, una que se borra se detiene, y un bloqueo borrado se reintenta.
- Podés correr `msum link --account <id-nuevo>` con el daemon corriendo: la cuenta queda bloqueada para el daemon mientras se vincula (`accounts/<id>/link.lock`), y el daemon la arranca recién cuando termina la vinculación.
- `msum link` y `msum unlink` rechazan una cuenta que el daemon está usando (vinculada y sin bloqueo), porque es dueño de su sesión: detené el daemon primero. Las cuentas que no usa (sin vincular, o bloqueadas) se pueden vincular o desvincular con el daemon corriendo.

### Registrar el daemon como servicio

`msum service install|uninstall|status` registra solo el daemon para que arranque con tu sesión y vuelva tras una caída: launchd en macOS, `systemd --user` en Linux, una entrada `Run` de tu usuario en Windows. No pide permisos de administrador, y los horarios siguen dentro del daemon.

## Varias cuentas

Una instalación puede tener varias cuentas: `msum link --account trabajo` crea y vincula una (los ids son letras minúsculas, dígitos y guiones), y `msum accounts` las lista.

- `link`, `unlink`, `digest`, `daemon`, `status` y `doctor` aceptan `--account <id>`. Es opcional mientras haya una sola cuenta; `status` y `doctor` recorren todas las cuentas sin él.
- Cada cuenta puede tener su propio `config.json` en `accounts/<id>/` que pisa al del directorio de datos:
  - sus opciones de primer nivel reemplazan a las de la instalación;
  - `provider` se combina clave por clave;
  - las listas de privacidad `localOnlyPatterns` y `excludePatterns` se **suman** a las de la instalación (nunca las reemplazan), así que una cuenta solo puede volverlas más estrictas.
- Un patrón es un pedazo de `<id> <nombre>` sin distinguir mayúsculas ("ana" también coincide con "Mariana"), salvo `id:<id de la conversación>`, que coincide exactamente con ese id. Es lo que escribe la página web al marcar un chat, porque un id común como `9963667784458@s.whatsapp.net` también está contenido en `19963667784458@s.whatsapp.net`.
- `msum unlink --account trabajo` borra solo los datos de esa cuenta.
- Una instalación anterior a esta estructura (`account/`) se mueve sola a `accounts/default/`, sin ningún daemon corriendo.

## Horarios

Cada cuenta corre sus digests en días de la semana a una hora local, guardados en la base de datos y manejados con `msum schedule` (agregá `--account <id>` cuando hay más de una cuenta).

| Comando | Qué hace |
|---|---|
| `msum schedule ls` | Los lista con su id, días, hora y próxima ejecución en la zona horaria de la cuenta. |
| `msum schedule add --time 09:00 [--days ...]` | Agrega uno (todos los días si no ponés `--days`). `--days` acepta `daily`, `weekdays`, `weekends`, `mon,wed,fri` o `mon-fri`. Los nombres de los días valen en inglés y en español (`lun`, `mar`, `mie`/`mié`, `jue`, `vie`, `sab`/`sáb`, `dom`). |
| `msum schedule rm <id>` | Borra uno de los horarios de esa cuenta. Para cambiar una hora, borrala y agregá la nueva. |

Reglas:

- Un daemon en marcha toma los cambios en unos cinco segundos, sin reiniciar. Estos comandos funcionan con el daemon corriendo.
- Las horas siguen la `timezone` de la cuenta y sus cambios de horario de verano: una hora que no existe el día del cambio corre en la primera hora válida posterior, y una hora que ocurre dos veces corre una sola vez.
- Una ejecución perdida (la máquina estaba apagada) se recupera una sola vez al arrancar el daemon.
- `msum init` no escribe horarios y una cuenta nueva empieza sin ninguno, así que no corre ningún digest por su cuenta hasta que agregues uno (`msum link` y `msum doctor` te lo recuerdan). El asistente de la web crea 09:00 y 18:00 todos los días.

### Configuraciones de versiones anteriores

La opción `schedules` de `config.json` (expresiones cron, en el archivo de la instalación o en el de una cuenta) se sigue importando una sola vez por cuenta, la primera vez que se usa la cuenta.

- Las horas que se pueden expresar (una hora fija en cualquier día de la semana) pasan a ser horarios.
- Las demás no se importan y `msum doctor` las lista como aviso.
- Después la opción se ignora (`doctor` avisa, y podés borrarla), así que un horario que borrás no vuelve, y `config.json` nunca se reescribe.
- La opción acepta cualquier lista de textos, así que un valor viejo nunca impide que la configuración cargue.

## Generar un resumen a mano

`msum digest --dry-run` genera un resumen ahora y lo muestra, sin guardar ni enviar nada. Sin `--dry-run` el resumen queda en cola y lo entrega el daemon que esté corriendo. No abre una conexión a WhatsApp (la sesión es del daemon). Opciones: `--hours N`, `--from "AAAA-MM-DD HH:MM"`, `--to "AAAA-MM-DD HH:MM"`.

## Otros comandos

| Comando | Qué hace |
|---|---|
| `msum status` | Cuenta, último resumen, envíos pendientes, próximas ejecuciones. |
| `msum doctor` | Revisa Node, permisos, configuración, proveedor, vinculación y, si está activada, la transcripción. |
| `msum whisper models\|download <nombre>` | Ver [Transcribir notas de voz](transcripcion.md). |
| `msum service install\|uninstall\|status` | Ver [arriba](#registrar-el-daemon-como-servicio). |
| `msum unlink` | **Borra todos los datos de la cuenta**: sus mensajes, los audios que descargó, el historial de resúmenes, los envíos pendientes y la sesión de WhatsApp. La configuración queda. Pide confirmación. Después, quitá también el dispositivo en el celular (WhatsApp, Ajustes > Dispositivos vinculados). |

---

Volver al [README](../../README.es.md) · [Índice de guías](README.md)
