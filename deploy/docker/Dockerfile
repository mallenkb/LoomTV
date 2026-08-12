# syntax=docker/dockerfile:1.7

# The headless runtime is deliberately kept independent from Electron.  The
# server package currently ships JavaScript directly, so this image does not
# need a desktop build or a display server.
# Docker Hub multi-platform OCI index for node:22-bookworm-slim, resolved
# 2026-08-08. Refresh both FROM lines and the 20260806T000000Z Debian snapshot
# together so amd64 and arm64 select platform manifests from the same index.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS dependencies

WORKDIR /workspace
ENV COREPACK_HOME=/tmp/corepack

RUN corepack enable

# Copy manifests before source so dependency installation remains cacheable.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches patches
COPY apps/server/package.json apps/server/package.json

# Keep workspace package resolution available when the server imports a local
# protocol/package.  Additional workspace package manifests can be added here
# without changing the runtime image.
COPY packages/lan-protocol/package.json packages/lan-protocol/package.json
COPY packages/media-core/package.json packages/media-core/package.json
COPY packages/runtime-paths/package.json packages/runtime-paths/package.json
COPY packages/transcode-capabilities/package.json packages/transcode-capabilities/package.json
COPY packages/media-core/src packages/media-core/src
COPY packages/runtime-paths/src packages/runtime-paths/src
COPY packages/transcode-capabilities/src packages/transcode-capabilities/src

RUN pnpm install --filter ./apps/server... --prod --frozen-lockfile
RUN pnpm --config.inject-workspace-packages=true --filter ./apps/server deploy --prod /opt/loomtv

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runtime

ARG LOOMTV_UID=1000
ARG LOOMTV_GID=1000

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3847 \
    DATA_DIR=/config \
    CACHE_DIR=/cache \
    MEDIA_DIR=/media

# ffmpeg is installed from one immutable Debian snapshot for both supported
# architectures. The snapshot is updated only alongside the base digest in a
# reviewed image rebuild; unattended rebuilds must not pick up new apt inputs.
# Hardware acceleration remains opt-in (see docs/nas-deployment.md).
RUN if [ "${LOOMTV_UID}" = '0' ] || [ "${LOOMTV_GID}" = '0' ]; then echo 'LOOMTV_UID and LOOMTV_GID must be non-zero.' >&2; exit 64; fi \
  && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
  && printf '%s\n' \
    'Types: deb' \
    'URIs: http://snapshot.debian.org/archive/debian/20260806T000000Z/' \
    'Suites: bookworm bookworm-updates' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    '' \
    'Types: deb' \
    'URIs: http://snapshot.debian.org/archive/debian-security/20260806T000000Z/' \
    'Suites: bookworm-security' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    > /etc/apt/sources.list.d/debian.sources \
  && printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && apt-get install --no-install-recommends --yes ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/* \
  && (getent group "${LOOMTV_GID}" >/dev/null || groupadd --gid "${LOOMTV_GID}" loomtv) \
  && (getent passwd "${LOOMTV_UID}" >/dev/null || useradd --uid "${LOOMTV_UID}" --gid "${LOOMTV_GID}" --create-home --home-dir /home/loomtv --shell /usr/sbin/nologin loomtv) \
  && install --directory --owner="${LOOMTV_UID}" --group="${LOOMTV_GID}" /config /cache /media /opt/loomtv

WORKDIR /opt/loomtv

COPY --from=dependencies --chown=${LOOMTV_UID}:${LOOMTV_GID} /opt/loomtv ./
COPY --chown=${LOOMTV_UID}:${LOOMTV_GID} apps/server/src ./apps/server/src
COPY --chown=${LOOMTV_UID}:${LOOMTV_GID} apps/server/package.json ./apps/server/package.json
COPY --chown=${LOOMTV_UID}:${LOOMTV_GID} apps/desktop/src/headless/admin.html ./apps/desktop/src/headless/admin.html
COPY --chown=${LOOMTV_UID}:${LOOMTV_GID} apps/desktop/src/headless/lucide-icons.svg ./apps/desktop/src/headless/lucide-icons.svg
COPY --chown=${LOOMTV_UID}:${LOOMTV_GID} deploy/docker/entrypoint.sh /usr/local/bin/loomtv-entrypoint

RUN chmod 0755 /usr/local/bin/loomtv-entrypoint

# Tini forwards SIGTERM and reaps ffmpeg children.  The entrypoint validates
# mounted paths and then execs Node so systemd/Docker stop semantics are clean.
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/loomtv-entrypoint"]
CMD ["node", "apps/server/src/cli.js"]

EXPOSE 3847

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3847)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

USER ${LOOMTV_UID}:${LOOMTV_GID}
