# UBI 9 minimal build image — node/npm plus awk/bash/tar is all the yarn build needs.
FROM registry.access.redhat.com/ubi9/nodejs-22-minimal:9.9-1794500978 AS build-main
USER root
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /usr/src/app
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn
RUN LOCAL_YARN="node $(awk '/yarnPath:/{print $2}' .yarnrc.yml)" && \
    $LOCAL_YARN install --immutable
COPY .swcrc console-extensions.json LICENSE tsconfig.json webpack.config.ts ./
COPY locales ./locales
COPY src ./src
RUN LOCAL_YARN="node $(awk '/yarnPath:/{print $2}' .yarnrc.yml)" && \
    $LOCAL_YARN build

# RHEL 9 nginx with OpenSSL 3.5 (ML-KEM), so the chart's PQC ssl_ecdh_curve defaults work.
FROM registry.access.redhat.com/ubi9/nginx-126:9.9-1794514156
# The operator (and this repo's Helm chart) render nginx.conf with
# `root /usr/share/nginx/html`, a directory owned by the nginx RPM. Serve the
# build from there by adding files only: deleting or replacing RPM-installed
# files (e.g. turning the directory into a symlink) fails the Konflux
# ecosystem-cert-preflight-checks HasModifiedFiles check, which EC enforces.
COPY --from=build-main /usr/src/app/dist /usr/share/nginx/html/
# /builds keeps the per-release layout the entrypoint selects via OCP_VERSION.
COPY --from=build-main /usr/src/app/dist /builds/main
COPY entrypoint.sh /entrypoint.sh
# EC certification requires licensing information in /licenses.
COPY LICENSE /licenses/LICENSE

USER root
RUN chmod +x /entrypoint.sh && \
    mkdir -p /tmp/nginx && \
    chgrp -R 0 /tmp/nginx /builds && \
    chmod -R g=u /tmp/nginx /builds
USER 1001

# Red Hat labels
LABEL name="openshift-sandboxed-containers/coco-console-plugin-rhel9" \
cpe="cpe:/a:redhat:confidential_compute_attestation:1.130::el9" \
version="$VERSION" \
com.redhat.component="coco-console-plugin" \
summary="Console plugin for Confidential Containers" \
maintainer="support@redhat.com" \
description="Console plugin for Confidential Containers" \
io.k8s.display-name="openshift-sandboxed-containers-coco-console-plugin" \
io.k8s.description="Console plugin for Confidential Containers" \
io.openshift.tags=""

ENTRYPOINT ["/entrypoint.sh"]
