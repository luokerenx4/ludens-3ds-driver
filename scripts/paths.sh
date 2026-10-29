# Sourced by build.sh and launch.sh. All defaults live outside the driver checkout.
azahar_cache_dir="${RSA_AZAHAR_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/ludens/azahar/2126.2-rsa.3}"
azahar_source_dir="${RSA_AZAHAR_SOURCE:-$azahar_cache_dir/source}"
azahar_build_dir="${RSA_AZAHAR_BUILD:-$azahar_cache_dir/build}"
azahar_app="${RSA_AZAHAR_APP:-$azahar_build_dir/bundle/azahar.app}"
