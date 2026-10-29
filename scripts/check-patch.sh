#!/bin/bash
# Read-only check against the fixed upstream tree, including already-patched sources.
set -euo pipefail
azahar_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
azahar_package_dir=$(CDPATH= cd -- "$azahar_script_dir/.." && pwd)
source "$azahar_script_dir/paths.sh"
azahar_revision=219d743a1e698101fe1ab8bef43e6563126c3c27
if [ "$(git -C "$azahar_source_dir" rev-parse HEAD)" != "$azahar_revision" ]; then
  echo "Azahar source must be at $azahar_revision; set RSA_AZAHAR_SOURCE to that checkout." >&2
  exit 1
fi
azahar_check_dir=$(mktemp -d "${TMPDIR:-/tmp}/azahar-patch-check.XXXXXX")
trap 'rm -rf "$azahar_check_dir"' EXIT
# The patch names only repository-relative paths without spaces. Read pristine
# blobs so source edits or an already-applied bridge do not affect the check.
while IFS= read -r azahar_file; do
  mkdir -p "$azahar_check_dir/$(dirname -- "$azahar_file")"
  git -C "$azahar_source_dir" show "$azahar_revision:$azahar_file" > "$azahar_check_dir/$azahar_file"
done < <(sed -n 's|^+++ b/||p' "$azahar_package_dir/native/azahar.patch")
git -C "$azahar_check_dir" apply --check "$azahar_package_dir/native/azahar.patch"
echo "Azahar patch applies to pristine upstream $azahar_revision"
