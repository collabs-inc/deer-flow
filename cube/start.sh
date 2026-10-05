#!/bin/sh
set -eu
umask 077
CUBE_DEERFLOW_DATA_DIR="${CUBE_DEERFLOW_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/cube-deerflow}"
export CUBE_DEERFLOW_DATA_DIR
mkdir -p "$CUBE_DEERFLOW_DATA_DIR"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$script_dir/ensure-docker.mjs"
exec flock --no-fork --nonblock "$CUBE_DEERFLOW_DATA_DIR/.app.lock" node "$script_dir/start.mjs"
