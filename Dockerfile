# syntax=docker/dockerfile:1
FROM node:24-slim

ARG FRAZIYM_MCP_VERSION=0.1.1-beta.0
RUN npm install --global --no-fund --no-audit "@fraziym/mcp@${FRAZIYM_MCP_VERSION}"

LABEL org.opencontainers.image.title="fraziym-mcp" \
      org.opencontainers.image.description="The fastest, most secure MCP toolbelt: 74 tools behind one process, plus router/fix/brain gateway endpoints." \
      org.opencontainers.image.source="https://github.com/Akik-Forazi/MCP" \
      org.opencontainers.image.licenses="MIT"

# stdio by default; for containers run HTTP:  docker run -p 7777:7777 ghcr.io/akik-forazi/fraziym-mcp serve --http --host 0.0.0.0 --token "$TOKEN"
ENTRYPOINT ["fraziym-mcp"]
CMD ["serve"]
