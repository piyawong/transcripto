FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Rewrites are resolved at build time: point /api at the api service.
ARG API_URL=http://api:8010
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
# Also read at runtime by the upload route handler (app/api/jobs/[id]/file/route.ts).
ARG API_URL=http://api:8010
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3010 HOSTNAME=0.0.0.0 API_URL=$API_URL
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3010
CMD ["node", "server.js"]
