#!/usr/bin/env bash
# The add-on start script (rootfs/usr/local/bin/addon-run) in the add-on base
# image, with its real bashio and a neutral engine: see image/addon-run.sh.
#
# Requires Docker. The image is image/Dockerfile.
#
# Run, from app/:  npm run test:addon-run
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"

command -v docker >/dev/null 2>&1 || { echo "FAIL: docker is required"; exit 1; }
image="$(docker build -q "${here}/image")"
docker run --rm --entrypoint bash -v "${repo}:/src:ro" "${image}" /src/app/test/image/addon-run.sh
