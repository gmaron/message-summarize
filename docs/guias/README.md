# Guías de msum

Guías de uso y de referencia, en español. [English](../guides/README.md) · Volver al [README](../../README.es.md).

## Para empezar

- [Cómo funciona, explicado sin tecnicismos](como-funciona.md): qué problema resuelve la aplicación y qué pasa desde que llega un mensaje hasta que recibís el resumen. Para quien no sabe de programación.

## Paso a paso, para dejar listo el proveedor

Guías cortas y sin jerga.

- [Sacar una clave de API de Google (Gemini)](sacar-clave-api-google.md): para usar Gemini como proveedor.
- [Instalar Claude Code e iniciar sesión](instalar-claude-y-login.md): para usar "Claude (línea de comandos)" con tu plan de Claude.

Las dos guías se verificaron contra las páginas oficiales el 2026-11-20. Los proveedores cambian sus pantallas y sus precios: ante la duda, mandan sus páginas.

## Referencia

| Guía | Qué explica |
|---|---|
| [Elegir y probar el proveedor de LLM](proveedores.md) | Proveedores, `provider ls/use/test`, claves de API, reintentos y privacidad de cada uno. |
| [Usar una CLI como proveedor](cli-como-proveedor.md) | Claude Code y la CLI genérica, la regla de "sin herramientas" y por qué Gemini CLI y Codex están deshabilitadas. |
| [Transcribir notas de voz](transcripcion.md) | whisper.cpp, opciones, límites y cola de descargas. |
| [Elegir un modelo local (Ollama)](modelo-local-ollama.md) | Candidatos, evaluación y comandos `msum ollama`. |
| [Importar desde la herramienta anterior](importar-herramienta-anterior.md) | `msum import`. |
| [A qué se conecta el programa](red-y-privacidad.md) | Todos los destinos de red. |
| [La página web, el asistente y las cuentas](web-y-cuentas.md) | La web, el asistente de primer uso, exclusiones, aceptaciones y pedidos sobre tus chats. |
| [El daemon, las cuentas y los horarios](demonio-y-horarios.md) | `config.json`, el daemon, bloqueos, varias cuentas y `msum schedule`. |
