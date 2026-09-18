FROM node:22-alpine
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm_config_fetch_retries=8 npm_config_fetch_retry_maxtimeout=120000 pnpm install --frozen-lockfile

COPY . .
# Variables factices, valables uniquement pour cette couche RUN (non persistées
# dans l'image, contrairement à ENV) : `prisma generate` résout prisma.config.ts
# via DATABASE_URL, et `next build` importe la route /api/health lors de la
# collecte des données de page, ce qui instancie le client Prisma (src/lib/prisma.ts)
# et déclenche getEnv() — qui valide donc l'intégralité du schéma, pas seulement
# DATABASE_URL. Toutes les valeurs ci-dessous pointent vers des hôtes/domaines
# inutilisables (localhost, .invalid) et ne peuvent pas être confondues avec de
# vrais secrets ; le compose fournit les vraies valeurs au runtime via env_file.
RUN export \
  DATABASE_URL="postgres://build:build@localhost:5432/build" \
  MASTER_KEY="0000000000000000000000000000000000000000000000000000000000000000" \
  BETTER_AUTH_SECRET="build-placeholder-secret-non-utilise-en-production" \
  BETTER_AUTH_URL="http://build.invalid" \
  ADMIN_EMAIL="build@build.invalid" \
  ADMIN_PASSWORD="build-placeholder-password" \
  GOWA_BASE_URL="http://build.invalid" \
  GOWA_BASIC_AUTH="build:build" \
  GOWA_WEBHOOK_SECRET="build-placeholder-webhook-secret" \
  && pnpm prisma generate \
  && pnpm build

EXPOSE 3000
CMD ["sh", "-c", "pnpm prisma migrate deploy && pnpm tsx src/scripts/seed-admin.ts && pnpm start"]
