# syntax=docker/dockerfile:1
FROM node:lts-alpine

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV PATH="/root/.local/bin/:$PATH" \
  UV_COMPILE_BYTECODE=1 \
  UV_MALWARE_CHECK=1 \
  UV_MANAGED_PYTHON=1 \
  UV_PYTHON="3.15" \
  UV_TORCH_BACKEND="cpu"

RUN npm install --global chrome-devtools-mcp@latest \
  && uv tool install mcp-proxy

ENTRYPOINT ["mcp-proxy", "--host=0.0.0.0", "--port=19222", "--", "chrome-devtools-mcp", "--browser-url=http://localhost:9222"]
