#!/bin/sh
set -eu

# A bind mount created by Docker may be owned by root.  Do not try to chown it
# from a non-root container; fail with a useful message instead of silently
# losing library state or cache writes.
for path in "${DATA_DIR:-/config}" "${CACHE_DIR:-/cache}" "${MEDIA_DIR:-/media}"; do
  if [ ! -d "$path" ]; then
    printf '%s\n' "LoomTV requires directory $path. Create it and grant the container UID/GID access." >&2
    exit 78
  fi
done

if [ ! -w "${DATA_DIR:-/config}" ]; then
  printf '%s\n' "LoomTV cannot write ${DATA_DIR:-/config}; check PUID/PGID ownership." >&2
  exit 77
fi

# Config and cache contain private metadata and should not become group/world
# writable when the host creates new files.
umask 027
exec "$@"
