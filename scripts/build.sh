#!/bin/bash
set -euo pipefail
azahar_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
azahar_package_dir=$(CDPATH= cd -- "$azahar_script_dir/.." && pwd)
source "$azahar_script_dir/paths.sh"
azahar_revision=219d743a1e698101fe1ab8bef43e6563126c3c27

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "This build recipe targets Apple Silicon macOS." >&2
  exit 1
fi
mkdir -p "$(dirname -- "$azahar_source_dir")" "$(dirname -- "$azahar_build_dir")"
if [ ! -d "$azahar_source_dir/.git" ]; then
  git clone --depth 1 --branch 2126.2 https://github.com/azahar-emu/azahar.git "$azahar_source_dir"
fi
if [ "$(git -C "$azahar_source_dir" rev-parse HEAD)" != "$azahar_revision" ]; then
  echo "Azahar source must be at $azahar_revision; use a fresh RSA_AZAHAR_SOURCE directory." >&2
  exit 1
fi
git -C "$azahar_source_dir" submodule update --init --recursive --jobs 4
if git -C "$azahar_source_dir" apply --check "$azahar_package_dir/native/azahar.patch" 2>/dev/null; then
  git -C "$azahar_source_dir" apply "$azahar_package_dir/native/azahar.patch"
else
  # Accept an already applied patch; do not reset or discard source edits.
  git -C "$azahar_source_dir" apply --reverse --check "$azahar_package_dir/native/azahar.patch"
fi
cp "$azahar_package_dir/native/rsa_bridge.cpp" "$azahar_package_dir/native/rsa_bridge.h" "$azahar_source_dir/src/core/frontend/"
cmake -S "$azahar_source_dir" -B "$azahar_build_dir" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 -DENABLE_LTO=OFF -DENABLE_TESTS=OFF \
  -DENABLE_ROOM_STANDALONE=OFF -DENABLE_DISCORD_RPC=OFF -DENABLE_QT_UPDATE_CHECKER=OFF
cmake --build "$azahar_build_dir" --target bundle --parallel "${RSA_BUILD_JOBS:-4}"
echo "Built $azahar_build_dir/bundle/azahar.app"
