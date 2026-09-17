#!/usr/bin/env bash
# The add-on's shell scripts in the add-on base image, with its real bashio:
# every image/*.sh runs in a fresh container (image/addon-run.sh: the start
# script; image/notify.sh: the notification titles).
#
# Requires Docker. The image is image/Dockerfile.
#
# Run, from app/:  npm run test:image
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"

command -v docker >/dev/null 2>&1 || { echo "FAIL: docker is required"; exit 1; }
image="$(docker build -q "${here}/image")"
status=0
for script in "${here}"/image/*.sh; do
    echo "== ${script##*/}"
    docker run --rm --entrypoint bash -v "${repo}:/src:ro" "${image}" "/src/app/test/image/${script##*/}" || status=1
done
exit "${status}"
