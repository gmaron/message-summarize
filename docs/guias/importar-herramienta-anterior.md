# Importar desde la herramienta anterior

Si usabas la instalación anterior de esta idea (la herramienta summaryzing-whatsapp), `msum import --from <ruta>` la trae sin volver a escanear el QR. Solo **copia**: la instalación anterior nunca se modifica, así que queda como camino de vuelta. Volver al [README](../../README.es.md).

## Qué toma y qué no

**Qué toma:**

- la sesión de WhatsApp (byte por byte, privada: directorio 0700, archivos 0600);
- los mensajes con sus ediciones, transcripciones y marcas de leído;
- el estado de no leídos de cada chat, los contactos y sus nombres;
- el puntero del último digest (para que el primer digest no vuelva a resumir el pasado);
- la configuración (traducida a las opciones de este programa, escribiendo solo lo que difiere de tu `config.json`);
- el prompt (`{{nombre}}` pasa a `{{name}}`).

La cuenta queda atada al número de la sesión, así que los digests solo van al chat propio de ese número.

**Qué no toma, y lo dice:**

- los archivos de audio e imagen (solo sus textos y transcripciones);
- el texto leído de las imágenes y los errores de transcripción;
- los digests que esperaban en la cola de envío y los archivos de digests guardados;
- las opciones sin equivalente acá (lectura de imágenes, Whisper, la web) y su estado interno.

Se cuentan en el resumen.

## Opciones

| Opción | Qué hace |
|---|---|
| `--from <ruta>` | La instalación anterior. |
| `--account <id>` | Nombra la cuenta de la instalación principal (por defecto `default`). |
| `--instance <nombre>` | Importa una de sus instancias (`instancias/<nombre>/`, otro celular) con ese nombre. |
| `--all` | Importa la instalación principal y todas las instancias, cada una como su propia cuenta. |
| `--schedule 07:00,19:00` | Pasa las horas de los digests (ver abajo). |
| `--data <dir>` | Dónde están los datos de la herramienta anterior, si no es el lugar habitual (`WA_DATA_DIR`). Solo se lee. |
| `--session-only` | Trae solo la sesión, la configuración y el prompt, sin mensajes. |
| `--yes` | Salta la confirmación. |
| `--force` | Salta la comprobación de que la herramienta anterior esté corriendo (el aviso y la pregunta quedan). |

**Horarios.** La herramienta anterior los guardaba fuera de sus datos (el cron de su sandbox, o launchd), así que no se pueden leer de la carpeta. Pasá las horas con `--schedule 07:00,19:00`, o agregalas después con `msum schedule add`.

**Dónde están sus datos.** Si la herramienta anterior guardaba sus datos en otro lugar (`WA_DATA_DIR`), la importación se niega y lo dice; indicalo con `--data <dir>`.

## Antes de correrlo: detené la herramienta anterior

La misma sesión de WhatsApp no puede correr en dos lugares a la vez, o WhatsApp desconecta a una. El comando te avisa y pide confirmación (o `--yes`), y se niega mientras la herramienta anterior parezca estar corriendo. No guarda ningún archivo de bloqueo, así que se deduce, solo de los metadatos de los archivos:

- un `whatsapp.db-wal` o `-shm` junto a su base (SQLite los borra cuando se cierra la última conexión);
- su base escrita en el último minuto;
- sus archivos de sesión escritos en los últimos diez minutos.

El mensaje dice qué señal saltó; detener la herramienta anterior las hace desaparecer, y `--force` se salta la comprobación. Si corren las dos, el daemon bloquea la cuenta como `replaced` (mirá `msum retry` en [el daemon](demonio-y-horarios.md#bloqueos)) en vez de pelear por ella.

## Seguridad y privacidad

- **Seguro de correr:** se niega con una cuenta que ya está vinculada o tiene datos (desvinculala antes) o que el daemon en marcha está usando, y es todo o nada por cuenta: arma todo aparte y lo mueve a su lugar con un solo rename, así que una falla no deja cuenta ni archivos. Al terminar abre lo que armó, sin conexión, e imprime un resumen con el número enmascarado.
- **Las listas de privacidad nunca se descartan en silencio:** tus chats de `excluir` no se guardan acá (RF-14; el resumen cuenta lo que quedó afuera), y si `soloLocal` (chats que nunca deben salir de tu computadora) no se puede importar, por ejemplo porque no hay modelo de Ollama, se rechaza toda la importación y dice qué arreglar.
- **Caídas:** la importación trabaja en un directorio oculto `accounts/.import-*` con un archivo de pid. El que deja una caída lo borra la próxima importación o el arranque del daemon, y `msum doctor` lo informa (tiene una copia de una sesión). Mientras la importación corre, el candado de la cuenta viaja con ella, así que un daemon en marcha nunca arranca la cuenta a medias.

## Después

Comprobalo con `msum digest --dry-run --account <id>` y arrancá el daemon.

---

Volver al [README](../../README.es.md) · [Índice de guías](README.md)
