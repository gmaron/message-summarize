#!/bin/sh
# message-summarize installer for macOS and Linux (OBJ-1, RNF-05, RNF-06, RNF-07).
#
#   curl -fsSL https://raw.githubusercontent.com/gmaron/message-summarize/main/packaging/install.sh | sh
#   curl -fsSL <url>/install.sh | sh -s -- --no-service      (arguments after --)
#
# No sudo, nothing outside your home directory. It installs the package with its own copy of Node.js (or the one
# you already have, when it is recent enough), puts `msum` and `message-summarize` in ~/.local/bin, creates the
# configuration, registers the daemon as a user service and opens the web. Run it again to upgrade.
# The only hosts it talks to are nodejs.org (only when Node.js is missing), the npm registry (or the tarball URL you
# give) and nothing else. No telemetry. It never prints the web token itself: `msum open` does, once.
#
# Exit codes: 0 done | 1 failure | 2 wrong arguments | 3 unsupported system (use Docker) | 4 a tool is missing |
#             5 checksum mismatch | 6 installed, but the service could not be registered
set -eu

# Pinned Node.js LTS (>= 22.16, the engines of the package). Bump together with a release.
NODE_VERSION="22.23.5"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=16
NODE_DIST="https://nodejs.org/dist"
PACKAGE="message-summarize"
DOCKER_URL="https://github.com/gmaron/message-summarize#docker"
SHIM_MARK="# message-summarize shim (managed by install.sh)"
PATH_MARK="# added by the message-summarize installer"
PREFIX_MARKER=".message-summarize-prefix"

VERSION="latest"
TARBALL=""
PREFIX=""
NO_SERVICE=0
NO_OPEN=0
MODIFY_PATH=0
UNINSTALL=0
DRY_RUN=0
ASSUME_YES=0

TMP=""
EXIT_CODE=0
PREFIX_GIVEN=0
MODULES_ASIDE=0

cleanup() {
  # An install that stopped half way (error or Ctrl-C) puts the previous working copy back.
  if [ "$MODULES_ASIDE" -eq 1 ] && [ -d "$PREFIX/node_modules.old" ]; then
    rm -rf "$PREFIX/node_modules"
    mv "$PREFIX/node_modules.old" "$PREFIX/node_modules"
  fi
  if [ -n "$TMP" ]; then
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# ---- messages (English, and Spanish when the language of the session is Spanish) -----------------------------------

messages_en() {
  M_START="Installing message-summarize into %s"
  M_NODE_FOUND="Using Node.js %s (%s)"
  M_NODE_PRIVATE="Using the private Node.js %s"
  M_STEP_NODE="download Node.js %s from nodejs.org, verify its SHA-256 and unpack it into %s"
  M_NODE_DOWNLOAD="Node.js 22.16 or later was not found. Downloading a private copy (Node.js %s, about 40 MB). Your system is not touched."
  M_VERIFY="Verifying the download (SHA-256)"
  M_BAD_SUM="The download does not match the official checksum. Nothing was installed. Try again later."
  M_NO_SUM="Could not read the official checksum for %s. Nothing was installed."
  M_MUSL="This Linux uses musl (Alpine). The official Node.js builds need glibc, so the installer stops here. Use the Docker image instead: %s"
  M_UNSUPPORTED="Unsupported system: %s %s. Use the Docker image instead: %s"
  M_NO_TOOL="A required tool is missing: %s. Install it with your system's package manager and run the installer again."
  M_NO_FETCH="Neither curl nor wget was found. Install one of them and run the installer again."
  M_NO_HASH="Neither sha256sum nor shasum was found, so the download cannot be verified. Install one of them and run the installer again."
  M_STEP_INSTALL="install %s with npm into %s (without running install scripts)"
  M_INSTALLING="Installing %s (this can take a minute)"
  M_INSTALL_FAIL="npm could not install the package. The messages above say why (network, registry or version)."
  M_NO_CLI="The package was installed but %s is missing. The package looks broken."
  M_STEP_SHIMS="create the commands %s and %s"
  M_SHIMS="Commands created: %s and %s"
  M_SHIM_FOREIGN="%s exists and was not created by this installer. Move it away and run the installer again."
  M_PATH_HINT="%s is not on your PATH. To use msum from any terminal, add this line to your shell profile:"
  M_STEP_MODIFY_PATH="add %s to the PATH in %s"
  M_PATH_ADDED="Added %s to %s. Open a new terminal for it to take effect."
  M_PATH_PRESENT="%s already has the PATH line."
  M_STEP_INIT="run msum init (creates the data folder and the configuration; an existing one is kept)"
  M_STEP_SERVICE="run msum service install (the daemon starts with your session; no administrator rights)"
  M_STEP_OPEN="open the web with msum open"
  M_SERVICE_FAIL="The service could not be registered. You can run the daemon by hand with: msum daemon"
  M_SERVICE_SKIP="Skipped the service (--no-service). To start the daemon by hand: msum daemon"
  M_WAITING="Waiting for the web to start"
  M_WEB_NOT_UP="The web is not up yet. When it is, run: msum open"
  M_OPEN_FAIL="Could not open a browser. Open the address above by hand."
  M_DONE="Done. Next: link your WhatsApp from the web, or run: msum link"
  M_DRY_HEADER="Dry run: nothing is changed. The installer would:"
  M_DRY_ITEM="  - %s"
  M_UN_START="Uninstalling message-summarize from %s"
  M_UN_SERVICE="Removing the service"
  M_UN_NOTHING="Nothing to remove at %s"
  M_UN_STEP="remove %s, %s and %s (your data is kept)"
  M_UN_DONE="Removed the program. Your data was NOT deleted: it is in %s. Delete that folder yourself if you want to erase it."
  M_UN_PATH="If you added a PATH line to your shell profile, remove the line marked \"%s\"."
  M_UN_CANCEL="Cancelled."
  M_UN_KEEP="Your data was not touched: %s"
  M_CONFIRM="Continue? [Y/n] "
  M_BAD_ARG="Unknown or incomplete option: %s (see --help)"
  M_BAD_VERSION="Invalid --version: %s"
  M_BAD_TARBALL="Cannot use --tarball %s: it must be an existing file or an https:// URL."
  M_BAD_PREFIX="Refusing to use %s as the install folder: %s"
  M_PREFIX_NOT_OURS="it is not empty and was not created by this installer"
  M_PREFIX_DATA="it contains your data folder (%s)"
  M_PREFIX_UNSAFE="it is too broad"
  M_NO_HOME="HOME is not set to an existing folder."
  M_PREFIX_IN_DATA="it is inside your data folder (%s)"
  M_PATH_MANUAL="Could not tell which startup file your shell (%s) reads, so nothing was edited. To use msum from any terminal, add this line to it yourself:"
  M_INIT_FAIL="msum init failed (see above). The program is installed; run msum init again once the problem is fixed."
  M_DOWNLOAD_FAIL="Could not download %s from nodejs.org. Nothing was installed. Check your connection and try again."
  M_UN_SVC_FAIL="The service could not be removed (see above). Nothing was deleted. Fix that and run the uninstaller again."
  M_UN_MANUAL="The program files are gone, but the background service may still be registered and its program is no longer there. Remove it by hand:"
  M_ABORT="Interrupted."
}

messages_es() {
  M_START="Instalando message-summarize en %s"
  M_NODE_FOUND="Usando Node.js %s (%s)"
  M_NODE_PRIVATE="Usando el Node.js privado %s"
  M_STEP_NODE="descargar Node.js %s de nodejs.org, verificar su SHA-256 y descomprimirlo en %s"
  M_NODE_DOWNLOAD="No se encontró Node.js 22.16 o posterior. Descargando una copia privada (Node.js %s, unos 40 MB). No se toca tu sistema."
  M_VERIFY="Verificando la descarga (SHA-256)"
  M_BAD_SUM="La descarga no coincide con el checksum oficial. No se instaló nada. Probá de nuevo más tarde."
  M_NO_SUM="No se pudo leer el checksum oficial de %s. No se instaló nada."
  M_MUSL="Este Linux usa musl (Alpine). Las versiones oficiales de Node.js necesitan glibc, así que el instalador se detiene acá. Usá la imagen de Docker: %s"
  M_UNSUPPORTED="Sistema no soportado: %s %s. Usá la imagen de Docker: %s"
  M_NO_TOOL="Falta una herramienta necesaria: %s. Instalala con el gestor de paquetes de tu sistema y volvé a correr el instalador."
  M_NO_FETCH="No se encontró curl ni wget. Instalá uno de los dos y volvé a correr el instalador."
  M_NO_HASH="No se encontró sha256sum ni shasum, así que no se puede verificar la descarga. Instalá uno de los dos y volvé a correr el instalador."
  M_STEP_INSTALL="instalar %s con npm en %s (sin ejecutar scripts de instalación)"
  M_INSTALLING="Instalando %s (puede tardar un minuto)"
  M_INSTALL_FAIL="npm no pudo instalar el paquete. Los mensajes de arriba dicen por qué (red, registro o versión)."
  M_NO_CLI="El paquete se instaló pero falta %s. El paquete parece roto."
  M_STEP_SHIMS="crear los comandos %s y %s"
  M_SHIMS="Comandos creados: %s y %s"
  M_SHIM_FOREIGN="%s existe y no lo creó este instalador. Movelo y volvé a correr el instalador."
  M_PATH_HINT="%s no está en tu PATH. Para usar msum desde cualquier terminal, agregá esta línea al perfil de tu shell:"
  M_STEP_MODIFY_PATH="agregar %s al PATH en %s"
  M_PATH_ADDED="Se agregó %s a %s. Abrí una terminal nueva para que tenga efecto."
  M_PATH_PRESENT="%s ya tiene la línea del PATH."
  M_STEP_INIT="ejecutar msum init (crea la carpeta de datos y la configuración; una existente se conserva)"
  M_STEP_SERVICE="ejecutar msum service install (el daemon arranca con tu sesión; sin permisos de administrador)"
  M_STEP_OPEN="abrir la web con msum open"
  M_SERVICE_FAIL="No se pudo registrar el servicio. Podés correr el daemon a mano con: msum daemon"
  M_SERVICE_SKIP="Se omitió el servicio (--no-service). Para arrancar el daemon a mano: msum daemon"
  M_WAITING="Esperando que arranque la web"
  M_WEB_NOT_UP="La web todavía no arrancó. Cuando lo haga, ejecutá: msum open"
  M_OPEN_FAIL="No se pudo abrir un navegador. Abrí la dirección de arriba a mano."
  M_DONE="Listo. Siguiente paso: vinculá tu WhatsApp desde la web, o ejecutá: msum link"
  M_DRY_HEADER="Simulacro: no se cambia nada. El instalador haría:"
  M_DRY_ITEM="  - %s"
  M_UN_START="Desinstalando message-summarize de %s"
  M_UN_SERVICE="Quitando el servicio"
  M_UN_NOTHING="No hay nada para quitar en %s"
  M_UN_STEP="quitar %s, %s y %s (tus datos se conservan)"
  M_UN_DONE="Se quitó el programa. Tus datos NO se borraron: están en %s. Borrá esa carpeta vos si querés eliminarlos."
  M_UN_PATH="Si agregaste una línea de PATH al perfil de tu shell, quitá la línea marcada \"%s\"."
  M_UN_CANCEL="Cancelado."
  M_UN_KEEP="Tus datos no se tocaron: %s"
  M_CONFIRM="¿Continuar? [S/n] "
  M_BAD_ARG="Opción desconocida o incompleta: %s (mirá --help)"
  M_BAD_VERSION="--version inválida: %s"
  M_BAD_TARBALL="No se puede usar --tarball %s: tiene que ser un archivo existente o una URL https://."
  M_BAD_PREFIX="Me niego a usar %s como carpeta de instalación: %s"
  M_PREFIX_NOT_OURS="no está vacía y no la creó este instalador"
  M_PREFIX_DATA="contiene tu carpeta de datos (%s)"
  M_PREFIX_UNSAFE="es demasiado amplia"
  M_NO_HOME="HOME no apunta a una carpeta existente."
  M_PREFIX_IN_DATA="está dentro de tu carpeta de datos (%s)"
  M_PATH_MANUAL="No se pudo saber qué archivo de inicio lee tu shell (%s), así que no se editó nada. Para usar msum desde cualquier terminal, agregá esta línea vos mismo:"
  M_INIT_FAIL="msum init falló (mirá arriba). El programa quedó instalado; volvé a ejecutar msum init cuando se arregle el problema."
  M_DOWNLOAD_FAIL="No se pudo descargar %s de nodejs.org. No se instaló nada. Revisá tu conexión y probá de nuevo."
  M_UN_SVC_FAIL="No se pudo quitar el servicio (mirá arriba). No se borró nada. Arreglá eso y volvé a correr el desinstalador."
  M_UN_MANUAL="Se quitaron los archivos del programa, pero el servicio en segundo plano puede seguir registrado y su programa ya no está. Quitalo a mano:"
  M_ABORT="Interrumpido."
}

case "${LC_ALL:-${LANG:-}}" in
  es*) messages_es ;;
  *) messages_en ;;
esac

# shellcheck disable=SC2059 # the formats are the constants above
say() {
  fmt=$1
  shift
  printf "$fmt\n" "$@"
}

# shellcheck disable=SC2059
warn() {
  fmt=$1
  shift
  printf "$fmt\n" "$@" >&2
}

# die <exit code> <format> [args]
die() {
  code=$1
  shift
  warn "$@"
  exit "$code"
}

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --version <v>     npm version or dist-tag to install (default: latest)
  --tarball <p|url> install from a release tarball (a file or an https:// URL)
  --prefix <dir>    where the program goes (default: ~/.local/share/message-summarize-app)
                    the commands go in ~/.local/bin
  --no-service      do not register the daemon as a user service
  --no-open         do not open the web at the end
  --modify-path     add ~/.local/bin to the PATH in your shell profile (otherwise the line is only printed)
  --uninstall       remove the program and the commands (your data is never deleted)
  --dry-run         print what would be done and change nothing
  --yes             do not ask for confirmation
  -h, --help        this help
EOF
}

# ---- arguments -----------------------------------------------------------------------------------------------------

need_value() {
  # need_value <option> <number of remaining arguments>
  if [ "$2" -lt 2 ]; then
    die 2 "$M_BAD_ARG" "$1"
  fi
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        need_value "$1" "$#"
        VERSION=$2
        shift 2
        ;;
      --version=*)
        VERSION=${1#--version=}
        shift
        ;;
      --tarball)
        need_value "$1" "$#"
        TARBALL=$2
        shift 2
        ;;
      --tarball=*)
        TARBALL=${1#--tarball=}
        shift
        ;;
      --prefix)
        need_value "$1" "$#"
        PREFIX=$2
        shift 2
        ;;
      --prefix=*)
        PREFIX=${1#--prefix=}
        shift
        ;;
      --no-service)
        NO_SERVICE=1
        shift
        ;;
      --no-open)
        NO_OPEN=1
        shift
        ;;
      --modify-path)
        MODIFY_PATH=1
        shift
        ;;
      --uninstall)
        UNINSTALL=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --yes | -y)
        ASSUME_YES=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die 2 "$M_BAD_ARG" "$1"
        ;;
    esac
  done

  case "$VERSION" in
    '' | -* | *[!A-Za-z0-9._~^+-]*) die 2 "$M_BAD_VERSION" "$VERSION" ;;
  esac

  if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
    die 1 "$M_NO_HOME"
  fi

  if [ -n "$PREFIX" ]; then
    PREFIX_GIVEN=1
  else
    PREFIX="$HOME/.local/share/message-summarize-app"
  fi
  PREFIX=$(absolute "$PREFIX")

  BIN_DIR="$HOME/.local/bin"
  SHIM_MSUM="$BIN_DIR/msum"
  SHIM_LONG="$BIN_DIR/message-summarize"
}

# ---- helpers -------------------------------------------------------------------------------------------------------

# absolute <path>: made absolute against the current folder, without a trailing slash (like path.resolve).
absolute() {
  case "$1" in
    /*) abs=$1 ;;
    *) abs="$PWD/$1" ;;
  esac
  while :; do
    case "$abs" in
      ?*/) abs=${abs%/} ;;
      *) break ;;
    esac
  done
  printf '%s\n' "$abs"
}

# physical <absolute path>: symbolic links resolved for the part that exists, the rest kept as written.
physical() {
  p=$1
  rest=""
  while [ -n "$p" ] && [ "$p" != "/" ] && [ ! -d "$p" ]; do
    rest="/${p##*/}$rest"
    p=${p%/*}
  done
  [ -n "$p" ] || p=/
  base=$(cd -P "$p" 2>/dev/null && pwd -P) || base=$p
  [ "$base" != "/" ] || base=""
  printf '%s%s\n' "$base" "$rest"
}

# The data folder, as the program itself resolves it (src/main/paths.ts): MSUM_DATA_DIR unless it is blank (relative
# paths are resolved), else the default of the system. The installer never touches it.
data_dir() {
  case "${MSUM_DATA_DIR:-}" in
    *[![:space:]]*)
      absolute "$MSUM_DATA_DIR"
      return
      ;;
  esac
  case "$(uname -s 2>/dev/null || true)" in
    Darwin) printf '%s\n' "$HOME/Library/Application Support/message-summarize" ;;
    *)
      case "${XDG_DATA_HOME:-}" in
        *[![:space:]]*) printf '%s/message-summarize\n' "$(absolute "$XDG_DATA_HOME")" ;;
        *) printf '%s/.local/share/message-summarize\n' "$HOME" ;;
      esac
      ;;
  esac
}

# Refuses a prefix that could destroy something that is not ours: a broad folder, the data folder, a folder that
# contains it or is inside it (compared by physical path, so links and relative paths do not hide it), or a folder
# with other things in it.
check_prefix() {
  pp=$(physical "$PREFIX")
  home_p=$(physical "$HOME")
  for candidate in "$PREFIX" "$pp"; do
    case "$candidate" in
      / | "$HOME" | "$home_p" | "$home_p/.local" | "$home_p/.local/share" | "$home_p/.local/bin" | "$HOME/.local" | "$HOME/.local/share" | "$HOME/.local/bin" | /usr | /usr/local | /opt | /tmp | /var)
        die 1 "$M_BAD_PREFIX" "$PREFIX" "$M_PREFIX_UNSAFE"
        ;;
    esac
  done
  data=$(data_dir)
  dp=$(physical "$data")
  for pair in "$PREFIX|$data" "$pp|$dp"; do
    pfx=${pair%%|*}
    dat=${pair#*|}
    case "$dat/" in
      "$pfx"/*) die 1 "$M_BAD_PREFIX" "$PREFIX" "$(say "$M_PREFIX_DATA" "$data")" ;;
    esac
    case "$pfx/" in
      "$dat"/*) die 1 "$M_BAD_PREFIX" "$PREFIX" "$(say "$M_PREFIX_IN_DATA" "$data")" ;;
    esac
  done
  if [ -e "$PREFIX" ] && [ ! -f "$PREFIX/$PREFIX_MARKER" ]; then
    if [ ! -d "$PREFIX" ] || [ -n "$(ls -A "$PREFIX" 2>/dev/null)" ]; then
      die 1 "$M_BAD_PREFIX" "$PREFIX" "$M_PREFIX_NOT_OURS"
    fi
  fi
}

confirm() {
  if [ "$ASSUME_YES" -eq 1 ] || [ "$DRY_RUN" -eq 1 ] || [ ! -t 0 ]; then
    return 0
  fi
  printf '%s' "$M_CONFIRM"
  answer=""
  read -r answer || answer=""
  case "$answer" in
    '' | y | Y | yes | YES | s | S | si | SI | sí) return 0 ;;
  esac
  say "$M_UN_CANCEL"
  exit 1
}

# sq <text>: the text as one single-quoted word, for the generated shims.
sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# version_ok <vX.Y.Z>: true when it is at least NODE_MIN_MAJOR.NODE_MIN_MINOR.
version_ok() {
  v=${1#v}
  case "$v" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) return 1 ;;
  esac
  major=${v%%.*}
  rest=${v#*.}
  minor=${rest%%.*}
  case "$major$minor" in
    *[!0-9]*) return 1 ;;
  esac
  if [ "$major" -gt "$NODE_MIN_MAJOR" ]; then
    return 0
  fi
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]
}

# node_report <path>: prints the version when that node is recent enough.
node_report() {
  [ -x "$1" ] || return 1
  nv=$("$1" -v 2>/dev/null) || return 1
  version_ok "$nv" || return 1
  printf '%s\n' "$nv"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

pick_fetcher() {
  if have curl; then
    FETCHER=curl
  elif have wget; then
    FETCHER=wget
  else
    die 4 "$M_NO_FETCH"
  fi
}

# fetch <https url> <destination>
fetch() {
  case "$1" in
    https://*) ;;
    *) die 1 "$M_BAD_TARBALL" "$1" ;;
  esac
  if [ "$FETCHER" = curl ]; then
    curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 20 --retry 2 -o "$2" "$1"
  else
    wget -q --https-only -O "$2" "$1"
  fi
}

sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif have shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die 4 "$M_NO_HASH"
  fi
}

# Sets NODE_OS and NODE_ARCH, or stops with a clear message.
detect_platform() {
  sys=$(uname -s 2>/dev/null || echo unknown)
  mach=$(uname -m 2>/dev/null || echo unknown)
  case "$sys" in
    Darwin) NODE_OS=darwin ;;
    Linux) NODE_OS=linux ;;
    *) die 3 "$M_UNSUPPORTED" "$sys" "$mach" "$DOCKER_URL" ;;
  esac
  case "$mach" in
    x86_64 | amd64) NODE_ARCH=x64 ;;
    arm64 | aarch64) NODE_ARCH=arm64 ;;
    *) die 3 "$M_UNSUPPORTED" "$sys" "$mach" "$DOCKER_URL" ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple Silicon Mac: the native build is the right one.
  if [ "$NODE_OS" = darwin ] && [ "$NODE_ARCH" = x64 ] && have sysctl; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
      NODE_ARCH=arm64
    fi
  fi
  if [ "$NODE_OS" = linux ]; then
    musl=0
    for loader in /lib/ld-musl-* /usr/lib/ld-musl-*; do
      if [ -e "$loader" ]; then
        musl=1
      fi
    done
    if [ "$musl" -eq 0 ] && have ldd; then
      case "$(ldd --version 2>&1 || true)" in
        *[Mm]usl*) musl=1 ;;
      esac
    fi
    if [ "$musl" -eq 1 ]; then
      die 3 "$M_MUSL" "$DOCKER_URL"
    fi
  fi
}

# Finds the node to use: sets NODE_BIN and NODE_NEEDS_DOWNLOAD.
choose_node() {
  NODE_BIN=""
  NODE_NEEDS_DOWNLOAD=0
  if have node; then
    candidate=$(command -v node)
    if nv=$(node_report "$candidate"); then
      NODE_BIN=$candidate
      say "$M_NODE_FOUND" "$nv" "$candidate"
      return
    fi
  fi
  if nv=$(node_report "$PREFIX/node/bin/node"); then
    NODE_BIN="$PREFIX/node/bin/node"
    say "$M_NODE_PRIVATE" "$nv"
    return
  fi
  NODE_NEEDS_DOWNLOAD=1
  NODE_BIN="$PREFIX/node/bin/node"
}

download_node() {
  detect_platform
  pick_fetcher
  have tar || die 4 "$M_NO_TOOL" tar
  say "$M_NODE_DOWNLOAD" "$NODE_VERSION"
  name="node-v$NODE_VERSION-$NODE_OS-$NODE_ARCH"
  base="$NODE_DIST/v$NODE_VERSION"
  fetch "$base/SHASUMS256.txt" "$TMP/SHASUMS256.txt" || die 1 "$M_DOWNLOAD_FAIL" "SHASUMS256.txt"
  expected=$(awk -v f="$name.tar.gz" '$2 == f { print $1; exit }' "$TMP/SHASUMS256.txt")
  case "$expected" in
    '' | *[!0-9a-f]*) die 1 "$M_NO_SUM" "$name.tar.gz" ;;
  esac
  [ "${#expected}" -eq 64 ] || die 1 "$M_NO_SUM" "$name.tar.gz"
  fetch "$base/$name.tar.gz" "$TMP/$name.tar.gz" || die 1 "$M_DOWNLOAD_FAIL" "$name.tar.gz"
  say "$M_VERIFY"
  actual=$(sha256_of "$TMP/$name.tar.gz")
  if [ "$actual" != "$expected" ]; then
    die 5 "$M_BAD_SUM"
  fi
  mkdir -p "$TMP/extract"
  tar -xzf "$TMP/$name.tar.gz" -C "$TMP/extract"
  [ -x "$TMP/extract/$name/bin/node" ] || die 1 "$M_DOWNLOAD_FAIL" "$name.tar.gz"
  rm -rf "$PREFIX/node.new"
  mv "$TMP/extract/$name" "$PREFIX/node.new"
  rm -rf "$PREFIX/node"
  mv "$PREFIX/node.new" "$PREFIX/node"
}

write_shim() {
  # write_shim <path> <node> <cli>
  if [ -e "$1" ] || [ -L "$1" ]; then
    if ! grep -qF "$SHIM_MARK" "$1" 2>/dev/null; then
      die 1 "$M_SHIM_FOREIGN" "$1"
    fi
  fi
  tmp_shim="$TMP/shim.$$"
  {
    printf '#!/bin/sh\n%s\n' "$SHIM_MARK"
    printf 'NODE=%s\nCLI=%s\n' "$(sq "$2")" "$(sq "$3")"
    printf '%s\n' '[ -x "$NODE" ] || { echo "message-summarize: Node.js not found at $NODE. Run the installer again." >&2; exit 1; }'
    printf '%s\n' 'exec "$NODE" "$CLI" "$@"'
  } >"$tmp_shim"
  chmod 755 "$tmp_shim"
  mv -f "$tmp_shim" "$1"
}

# The startup file to edit for --modify-path, or nothing when the shell is not one we know how to edit.
#  bash: the first of .bash_profile, .bash_login, .profile that exists (bash reads only the first one), else a new
#        .bash_profile.
#  zsh:  .zshenv (in ZDOTDIR when set). It is read by every zsh, login or not, interactive or not, so the PATH is
#        right in a terminal tab, an IDE terminal and a script; .zprofile would miss the terminals that do not log in
#        (most Linux ones) and .zshrc the non-interactive ones.
#  fish and the rest: nothing; the line is only printed.
profile_file() {
  case "${SHELL:-}" in
    */zsh) printf '%s/.zshenv\n' "${ZDOTDIR:-$HOME}" ;;
    */bash)
      for candidate in .bash_profile .bash_login .profile; do
        if [ -f "$HOME/$candidate" ]; then
          printf '%s/%s\n' "$HOME" "$candidate"
          return
        fi
      done
      printf '%s/.bash_profile\n' "$HOME"
      ;;
  esac
}

on_path() {
  case ":${PATH:-}:" in
    *":$BIN_DIR:"*) return 0 ;;
  esac
  return 1
}

PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

# The line to print for a shell we do not edit.
manual_path_line() {
  case "${SHELL:-}" in
    */fish) printf '%s\n' 'fish_add_path $HOME/.local/bin' ;;
    *) printf '%s\n' "$PATH_LINE" ;;
  esac
}

# ---- uninstall -----------------------------------------------------------------------------------------------------

# shim_value <NODE|CLI> <shim>: a value the installer wrote into a marked shim (nothing when it cannot be read back).
shim_value() {
  val=$(sed -n "s/^$1='\(.*\)'\$/\1/p" "$2" 2>/dev/null | head -n 1)
  case "$val" in
    *\'*) val="" ;;
  esac
  printf '%s\n' "$val"
}

# What a background service would need if its program is gone: the exact manual step, or nothing when no service is
# registered. The names are the ones of src/infrastructure/service.
service_leftover() {
  case "$(uname -s 2>/dev/null || true)" in
    Darwin)
      plist="$HOME/Library/LaunchAgents/dev.message-summarize.daemon.plist"
      if [ -e "$plist" ]; then
        printf 'launchctl bootout "gui/$(id -u)/dev.message-summarize.daemon"; rm "%s"\n' "$plist"
      fi
      ;;
    Linux)
      unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/message-summarize.service"
      if [ -e "$unit" ]; then
        printf 'systemctl --user disable --now message-summarize.service; rm "%s"; systemctl --user daemon-reload\n' "$unit"
      fi
      ;;
  esac
}

do_uninstall() {
  # The shim says which program (and prefix) it belongs to; an explicit --prefix wins.
  shim=""
  for candidate in "$SHIM_MSUM" "$SHIM_LONG"; do
    if [ -z "$shim" ] && grep -qF "$SHIM_MARK" "$candidate" 2>/dev/null; then
      shim=$candidate
    fi
  done
  shim_cli=""
  shim_node=""
  if [ -n "$shim" ]; then
    shim_cli=$(shim_value CLI "$shim")
    shim_node=$(shim_value NODE "$shim")
    if [ "$PREFIX_GIVEN" -eq 0 ] && [ -n "$shim_cli" ]; then
      shim_prefix=${shim_cli%/node_modules/$PACKAGE/dist/main/cli.js}
      if [ "$shim_prefix" != "$shim_cli" ] && [ -n "$shim_prefix" ]; then
        PREFIX=$shim_prefix
      fi
    fi
  fi
  check_prefix
  data=$(data_dir)
  say "$M_UN_START" "$PREFIX"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "$M_DRY_HEADER"
    say "$M_DRY_ITEM" "msum service uninstall"
    say "$M_DRY_ITEM" "$(say "$M_UN_STEP" "$PREFIX" "$SHIM_MSUM" "$SHIM_LONG")"
    say "$M_UN_DONE" "$data"
    return
  fi
  present=0
  if [ -e "$PREFIX" ] || [ -n "$shim" ]; then
    present=1
  fi
  if [ "$present" -eq 0 ]; then
    say "$M_UN_NOTHING" "$PREFIX"
    say "$M_UN_DONE" "$data"
    return
  fi
  confirm
  manual=""
  if [ -n "$shim_cli" ] && [ -f "$shim_cli" ] && [ -x "$shim_node" ]; then
    say "$M_UN_SERVICE"
    # Nothing is deleted when the service cannot be removed: the program that knows how is still there for a retry.
    "$shim_node" "$shim_cli" service uninstall || die 1 "$M_UN_SVC_FAIL"
  else
    manual=$(service_leftover)
  fi
  for candidate in "$SHIM_MSUM" "$SHIM_LONG"; do
    if grep -qF "$SHIM_MARK" "$candidate" 2>/dev/null; then
      rm -f "$candidate"
    fi
  done
  if [ -d "$PREFIX" ]; then
    rm -rf "$PREFIX"
  fi
  if [ -n "$manual" ]; then
    say "$M_UN_MANUAL"
    say '  %s' "$manual"
    say "$M_UN_KEEP" "$data"
    EXIT_CODE=6
  else
    say "$M_UN_DONE" "$data"
    say "$M_UN_PATH" "$PATH_MARK"
  fi
}

# ---- install -------------------------------------------------------------------------------------------------------

do_install() {
  check_prefix

  case "$TARBALL" in
    '') PACKAGE_SPEC="$PACKAGE@$VERSION" ;;
    https://*) PACKAGE_SPEC="" ;;
    http://* | *://*) die 1 "$M_BAD_TARBALL" "$TARBALL" ;;
    *)
      [ -f "$TARBALL" ] || die 1 "$M_BAD_TARBALL" "$TARBALL"
      case "$TARBALL" in
        /*) PACKAGE_SPEC=$TARBALL ;;
        *) PACKAGE_SPEC="$PWD/$TARBALL" ;;
      esac
      ;;
  esac

  say "$M_START" "$PREFIX"
  choose_node
  if [ "$NODE_NEEDS_DOWNLOAD" -eq 1 ]; then
    detect_platform # fails early, also in a dry run, on a system the download cannot serve
  fi
  if [ -n "$TARBALL" ] && [ -z "$PACKAGE_SPEC" ]; then
    pick_fetcher
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    say "$M_DRY_HEADER"
    if [ "$NODE_NEEDS_DOWNLOAD" -eq 1 ]; then
      say "$M_DRY_ITEM" "$(say "$M_STEP_NODE" "$NODE_VERSION" "$PREFIX/node")"
    fi
    if [ -n "$TARBALL" ]; then
      say "$M_DRY_ITEM" "$(say "$M_STEP_INSTALL" "$TARBALL" "$PREFIX")"
    else
      say "$M_DRY_ITEM" "$(say "$M_STEP_INSTALL" "$PACKAGE@$VERSION" "$PREFIX")"
    fi
    say "$M_DRY_ITEM" "$(say "$M_STEP_SHIMS" "$SHIM_MSUM" "$SHIM_LONG")"
    if on_path; then
      :
    elif [ "$MODIFY_PATH" -eq 1 ] && [ -n "$(profile_file)" ]; then
      say "$M_DRY_ITEM" "$(say "$M_STEP_MODIFY_PATH" "$BIN_DIR" "$(profile_file)")"
    elif [ "$MODIFY_PATH" -eq 1 ]; then
      say "$M_PATH_MANUAL" "${SHELL:-?}"
      say '  %s' "$(manual_path_line)"
    else
      say "$M_PATH_HINT" "$BIN_DIR"
      say '  %s' "$PATH_LINE"
    fi
    say "$M_DRY_ITEM" "$M_STEP_INIT"
    if [ "$NO_SERVICE" -eq 0 ]; then
      say "$M_DRY_ITEM" "$M_STEP_SERVICE"
    fi
    if [ "$NO_OPEN" -eq 0 ]; then
      say "$M_DRY_ITEM" "$M_STEP_OPEN"
    fi
    exit 0
  fi

  confirm

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/msum-install.XXXXXX")
  mkdir -p "$PREFIX" "$BIN_DIR"
  : >"$PREFIX/$PREFIX_MARKER"

  if [ "$NODE_NEEDS_DOWNLOAD" -eq 1 ]; then
    download_node
  fi

  if [ -n "$TARBALL" ] && [ -z "$PACKAGE_SPEC" ]; then
    fetch "$TARBALL" "$TMP/package.tgz" || die 1 "$M_BAD_TARBALL" "$TARBALL"
    PACKAGE_SPEC="$TMP/package.tgz"
  fi

  # npm sits next to node (the private copy, or the system one).
  NODE_DIR=$(dirname "$NODE_BIN")
  if [ -x "$NODE_DIR/npm" ]; then
    NPM_BIN="$NODE_DIR/npm"
  elif have npm; then
    NPM_BIN=$(command -v npm)
  else
    die 4 "$M_NO_TOOL" npm
  fi

  # --ignore-scripts: the package has no install scripts of its own, Baileys' preinstall is only an engine check (the
  # installer already checked the Node.js version) and protobufjs' postinstall only prints a warning. Verified by
  # installing a packed tarball and running `msum init`. Not running third-party scripts is the safer choice.
  # --no-save: a tarball in a temporary file must not stay in the manifest, and a rerun resolves the version again.
  # An upgrade is a clean install: npm fails on top of a previous --no-save tree that has links (the vendored sharp stub).
  # The previous tree is kept aside and put back if the new one cannot be installed.
  if [ -d "$PREFIX/node_modules.old" ]; then
    if [ -d "$PREFIX/node_modules" ]; then
      rm -rf "$PREFIX/node_modules.old"
    else
      mv "$PREFIX/node_modules.old" "$PREFIX/node_modules" # left by an interrupted run: the only good copy
    fi
  fi
  if [ -d "$PREFIX/node_modules" ]; then
    mv "$PREFIX/node_modules" "$PREFIX/node_modules.old"
    MODULES_ASIDE=1
  fi
  say "$M_INSTALLING" "${TARBALL:-$PACKAGE@$VERSION}"
  if ! PATH="$NODE_DIR:$PATH" npm_config_update_notifier=false "$NPM_BIN" install \
    --prefix "$PREFIX" --no-fund --no-audit --ignore-scripts --no-save --loglevel=error "$PACKAGE_SPEC"; then
    die 1 "$M_INSTALL_FAIL" # the exit trap puts the previous node_modules back
  fi
  MODULES_ASIDE=0
  rm -rf "$PREFIX/node_modules.old"

  CLI="$PREFIX/node_modules/$PACKAGE/dist/main/cli.js"
  [ -f "$CLI" ] || die 1 "$M_NO_CLI" "$CLI"

  write_shim "$SHIM_MSUM" "$NODE_BIN" "$CLI"
  write_shim "$SHIM_LONG" "$NODE_BIN" "$CLI"
  say "$M_SHIMS" "$SHIM_MSUM" "$SHIM_LONG"

  if ! on_path; then
    profile=""
    if [ "$MODIFY_PATH" -eq 1 ]; then
      profile=$(profile_file)
    fi
    if [ -n "$profile" ]; then
      if [ -f "$profile" ] && grep -qF "$PATH_LINE" "$profile"; then
        say "$M_PATH_PRESENT" "$profile"
      else
        printf '\n%s\n%s\n' "$PATH_MARK" "$PATH_LINE" >>"$profile"
        say "$M_PATH_ADDED" "$BIN_DIR" "$profile"
      fi
    elif [ "$MODIFY_PATH" -eq 1 ]; then
      say "$M_PATH_MANUAL" "${SHELL:-?}"
      say '  %s' "$(manual_path_line)"
    else
      say "$M_PATH_HINT" "$BIN_DIR"
      say '  %s' "$PATH_LINE"
    fi
  fi

  # init never asks anything and keeps an existing configuration.
  "$SHIM_MSUM" init || die 1 "$M_INIT_FAIL"

  SERVICE_UP=0
  if [ "$NO_SERVICE" -eq 1 ]; then
    say "$M_SERVICE_SKIP"
  elif "$SHIM_MSUM" service install; then
    SERVICE_UP=1
  else
    warn "$M_SERVICE_FAIL"
    EXIT_CODE=6
  fi

  if [ "$NO_OPEN" -eq 0 ]; then
    # The daemon needs a moment to open the web. `--print` output is discarded so that the token is shown only once,
    # by the real `msum open`.
    if [ "$SERVICE_UP" -eq 1 ]; then
      max_tries=30
      say "$M_WAITING"
    else
      max_tries=1
    fi
    tries=0
    web_up=0
    while [ "$tries" -lt "$max_tries" ]; do
      if "$SHIM_MSUM" open --print >/dev/null 2>&1; then
        web_up=1
        break
      fi
      tries=$((tries + 1))
      if [ "$tries" -lt "$max_tries" ]; then
        sleep 1
      fi
    done
    if [ "$web_up" -eq 1 ]; then
      "$SHIM_MSUM" open || warn "$M_OPEN_FAIL"
    elif [ "$SERVICE_UP" -eq 1 ]; then
      say "$M_WEB_NOT_UP"
    fi
  fi

  say "$M_DONE"
  exit "$EXIT_CODE"
}

main() {
  parse_args "$@"
  if [ "$UNINSTALL" -eq 1 ]; then
    do_uninstall
    exit "$EXIT_CODE"
  fi
  do_install
}

# Everything above only defines functions: a script cut short by a dropped connection (curl | sh) runs nothing.
main "$@"
