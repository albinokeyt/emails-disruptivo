# ---------------------------------------------------------------------------
# Etapa 1: compilar el panel de React (web/) con sus dependencias de desarrollo.
# Queda fuera de la imagen final: de aquí solo viaja web/dist.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS panel
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# Etapa 2: imagen final. Solo dependencias de producción, el código del servidor
# (src/, con src/migrations dentro: las migraciones corren al arrancar) y el panel ya compilado.
# ---------------------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY --from=panel /app/web/dist ./web/dist

# 8080 = API + panel (lo enruta Traefik por HTTP).
# 2525 = pasarela SMTP; es TCP plano, así que se publica desde la sección Ports, no desde Domains.
EXPOSE 8080 2525

# en forma de shell a propósito: así respeta PORT si se cambia por variable de entorno
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null 2>&1 || exit 1

CMD ["node", "src/index.js"]
