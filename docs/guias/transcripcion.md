# Transcribir notas de voz (opcional)

Viene desactivada. Esta guía explica qué hace, cómo activarla y sus límites. Volver al [README](../../README.es.md).

## Qué hace

Cuando está activada:

- Las notas de voz y los audios que llegan **mientras el daemon está conectado**, y los de los **últimos 14 días del historial** que WhatsApp manda al vincular (`historyAudioDays`; los más viejos quedan como `🎤 (audio sin transcribir)`), se descargan de WhatsApp a `accounts/<id>/media/` (directorio 0700, archivos 0600).
- Se transcriben **en tu máquina** con [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
- El resumen muestra el texto donde diría `🎤 (audio sin transcribir)`.
- El audio nunca se envía a ningún servicio.
- **Lo que se conserva es el texto:** el archivo de audio se borra apenas se transcribe, o falla definitivamente. `msum unlink` borra lo que quede, junto con el resto de la cuenta.

Con la transcripción desactivada, o si falta whisper, ffmpeg o el modelo, **todo lo demás funciona igual** y los audios aparecen como `🎤 (audio sin transcribir)`; `msum doctor` dice qué falta. Un audio que no se puede transcribir queda registrado como fallido y no se reintenta.

## Cómo activarla

1. **Instalá whisper.cpp**, que trae el programa `whisper-cli` (por ejemplo `brew install whisper-cpp` en macOS, o compilalo desde el código fuente siguiendo su README en Linux).
2. **Instalá ffmpeg** (`brew install ffmpeg`, `apt install ffmpeg`...): convierte el audio al formato que lee whisper.
3. **Descargá un modelo:** `msum whisper models` lista los modelos ggml conocidos con su tamaño, y `msum whisper download base` descarga uno en `<directorio de datos>/models/`, mostrando el progreso y verificando un checksum SHA-256 fijado en el programa. Un archivo que no coincide se descarta y no queda nada. `base` y `small` son un buen comienzo para notas de voz; los modelos más grandes son más precisos y más lentos.
4. **Activala** en `config.json` (o en el archivo propio de una cuenta):

   ```json
   "transcription": { "enabled": true, "model": "base", "language": "auto" }
   ```

## Opciones

| Opción | Por defecto | Qué significa |
|---|---|---|
| `enabled` | `false` | Activa la transcripción. |
| `model` | ninguno | El nombre de un modelo en `<directorio de datos>/models/` (`base`, `small.en`...), o la ruta de un archivo ggml. |
| `language` | `auto` | `auto` detecta el idioma de cada audio; o un código como `es` o `en`. Cada cuenta puede tener el suyo. |
| `whisperCommand` | `whisper-cli` | El programa de whisper.cpp (un nombre del `PATH`, o una ruta). |
| `ffmpegCommand` | `ffmpeg` | El programa ffmpeg. |
| `timeoutMs` | `300000` | Lo máximo que puede tardar un audio, ffmpeg incluido. Un programa que tarda más se mata. |
| `historyAudioDays` | `14` | También se descargan y transcriben los audios del historial de los últimos N días. **`0` significa sin límite: todo el historial** (un historial completo puede traer miles de audios; ver [Un historial completo](#un-historial-completo-muchos-audios-en-paralelo)). |
| `maxMediaMb` | `500` | Lo máximo que pueden ocupar juntos los audios descargados de una cuenta, en MB. |
| `concurrency` | `1` | Cuántas transcripciones corren a la vez (de 1 a 16), cada una un proceso `whisper-cli` aparte. |
| `threads` | `1` | Hilos (`-t`) de cada proceso `whisper-cli` (de 1 a 64). |
| `downloadConcurrency` | `2` | Cuántas descargas de audios corren a la vez (de 1 a 16). |

## Límites, porque el audio viene de otras personas

- Las descargas solo vienen del servidor de medios de WhatsApp, y solo para un mensaje que trae una ruta de medios de WhatsApp común. Cualquier otra cosa que el remitente escriba en el mensaje (una dirección, un servidor) se ignora y el audio queda registrado como fallido (`invalid-media-path`).
- Un archivo de más de 25 MB no se descarga; una descarga se corta a los 60 segundos; y los audios que una cuenta guarda en disco no pueden pasar de `maxMediaMb` (500 por defecto; pasado ese límite los nuevos se rechazan, `media-cap`, y `msum doctor` avisa antes).
- Solo se convierten los formatos de audio de WhatsApp (notas de voz Ogg Opus, MP3, M4A/MP4, AAC, AMR). ffmpeg corre con el formato de entrada forzado, solo puede leer un archivo (`-protocol_whitelist file`), lee como máximo 30 minutos (`-t 1800`) y escribe como máximo unos 60 MB (`-fs`).

### Nada se pierde por un reinicio

- Los audios por descargar esperan en una cola guardada en la base de la cuenta (con lo necesario para descargar cada uno), y el daemon la recorre del más viejo al más nuevo, hasta `downloadConcurrency` a la vez: una primera vinculación con cientos de audios solo tarda, y la memoria guarda solo los audios que se están descargando.
- Una descarga cortada por una parada, un reinicio o una conexión caída sigue en la cola y se retoma.
- Una falla de descarga pasajera se reintenta con espera creciente (30 segundos, luego 1, 2 y 4 minutos: 5 intentos), y después el audio queda registrado como fallido (`download-failed`).
- Un audio pendiente no tiene límite de antigüedad: si WhatsApp ya no tiene su archivo, se le pide de nuevo a tu celular (ver más abajo) y queda registrado como fallido (`expired`) solo si eso no funciona. Uno demasiado grande o una carpeta llena fallan en el acto.
- La clave para descifrar cada archivo vive solo en esa base mientras espera, y se borra apenas el archivo se guarda o la descarga falla definitivamente; nunca se escribe en los logs.

## Cómo se transcriben los audios

Por defecto **un solo whisper a la vez en todo el programa** (`concurrency: 1`), sin importar cuántas cuentas haya. Con `concurrency` mayor que 1, corren hasta esa cantidad a la vez en todo el programa, cada uno un proceso aparte. Los audios se transcriben en segundo plano, **del más nuevo al más viejo** (lo que acaba de llegar se lee primero), apenas se descargan: no esperan a un resumen. Justo antes de cada resumen, los audios de su ventana que todavía esperan se transcriben primero (del más viejo al más nuevo), y el resumen los espera como máximo dos minutos: lo que no está listo sale como sin transcribir y se termina después.

La cola vive en la base de la cuenta. Cada transcriptor toma el próximo audio pendiente y lo marca en curso en un solo paso, así que dos nunca se llevan el mismo. Si el proceso se detiene, el audio que estaba en curso vuelve a la cola cuando arranca de nuevo, y el trabajo sigue donde estaba.

## Un historial completo: muchos audios, en paralelo

Vincular una cuenta con todo su historial (`historyAudioDays: 0`) puede traer miles de audios. Una configuración para una máquina que tiene que pasar por todos:

```json
"transcription": {
  "enabled": true, "model": "large-v3-turbo-q5_0", "language": "es",
  "historyAudioDays": 0, "concurrency": 8, "threads": 1, "downloadConcurrency": 4
}
```

- **CPUs:** alrededor de `concurrency × threads`. Conviene más `concurrency` que `threads`: varios audios a la vez aprovechan mejor la CPU que uno con muchos hilos. Por ejemplo, con 8 CPUs, `concurrency: 8, threads: 1` (o `concurrency: 4, threads: 2`).
- **RAM:** alrededor de **1 GB por transcripción simultánea** con `large-v3-turbo-q5_0` (así que `concurrency: 10` pide unos 10 GB, más el resto del programa). Con menos RAM, bajá `concurrency`. Si el daemon corre en un contenedor (un sandbox), dale esas CPUs y esa memoria, o el sistema va a matar procesos de whisper.
- La memoria queda acotada: las descargas y las transcripciones toman filas de la base de a una, nunca la cola entera.
- Progreso: cada 60 segundos, si cambió, el daemon registra `transcription.stats` con solo cantidades (`pending`, `downloading`, `running`, `done`, `failed`, `reuploadRequested`).

### Audios viejos: se piden de nuevo a tu celular

WhatsApp borra los medios de sus servidores pasadas unas semanas, así que los audios de un historial viejo responden "ya no está" (404 o 410). **Solo para audios**, el programa usa entonces la función estándar de cualquier dispositivo vinculado: le pide a **tu propio celular** que suba el archivo de nuevo (un pedido de reintento de medio dirigido a tu propia cuenta; no le envía nada a nadie más ni toca la conversación). Cuando el celular responde, la descarga sigue.

- Como máximo empieza un pedido cada 2 segundos.
- Cada audio se pide como máximo 4 veces (con espera creciente de 1, 4 y 16 minutos si el celular no responde); después, o si el celular dice que tampoco tiene el archivo, queda registrado como fallido (`expired`) y se muestra como sin transcribir.
- El celular tiene que estar prendido y con conexión para responder. Los audios de las últimas semanas no lo necesitan.

### `msum digest` y el daemon

- Mientras el daemon corre, es el dueño de la transcripción: `msum digest` no ejecuta whisper, solo espera (como máximo los mismos dos minutos) a que el daemon termine los audios de su ventana.
- Sin daemon, `msum digest` transcribe por su cuenta.
- Esto vale también para `--dry-run`: una transcripción es un dato capturado, como un mensaje, no un resultado del resumen, así que una vista previa puede guardarla, y aun así no mueve el puntero ni escribe nada en el historial ni en la cola de envío.

## Cómo corren los programas

Los programas corren sin shell, en un directorio temporal vacío, con un entorno mínimo, y se matan si pasan el tiempo límite. Si al daemon mismo lo matan con `SIGKILL` nadie puede matarlos por él (Node no puede pedirle eso al sistema), así que un audio en curso termina solo; una parada normal (Ctrl+C, `SIGTERM`) sí los mata.

---

Volver al [README](../../README.es.md) · [Índice de guías](README.md)
