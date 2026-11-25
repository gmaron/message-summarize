# message-summarize: decisiones

Por qué el producto y el código son como son. Cada decisión es una línea o dos: fecha, requerimientos afectados, qué se decidió y por qué. La más nueva va arriba. Una decisión no se borra: si cambia, se agrega otra que la reemplaza y la nombra.

Qué hace el producto está en [requirements.md](requirements.md); cómo está construido, en [arquitectura.md](arquitectura.md).

Formato:

```markdown
N. AAAA-MM-DD · RF-xx · Qué se decidió. Por qué.
```

## Decisiones

22. 2026-11-25 · todos · `src/main/` se ordena en una carpeta por área (`config/`, `installation/`, `daemon/`, `link/`, `web/`, `commands/`, `logging/`, `import/`, `system/`) y arriba quedan solo los archivos de la raíz de composición. Tenía 62 archivos sueltos que mezclaban el cableado con el daemon, las rutas de la web y Ask. Es un cambio de lugar, sin cambio de comportamiento; el ejecutable sigue en `dist/main/cli.js`.
21. 2026-11-25 · todos · La spec queda en una sola tabla por área con IDs y criterios de aceptación, las decisiones pasan a este archivo y la arquitectura a [arquitectura.md](arquitectura.md). La tabla de trazabilidad de la versión 1.4 se borra: nombraba componentes de un plan que nunca estuvo en el repositorio. Mantenerla a mano no escalaba; buscar el ID en `test/` y el chequeo `check:spec` la reemplazan.
20. 2026-11-23 · RF-15 · Las descargas de audios ya no esperan a que whisper se ponga al día; solo las limita el tamaño de la carpeta de audios (`transcription.maxMediaMb`). La dirección firmada de un audio vence en semanas y el celular puede borrar el archivo, así que esperar perdía audios; con `transcription.concurrency` en 1 el límite anterior frenaba todas las descargas.
19. 2026-11-23 · RF-10 · Los tipos de mensaje que el adaptador no maneja se guardan como `other`, con su contenido crudo, y quedan fuera de digests, de Ask y del contador de no leídos. Así nada se pierde para reglas futuras, sin que un tipo desconocido ensucie el resumen.
18. 2026-11-23 · RNF-17 · Segunda excepción aprobada: pedirle al celular propio que vuelva a subir un audio viejo (`updateMediaMessage`), como máximo uno cada 2 s y 4 intentos por audio. Sin esto, los audios del historial completo vencidos no se pueden transcribir. No manda nada a terceros.
17. 2026-11-23 · RF-16, RNF-17 · Primera excepción aprobada: `fullHistoryOnLink`, opt-in y apagada por defecto, crea el socket con `syncFullHistory: true`. Solo cambia cuánto historial manda el celular al vincular; no marca en línea ni envía nada.
16. 2026-11-23 · RF-76 · Ask responde con una sola respuesta sobre todos los chats juntos, no una por conversación, con un puerto propio de texto libre (`Answerer`). Una respuesta por chat no servía para preguntas transversales ("qué me pidieron hoy").
15. 2026-11-17 · OBJ-4, RF-07 · El puerto `WhatsAppGateway` del plan original se divide: la entrega es `DeliveryChannel`, y la lectura no es un puerto sino un adaptador que traduce los eventos de la plataforma a los eventos de captura de `CaptureMessages`. Las entidades del dominio usan nombres genéricos (`Conversation`, `Participant`, `Message`). Lo propio de WhatsApp (LID, contador de no leídos del celular, `read-self`) queda en el adaptador.
14. 2026-11-05 · RF-33 · La longitud mínima de un mensaje masivo propio se mide en puntos de código al recibir el mensaje y al resumir, como ya hacía la herramienta anterior al resumir (golden 03, caso E39); al recibir medía unidades UTF-16.
13. 2026-11-05 · RF-10, RF-14, RF-30, RF-32, RF-37, RF-41, RF-73 · Las fallas de la herramienta anterior no se reproducen: los casos de `test/golden/README.md` que no se congelaron porque la herramienta se cae o pierde datos ("Legacy failures that are not frozen") se corrigen, y el comportamiento heredado que sí está congelado se mantiene. Un mensaje sin texto que no es audio se muestra por su tipo; toda opción del digest tiene un valor por defecto (salvo el proveedor, que se elige en el asistente) y la configuración se valida al cargarla; una ventana inválida no mueve el puntero; una prioridad desconocida es un error de esquema. Cada caso tiene un test unitario.
12. 2026-11-05 · todos · Autoría: los commits van solo a nombre del autor, sin coautoría de herramientas de IA.
11. 2026-11-05 · todos · Idioma: código, commits y nombres en inglés; README en inglés y español; los documentos de diseño en español hasta la v0.1.0.
10. 2026-11-05 · RNF-18 · Publicación: repo público `message-summarize` en la cuenta personal de GitHub del autor, con licencia MIT.
9. 2026-11-19 · RNF-05, RNF-07 · Instaladores nativos para Docker, macOS, Linux y Windows en la v1 (antes Windows quedaba para la v1.1). En Windows el daemon se registra con una entrada de inicio de sesión del usuario (clave `Run`), sin permisos de administrador y sin el planificador de tareas. El instalador `.exe` se arma en CI y se distribuye en los releases de GitHub; `npm` es la vía de distribución del paquete.
8. 2026-11-05 · RF-47 · CLIs dentro de Docker: imagen base sin CLIs (API u Ollama) y una variante `-cli` que incluye Claude Code, Gemini CLI y Codex, con la sesión iniciada adentro del contenedor.
7. 2026-11-05 · OBJ-3 · Datos de prueba de la fase 0: conversaciones inventadas que cubren cada regla; nunca datos reales, porque el repo es público.
6. 2026-11-05 · RF-20 · Transcripción con whisper.cpp local, igual que en la herramienta anterior.
5. 2026-11-05 · RF-41, RF-45, RF-47 a RF-49 · Sin proveedor por defecto: el usuario conecta el LLM que prefiera entre OpenAI, Anthropic, Gemini y Ollama, por API o por su propia CLI (Claude Code, Gemini CLI, Codex o una genérica), aprovechando el plan que ya tiene. Gemini es atractivo por su plan gratuito, con la advertencia de privacidad de la sección 7 de los requerimientos. Para Ollama se elige un modelo chico por evaluación.
4. 2026-11-05 · RF-80 · CLI con alias corto `msum`.
3. 2026-11-05 · RNF-19 · Web: la opción más liviana posible, Svelte 5 compilado con Vite.
2. 2026-11-05 · RF-51 · El digest es personal: nunca se manda a otra cuenta, ni siquiera a otra cuenta de la misma instalación.
1. 2026-11-05 · RF-31 · En las fuentes sin estado de leído se resume solo por ventana de tiempo.

Las decisiones 1 a 6 eran la sección 9 de [requirements.md](requirements.md) versión 1.4 y las 7 a 14, la sección 10, en el mismo orden.
