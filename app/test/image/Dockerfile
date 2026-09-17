# The add-on base image the start script runs in (see addon-run.sh), with git,
# which every add-on image installs (provision-extras.sh). Kept here so its
# version is updated like every other dependency.
FROM ghcr.io/hassio-addons/debian-base:9.4.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
