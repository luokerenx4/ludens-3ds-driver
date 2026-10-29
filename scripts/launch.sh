#!/bin/bash
set -euo pipefail
azahar_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source "$azahar_script_dir/paths.sh"
azahar_executable="$azahar_app/Contents/MacOS/azahar"
if [ ! -x "$azahar_executable" ]; then
  echo "Patched Azahar not found at $azahar_executable. Run emulator:build or set RSA_AZAHAR_APP to a patched .app." >&2
  exit 1
fi
export RSA_BRIDGE_PORT="${RSA_BRIDGE_PORT:-47673}"
exec "$azahar_executable" "$@"
