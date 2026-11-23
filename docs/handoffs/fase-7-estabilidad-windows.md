# Handoff: fase 7, estabilidad de la suite y del CI en Windows

Para quien retome el trabajo (persona o agente). Escrito el 2026-11-19, al cierre de la fase 6. Los requisitos que cubre son RNF-05 (matriz de CI con Windows), RNF-08 (durabilidad) y RNF-15 (CI en verde en cada PR).

## Dónde estamos

- Rama `feature/phase-5-installers`, PR #4 contra `main`. Incluye la fase 5 (instaladores) y la fase 6 (CI, avisos, documentos). Último commit propio: `7cba210`.
- En el CI del PR pasan: `quality`, `docker-smoke`, los tres `install-smoke` (incluida la actualización y la desinstalación en Windows), y todos los tests en Linux y macOS.
- No pasan, de forma intermitente o determinista: los tests de `windows-latest` (Node 22 y 24). `docker-multiarch` no corrió nunca (solo corre en push a `main` y a mano).
- Hay un proceso o sesión aparte que edita este mismo árbol (proveedores, secretos, consentimiento, textos de la web). Al commitear, agregar solo los archivos propios de la tarea y nunca `git add -A`.

## Objetivo de la fase

Dejar `test (windows-latest, node 22)` y `test (windows-latest, node 24)` en verde de forma estable, sin debilitar ninguna regla de AGENTS.md (en especial la regla de ban: nada se reconecta solo tras un bloqueo; RNF-04 sin secretos en logs; RNF-17), y sin usar `retry` de Vitest para tapar fallos.

## Lo que se sabe de los fallos (corrida sobre `0fc9344`)

Los logs se bajan con `gh api --allow-escape-sequences repos/gmaron/message-summarize/actions/jobs/<id>/logs | sed 's/\x1b\[[0-9;]*m//g'`. Los ids salen de `gh api repos/gmaron/message-summarize/actions/runs/<run>/jobs`.

1. **`EPERM` en el `rename` de `blocked.json` (problema real de producto, prioridad 1).** `writeFileAtomic` (`src/main/atomic-write.ts`) renombra un temporal sobre el destino. En Windows falló con `EPERM` (visto en `web-retry.test.ts`, "does not make a block that WhatsApp did not ask to wait for wait"). Si un lector (el poll del host, `msum status`, un antivirus) tiene el destino abierto, el marcador de ban podría no persistirse. Arreglo propuesto: reintentar el `rename` unas veces (por ejemplo 5, con pausa corta) ante `EPERM`, `EBUSY` y `EACCES`, como hace graceful-fs, con test que inyecte el fallo y mutación que lo detecte. Si agota los intentos, el error se propaga como hoy y el temporal se borra.
2. **Dos tests de `daemon-host.test.ts` fallan de forma determinista en Windows**, en ambos Node:
   - "a marker is never on disk while the account still has a socket or a database open": esperaba `['alpha','beta']` y recibió `['alpha','alpha']`.
   - "a block whose marker was on disk and is gone starts the account again": agota los 5000 ms esperando que la cuenta arranque de nuevo.
   Hipótesis: consecuencia de (1) o de que en Windows el marcador y el temporal se observan distinto durante el rename. Reproducir leyendo el test y el orden de escrituras; no asumir.
3. **Timeouts de 30 s en tests ajenos** (`test/golden/harness.test.ts` escenario 02, `preview.test.ts`, `runtime-reconfigure.test.ts`) y hasta el de `install-ps1.test.ts` (-DryRun) agotó sus 120 s. Esos tests pasaron en corridas anteriores, así que parece un runner lento. Propuesta: subir `--testTimeout` solo en Windows dentro de `.github/workflows/ci.yml` (por ejemplo 90000), con comentario, y confirmar que deja de aparecer.
4. **Tests sensibles a tiempo ya conocidos**: `web-setup.test.ts` ("reports the codes: timeout, missing command, invalid summary, failed"), `web-link.test.ts` y `web-settings.test.ts`. Endurecerlos como se hizo en el commit `4b9534a` (esperar condiciones, no tiempos fijos).
5. **Handles abiertos al borrar temporales** (`EPERM`/`EBUSY` al borrar `db.sqlite` en `preview.test.ts`): cerrar bases y sockets y esperar su cierre antes del `rmSync`; `test/support/cli-harness.ts` ya reintenta el borrado (`removeDir`).

## Orden sugerido (un commit por paso, cada uno revisado por el `reviewer` antes de commitear)

1. Reintento del `rename` en `writeFileAtomic`, con test y mutación.
2. Diagnóstico y arreglo de los dos tests de `daemon-host`. Si resulta un bug real de `src/`, informarlo antes de arreglarlo.
3. `--testTimeout` solo en Windows en `ci.yml`.
4. Endurecer los tests sensibles a tiempo que sigan apareciendo.
5. Volver a correr el CI al menos dos veces seguidas en verde antes de dar la fase por cerrada.

## Cómo verificar

Windows solo se puede verificar en GitHub Actions: push y mirar `gh pr checks 4`. Para esperar sin sondear: un `until` que termine cuando el job `quality` figure y ninguno esté `pending`. En la Mac, la suite completa se satura (cargas de 20 o más por procesos ajenos): usar `--maxWorkers=4 --testTimeout=30000` y repetir solo el archivo que falle. Una sola corrida completa por ronda.

## Quedó fuera de esta fase

- Decisión de licencia sobre libsignal (GPL-3.0, vía Baileys): bloquea `npm publish` hasta resolverse.
- Changelog y preparación de la `v0.1.0`. No publicar sin el OK de Gastón.
- Activar "Private Vulnerability Reporting" en el repositorio y marcar los checks como requeridos en la protección de rama (RNF-15).
- Documentar qué permiten Claude, ChatGPT/Codex y Gemini para el uso automatizado de sus CLIs (sección 7 de los requisitos).
- Limitaciones anotadas sin arreglo: `daemon.log` sin `O_NOFOLLOW` en Windows (riesgo bajo, comentado en `src/main/log-file.ts`); el smoke de instalación no comprueba que `node_modules.old` desaparezca tras actualizar; las escrituras temporales huérfanas si el proceso muere a mitad de escritura (nombre `.<archivo>.<pid>.<hex>.tmp`) no se barren al arrancar.
