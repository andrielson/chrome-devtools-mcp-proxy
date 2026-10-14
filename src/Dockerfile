# syntax=docker/dockerfile:1
# Every upstream artifact is pinned to an exact version — no floating tags,
# no digests. Naming convention: *_IMAGE_TAG pins a base image, *_VERSION
# pins a package. The pins surface as io.github.andrielson.* OCI labels
# below; org.opencontainers.image.version stays reserved for the release
# pipeline to fill with the image's own version.
ARG NODE_IMAGE_TAG=24.21.0-alpine3.24
ARG UV_IMAGE_TAG=0.13.0
ARG CHROME_DEVTOOLS_MCP_VERSION=1.10.1
ARG MCP_PROXY_VERSION=0.13.0
ARG PYTHON_VERSION=3.15

# COPY --from does not expand variables in an image reference, so the uv
# image is pinned through its own stage (never executed, only copied from).
FROM ghcr.io/astral-sh/uv:${UV_IMAGE_TAG} AS uv

FROM node:${NODE_IMAGE_TAG}

# ARGs declared before FROM are out of scope inside a stage; redeclare the
# ones used below (each inherits the global declaration's default).
ARG NODE_IMAGE_TAG
ARG UV_IMAGE_TAG
ARG CHROME_DEVTOOLS_MCP_VERSION
ARG MCP_PROXY_VERSION
ARG PYTHON_VERSION

LABEL io.github.andrielson.chrome-devtools-mcp-proxy.node-image-tag="${NODE_IMAGE_TAG}" \
  io.github.andrielson.chrome-devtools-mcp-proxy.uv-image-tag="${UV_IMAGE_TAG}" \
  io.github.andrielson.chrome-devtools-mcp-proxy.chrome-devtools-mcp-version="${CHROME_DEVTOOLS_MCP_VERSION}" \
  io.github.andrielson.chrome-devtools-mcp-proxy.mcp-proxy-version="${MCP_PROXY_VERSION}" \
  io.github.andrielson.chrome-devtools-mcp-proxy.python-version="${PYTHON_VERSION}"

COPY --from=uv /uv /uvx /bin/

# MCP_PROXY_ARGS and CHROME_DEVTOOLS_MCP_ARGS are ENV defaults, overridable
# at run time (`docker run --env` / Compose `environment:`); the entrypoint
# parses them with shell-like quoting into the final
# `mcp-proxy ${MCP_PROXY_ARGS} -- chrome-devtools-mcp ${CHROME_DEVTOOLS_MCP_ARGS}`
# command line.
ENV PATH="/root/.local/bin/:$PATH" \
  UV_COMPILE_BYTECODE=1 \
  UV_MALWARE_CHECK=1 \
  UV_MANAGED_PYTHON=1 \
  UV_PYTHON="${PYTHON_VERSION}" \
  UV_TORCH_BACKEND="cpu" \
  MCP_PROXY_ARGS="--host=0.0.0.0 --port=19222" \
  CHROME_DEVTOOLS_MCP_ARGS="--browser-url=http://localhost:9222"

RUN npm install --global chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION} \
  && uv tool install mcp-proxy==${MCP_PROXY_VERSION}

COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
