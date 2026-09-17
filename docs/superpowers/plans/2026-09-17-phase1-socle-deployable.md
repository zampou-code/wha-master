# Phase 1 — Socle déployable : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mettre en ligne sur Dokploy une application authentifiée, appairée à WhatsApp, qui enregistre en base tous les messages entrants et sortants sans jamais en envoyer aucun.

**Architecture:** Un Compose à trois conteneurs — `app` (Next.js, seul exposé via Traefik), `gowa` (WhatsApp, réseau interne), `postgres` (réseau interne). L'application valide sa configuration au démarrage, chiffre ses secrets, expose un webhook signé qui persiste les messages, et sert une page d'appairage QR derrière Better Auth.

**Tech Stack:** Node 22, pnpm, Next.js 16 (App Router), TypeScript strict, Prisma 7 + `@prisma/adapter-pg`, PostgreSQL 16, Better Auth, zod, Vitest, Docker Compose, Dokploy/Traefik.

**Spec:** `docs/superpowers/specs/2026-09-17-whatsapp-harness-design.md`

## Global Constraints

- **P1 — Activation explicite par contact** : `Contact.mode` vaut `OFF` à la création. Aucun code de cette phase ne le change. L'ingestion qui découvre un contact le crée en `OFF`.
- **P2 — Fail-closed** : toute anomalie mène à un non-envoi. En phase 1, aucun code d'envoi n'existe ; le principe s'applique aux erreurs de webhook (répondre en erreur plutôt que d'avaler silencieusement).
- **P5 — Tout est tracé** : chaque message persisté conserve son `waMessageId` d'origine.
- Node `22.x`, pnpm `9.x`.
- Prisma 7 : générateur `prisma-client` (pas `prisma-client-js`), `output = "../src/generated/prisma"`, import depuis `@/generated/prisma/client`, adaptateur `PrismaPg` obligatoire.
- Next.js 16 : le fichier de proxy est `src/proxy.ts` et exporte `proxy` (le nom `middleware` est déprécié).
- GOWA : image `aldinokemal2104/go-whatsapp-web-multidevice`, commande `rest`, port interne `3000`, session dans `/app/storages`.
- Toute l'interface et tous les messages d'erreur destinés à l'utilisateur sont en français.
- `MASTER_KEY` et `BETTER_AUTH_SECRET` sont immuables une fois en production.
- Zod 4 : utiliser l'API de haut niveau (`z.url()`, `z.email()`, `z.looseObject()`). Les formes `z.string().url()` et `.passthrough()` sont dépréciées.
- TypeScript en mode `strict`. Aucun `any` implicite.

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `src/config/env.ts` | Schéma et validation des variables d'environnement |
| `src/lib/crypto.ts` | Chiffrement AES-256-GCM des secrets applicatifs |
| `src/lib/prisma.ts` | Instance unique de PrismaClient avec adaptateur pg |
| `src/lib/auth.ts` | Configuration Better Auth |
| `src/lib/auth-client.ts` | Client Better Auth côté navigateur |
| `src/proxy.ts` | Redirection des routes non authentifiées |
| `src/gowa/types.ts` | Schémas zod des réponses GOWA |
| `src/gowa/client.ts` | Client HTTP typé de GOWA |
| `src/ingest/payload.ts` | Schéma zod du webhook GOWA |
| `src/ingest/signature.ts` | Vérification HMAC du webhook |
| `src/ingest/handler.ts` | Logique de persistance d'un message entrant |
| `src/scripts/seed-admin.ts` | Création du compte unique au démarrage |
| `src/app/api/health/route.ts` | Sonde de santé |
| `src/app/api/auth/[...all]/route.ts` | Routes Better Auth |
| `src/app/api/whatsapp/status/route.ts` | État et QR d'appairage, proxifiés |
| `src/app/api/webhook/gowa/route.ts` | Point d'entrée du webhook |
| `src/app/login/page.tsx` | Formulaire de connexion |
| `src/app/connexion/page.tsx` | Appairage WhatsApp par QR |
| `prisma/schema.prisma` | Modèle de données |
| `Dockerfile`, `docker-compose.yml`, `docker-compose.dev.yml` | Conteneurisation |
| `docs/deploiement.md` | Runbook Dokploy |

---

### Task 1 : Bootstrap du projet et configuration validée

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config/env.ts`
- Test: `tests/config/env.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `parseEnv(raw: NodeJS.ProcessEnv): Env`, `getEnv(): Env`, `resetEnvCache(): void`, type `Env` avec les champs `DATABASE_URL`, `MASTER_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `GOWA_BASE_URL`, `GOWA_BASIC_AUTH`, `GOWA_WEBHOOK_SECRET`, `CONTROL_GROUP_JID?`.

- [ ] **Step 1 : Initialiser le projet**

```bash
pnpm init
pnpm add next@16 react react-dom zod
pnpm add -D typescript @types/node @types/react @types/react-dom vitest vite-tsconfig-paths
```

Créer `tsconfig.json` :

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "skipLibCheck": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Créer `vitest.config.ts` :

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.int.test.ts"],
  },
});
```

Créer `.gitignore` (compléter celui qui existe) avec `src/generated/`.

Ajouter dans `package.json` :

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "test": "vitest run",
  "test:int": "vitest run --config vitest.int.config.ts"
}
```

- [ ] **Step 2 : Écrire le test qui échoue**

`tests/config/env.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { parseEnv } from "@/config/env";

const valide = {
  DATABASE_URL: "postgres://wha:secret@postgres:5432/wha",
  MASTER_KEY: "a".repeat(64),
  BETTER_AUTH_SECRET: "b".repeat(32),
  BETTER_AUTH_URL: "https://wha.example.com",
  ADMIN_EMAIL: "moi@example.com",
  ADMIN_PASSWORD: "motdepassetreslong",
  GOWA_BASE_URL: "http://gowa:3000",
  GOWA_BASIC_AUTH: "admin:secret",
  GOWA_WEBHOOK_SECRET: "c".repeat(16),
};

describe("parseEnv", () => {
  it("accepte une configuration complète", () => {
    const env = parseEnv(valide as NodeJS.ProcessEnv);
    expect(env.GOWA_BASE_URL).toBe("http://gowa:3000");
    expect(env.CONTROL_GROUP_JID).toBeUndefined();
  });

  it("rejette une MASTER_KEY qui n'est pas 32 octets hexadécimaux", () => {
    expect(() => parseEnv({ ...valide, MASTER_KEY: "trop-court" } as NodeJS.ProcessEnv))
      .toThrow(/MASTER_KEY/);
  });

  it("liste toutes les variables manquantes dans un seul message", () => {
    expect(() => parseEnv({} as NodeJS.ProcessEnv))
      .toThrow(/DATABASE_URL[\s\S]*GOWA_WEBHOOK_SECRET/);
  });

  it("rejette un GOWA_BASIC_AUTH sans deux-points", () => {
    expect(() => parseEnv({ ...valide, GOWA_BASIC_AUTH: "adminsecret" } as NodeJS.ProcessEnv))
      .toThrow(/GOWA_BASIC_AUTH/);
  });
});
```

- [ ] **Step 3 : Vérifier que le test échoue**

Run: `pnpm test tests/config/env.test.ts`
Expected: FAIL — le module `@/config/env` n'existe pas.

- [ ] **Step 4 : Implémenter**

`src/config/env.ts` :

```ts
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "MASTER_KEY doit faire 32 octets en hexadécimal (64 caractères)"),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET doit faire au moins 32 caractères"),
  BETTER_AUTH_URL: z.url(),
  ADMIN_EMAIL: z.email(),
  ADMIN_PASSWORD: z.string().min(12, "ADMIN_PASSWORD doit faire au moins 12 caractères"),
  GOWA_BASE_URL: z.url(),
  GOWA_BASIC_AUTH: z
    .string()
    .regex(/^[^:]+:.+$/, "GOWA_BASIC_AUTH doit être au format identifiant:motdepasse"),
  GOWA_WEBHOOK_SECRET: z.string().min(16, "GOWA_WEBHOOK_SECRET doit faire au moins 16 caractères"),
  CONTROL_GROUP_JID: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: NodeJS.ProcessEnv): Env {
  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")} : ${issue.message}`)
      .join("\n");
    throw new Error(`Configuration d'environnement invalide :\n${details}`);
  }
  return result.data;
}

let cache: Env | null = null;

export function getEnv(): Env {
  if (cache === null) cache = parseEnv(process.env);
  return cache;
}

export function resetEnvCache(): void {
  cache = null;
}
```

- [ ] **Step 5 : Vérifier que le test passe**

Run: `pnpm test tests/config/env.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6 : Écrire `.env.example`**

```bash
# Domaine public de l'application (vide en local)
APP_DOMAIN=

# Base de données
POSTGRES_PASSWORD=change-moi
DATABASE_URL=postgres://wha:change-moi@postgres:5432/wha
DATABASE_URL_TEST=postgres://wha:change-moi@127.0.0.1:5432/wha_test

# IMMUABLE — générer une fois : openssl rand -hex 32
MASTER_KEY=
# IMMUABLE — générer une fois : openssl rand -base64 48
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000

# Compte unique, créé au premier démarrage
ADMIN_EMAIL=
ADMIN_PASSWORD=

# GOWA (réseau interne uniquement)
GOWA_BASE_URL=http://gowa:3000
GOWA_BASIC_AUTH=admin:change-moi
GOWA_WEBHOOK_SECRET=

# Renseigné après création du groupe de contrôle (phase 3)
CONTROL_GROUP_JID=
```

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "feat: bootstrap du projet et validation de la configuration"
```

---

### Task 2 : Chiffrement des secrets

**Files:**
- Create: `src/lib/crypto.ts`
- Test: `tests/lib/crypto.test.ts`

**Interfaces:**
- Consumes: rien (la clé est passée en argument, pas lue de l'environnement — c'est ce qui rend le module testable).
- Produces: `encryptSecret(plaintext: string, masterKeyHex: string): string`, `decryptSecret(payload: string, masterKeyHex: string): string`, `maskSecret(plaintext: string): string`. Le format sérialisé est `iv.tag.ciphertext`, chaque segment en base64url.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/lib/crypto.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, maskSecret } from "@/lib/crypto";

const CLE = "f".repeat(64);
const AUTRE_CLE = "e".repeat(64);

describe("chiffrement des secrets", () => {
  it("retrouve le texte d'origine après un aller-retour", () => {
    const chiffre = encryptSecret("sk-ant-api03-exemple", CLE);
    expect(decryptSecret(chiffre, CLE)).toBe("sk-ant-api03-exemple");
  });

  it("produit un chiffré différent à chaque appel", () => {
    expect(encryptSecret("meme-valeur", CLE)).not.toBe(encryptSecret("meme-valeur", CLE));
  });

  it("refuse de déchiffrer avec une autre clé", () => {
    const chiffre = encryptSecret("secret", CLE);
    expect(() => decryptSecret(chiffre, AUTRE_CLE)).toThrow();
  });

  it("détecte une altération du chiffré", () => {
    const chiffre = encryptSecret("secret", CLE);
    const [iv, tag, data] = chiffre.split(".");
    const altere = `${iv}.${tag}.${data.slice(0, -2)}AA`;
    expect(() => decryptSecret(altere, CLE)).toThrow();
  });

  it("rejette un format malformé", () => {
    expect(() => decryptSecret("nimporte-quoi", CLE)).toThrow(/malformé/);
  });

  it("masque un secret en ne laissant que les bords", () => {
    expect(maskSecret("sk-ant-api03-abcdefgh")).toBe("sk-a…efgh");
    expect(maskSecret("court")).toBe("••••");
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/lib/crypto.test.ts`
Expected: FAIL — `@/lib/crypto` introuvable.

- [ ] **Step 3 : Implémenter**

`src/lib/crypto.ts` :

```ts
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHME = "aes-256-gcm";
const TAILLE_IV = 12;

function cle(masterKeyHex: string): Buffer {
  const buffer = Buffer.from(masterKeyHex, "hex");
  if (buffer.length !== 32) {
    throw new Error("MASTER_KEY invalide : 32 octets hexadécimaux attendus");
  }
  return buffer;
}

export function encryptSecret(plaintext: string, masterKeyHex: string): string {
  const iv = randomBytes(TAILLE_IV);
  const cipher = createCipheriv(ALGORITHME, cle(masterKeyHex), iv);
  const chiffre = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    chiffre.toString("base64url"),
  ].join(".");
}

export function decryptSecret(payload: string, masterKeyHex: string): string {
  const segments = payload.split(".");
  if (segments.length !== 3) {
    throw new Error("Secret chiffré malformé");
  }
  const [ivB64, tagB64, dataB64] = segments;
  const decipher = createDecipheriv(ALGORITHME, cle(masterKeyHex), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
```

- [ ] **Step 4 : Vérifier que le test passe**

Run: `pnpm test tests/lib/crypto.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "feat: chiffrement AES-256-GCM des secrets applicatifs"
```

---

### Task 3 : Schéma Prisma et base de test

**Files:**
- Create: `prisma/schema.prisma`, `src/lib/prisma.ts`, `vitest.int.config.ts`, `tests/int-setup.ts`, `tests/helpers/db.ts`
- Create: `docker-compose.dev.yml`
- Test: `tests/db/contact.int.test.ts`

**Interfaces:**
- Consumes: `getEnv()` de Task 1.
- Produces: `prisma` (instance `PrismaClient`), et les modèles Prisma listés ci-dessous. Les tâches suivantes utilisent `prisma.contact`, `prisma.thread`, `prisma.message`.

- [ ] **Step 1 : Installer Prisma 7 et écrire le schéma**

```bash
pnpm add @prisma/client @prisma/adapter-pg pg
pnpm add -D prisma @types/pg tsx
```

`prisma/schema.prisma` :

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum ContactMode {
  OFF
  DRAFT
  AUTO
}

enum Direction {
  IN
  OUT
}

enum MessageSource {
  HUMAN
  AUTO
  IMPORT
}

enum FactSource {
  QUESTIONNAIRE
  INFERRED
}

enum RiskCategory {
  ENGAGEMENT
  FACT
  EMOTIONAL
  MONEY
  INTIMATE
  THIRD_PARTY
  LOW_CONFIDENCE
  NON_TEXT
}

enum DecisionOutcome {
  AUTO_SENT
  DRAFTED
  ESCALATED
  IGNORED
  EXPIRED
}

enum EscalationStatus {
  OPEN
  RESOLVED
  EXPIRED
}

enum ProviderKind {
  ANTHROPIC
  OPENAI
  GOOGLE
  OPENAI_COMPATIBLE
  OLLAMA
}

model Contact {
  id          String      @id @default(cuid())
  jid         String      @unique
  pushName    String?
  alias       String?
  isAdult     Boolean     @default(false)
  mode        ContactMode @default(OFF)
  activatedAt DateTime?
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  policy  ContactPolicy?
  thread  Thread?
  profile ContactProfile?
  decisions Decision[]
}

model ContactPolicy {
  id        String  @id @default(cuid())
  contactId String  @unique
  contact   Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)

  guardEngagement Boolean @default(true)
  guardFacts      Boolean @default(true)
  guardEmotional  Boolean @default(true)
  guardMoney      Boolean @default(true)
  guardIntimate   Boolean @default(true)
  guardThirdParty Boolean @default(true)

  intimateOverride Boolean @default(false)

  quietHoursStart Int?
  quietHoursEnd   Int?
  timezone        String  @default("Africa/Abidjan")

  maxAutoStreak Int @default(6)
  minDelaySec   Int @default(45)
  maxDelaySec   Int @default(600)

  styleLength     String @default("moyen")
  styleEmoji      String @default("parfois")
  styleFormality  String @default("tutoiement")
  styleLanguage   String @default("fr")
  styleInitiative String @default("rare")

  providerRouteId String?
}

model Thread {
  id        String  @id @default(cuid())
  contactId String  @unique
  contact   Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)

  rollingSummary          String   @default("")
  lastSummarizedMessageId String?
  relationStage           String   @default("inconnu")
  medianReplyDelaySec     Int?
  autoStreak              Int      @default(0)
  lastMessageAt           DateTime?

  messages Message[]
}

model Message {
  id          String        @id @default(cuid())
  threadId    String
  thread      Thread        @relation(fields: [threadId], references: [id], onDelete: Cascade)
  waMessageId String        @unique
  direction   Direction
  source      MessageSource
  text        String?
  mediaType   String?
  timestamp   DateTime
  replyToWaId String?
  createdAt   DateTime      @default(now())

  decision Decision?

  @@index([threadId, timestamp])
}

model PersonaProfile {
  id         String   @id @default("self")
  styleGuide Json     @default("{}")
  hardLimits String[] @default([])
  updatedAt  DateTime @updatedAt
}

model PersonaFact {
  id         String     @id @default(cuid())
  key        String     @unique
  value      String
  shareable  Boolean    @default(false)
  confidence Float      @default(1)
  source     FactSource @default(QUESTIONNAIRE)
  createdAt  DateTime   @default(now())
}

model ContactProfile {
  id             String  @id @default(cuid())
  contactId      String  @unique
  contact        Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)
  observedTone   String?
  observedRhythm String?
  topics         String[] @default([])
  proposedParams Json     @default("{}")
  updatedAt      DateTime @updatedAt
}

model Decision {
  id        String  @id @default(cuid())
  messageId String  @unique
  message   Message @relation(fields: [messageId], references: [id], onDelete: Cascade)
  contactId String
  contact   Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)

  risks              RiskCategory[]
  ruleFired          String
  outcome            DecisionOutcome
  classifierProvider String?
  composerProvider   String?
  latencyMs          Int?
  costUsd            Float?
  rawClassification  Json?
  createdAt          DateTime        @default(now())

  escalation Escalation?

  @@index([contactId, createdAt])
}

model Escalation {
  id                  String           @id @default(cuid())
  decisionId          String           @unique
  decision            Decision         @relation(fields: [decisionId], references: [id], onDelete: Cascade)
  status              EscalationStatus @default(OPEN)
  controlMessageWaId  String?
  proposedText        String?
  resolution          String?
  resolvedText        String?
  resolvedAt          DateTime?
  expiresAt           DateTime
  createdAt           DateTime         @default(now())

  @@index([status, expiresAt])
}

model ProviderConfig {
  id              String       @id @default(cuid())
  name            String       @unique
  kind            ProviderKind
  apiKeyEncrypted String?
  baseUrl         String?
  enabled         Boolean      @default(true)
  healthyAt       DateTime?
  lastError       String?
  createdAt       DateTime     @default(now())
}

model ProviderRoute {
  id        String  @id @default(cuid())
  name      String  @unique
  isDefault Boolean @default(false)
  entries   Json    @default("{}")
}

model SystemState {
  id           String  @id @default("singleton")
  globalPaused Boolean @default(false)
}
```

- [ ] **Step 2 : Créer le Compose de développement et lancer PostgreSQL**

`docker-compose.dev.yml` — superposé au Compose de production pour publier les ports en local uniquement :

```yaml
services:
  postgres:
    ports:
      - "127.0.0.1:5432:5432"
  gowa:
    ports:
      - "127.0.0.1:3001:3000"
```

Le `docker-compose.yml` de production est créé en Task 4. Pour cette tâche, démarrer un PostgreSQL isolé :

```bash
docker run -d --name wha-pg -e POSTGRES_USER=wha -e POSTGRES_PASSWORD=wha \
  -e POSTGRES_DB=wha -p 127.0.0.1:5432:5432 postgres:16-alpine
docker exec wha-pg psql -U wha -d wha -c "CREATE DATABASE wha_test;"
```

- [ ] **Step 3 : Écrire le test d'intégration qui échoue**

`vitest.int.config.ts` :

```ts
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["tests/**/*.int.test.ts"],
    globalSetup: ["tests/int-setup.ts"],
    fileParallelism: false,
  },
});
```

`tests/int-setup.ts` — il renseigne aussi des valeurs factices pour les variables
que `getEnv()` exige mais dont les tests d'intégration n'ont pas besoin :

```ts
import { execSync } from "node:child_process";

export default function setup() {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error("DATABASE_URL_TEST doit être défini pour les tests d'intégration");

  process.env.DATABASE_URL = url;
  process.env.MASTER_KEY ??= "a".repeat(64);
  process.env.BETTER_AUTH_SECRET ??= "b".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.ADMIN_EMAIL ??= "test@example.com";
  process.env.ADMIN_PASSWORD ??= "motdepassetest";
  process.env.GOWA_BASE_URL ??= "http://localhost:3001";
  process.env.GOWA_BASIC_AUTH ??= "admin:test";
  process.env.GOWA_WEBHOOK_SECRET ??= "c".repeat(16);

  execSync("pnpm prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
```

`tests/helpers/db.ts` :

```ts
import { prisma } from "@/lib/prisma";

export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Message", "Thread", "ContactPolicy", "ContactProfile", "Decision", "Escalation", "Contact" RESTART IDENTITY CASCADE',
  );
}
```

`tests/db/contact.int.test.ts` :

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "../helpers/db";

describe("modèle Contact", () => {
  beforeEach(resetDb);

  it("crée un contact en mode OFF par défaut (principe P1)", async () => {
    const contact = await prisma.contact.create({
      data: { jid: "22500000001@s.whatsapp.net" },
    });
    expect(contact.mode).toBe("OFF");
    expect(contact.isAdult).toBe(false);
    expect(contact.activatedAt).toBeNull();
  });

  it("interdit deux contacts avec le même jid", async () => {
    await prisma.contact.create({ data: { jid: "22500000002@s.whatsapp.net" } });
    await expect(
      prisma.contact.create({ data: { jid: "22500000002@s.whatsapp.net" } }),
    ).rejects.toThrow();
  });

  it("supprime le fil et les messages en cascade", async () => {
    const contact = await prisma.contact.create({
      data: {
        jid: "22500000003@s.whatsapp.net",
        thread: { create: {} },
      },
      include: { thread: true },
    });
    await prisma.message.create({
      data: {
        threadId: contact.thread!.id,
        waMessageId: "MSG-1",
        direction: "IN",
        source: "HUMAN",
        text: "salut",
        timestamp: new Date(),
      },
    });
    await prisma.contact.delete({ where: { id: contact.id } });
    expect(await prisma.message.count()).toBe(0);
    expect(await prisma.thread.count()).toBe(0);
  });
});
```

- [ ] **Step 4 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST=postgres://wha:wha@127.0.0.1:5432/wha_test pnpm test:int`
Expected: FAIL — `@/lib/prisma` introuvable.

- [ ] **Step 5 : Générer le client et implémenter le singleton**

```bash
DATABASE_URL=postgres://wha:wha@127.0.0.1:5432/wha pnpm prisma migrate dev --name init
```

`src/lib/prisma.ts` :

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/config/env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function creerClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? creerClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

- [ ] **Step 6 : Vérifier que le test passe**

Run: `DATABASE_URL_TEST=postgres://wha:wha@127.0.0.1:5432/wha_test pnpm test:int`
Expected: PASS (3 tests).

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "feat: schéma Prisma complet et client avec adaptateur pg"
```

---

### Task 4 : Conteneurisation et sonde de santé

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/api/health/route.ts`
- Test: `tests/api/health.test.ts`

**Interfaces:**
- Consumes: `prisma` de Task 3.
- Produces: `GET /api/health` renvoyant `{ status: "ok" | "degraded", db: "up" | "down" }` avec le code 200 ou 503. Le service `app` écoute sur le port 3000 dans le réseau Compose.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/api/health.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryRaw = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: queryRaw } }));

describe("GET /api/health", () => {
  beforeEach(() => queryRaw.mockReset());

  it("répond 200 quand la base répond", async () => {
    queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", db: "up" });
  });

  it("répond 503 quand la base est injoignable", async () => {
    queryRaw.mockRejectedValue(new Error("connexion refusée"));
    const { GET } = await import("@/app/api/health/route");
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "degraded", db: "down" });
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/api/health.test.ts`
Expected: FAIL — la route n'existe pas.

- [ ] **Step 3 : Implémenter la route et le squelette Next**

`src/app/layout.tsx` :

```tsx
import type { ReactNode } from "react";

export const metadata = { title: "Harness WhatsApp" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
```

`src/app/page.tsx` :

```tsx
export default function Accueil() {
  return <main><h1>Harness WhatsApp</h1></main>;
}
```

`src/app/api/health/route.ts` :

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "up" });
  } catch {
    return NextResponse.json({ status: "degraded", db: "down" }, { status: 503 });
  }
}
```

- [ ] **Step 4 : Vérifier que le test passe**

Run: `pnpm test tests/api/health.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5 : Écrire le Dockerfile**

`.dockerignore` :

```
node_modules
.next
.git
.env
docs
tests
```

`Dockerfile` :

```dockerfile
FROM node:22-alpine
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma generate && pnpm build

EXPOSE 3000
CMD ["sh", "-c", "pnpm prisma migrate deploy && pnpm tsx src/scripts/seed-admin.ts && pnpm start"]
```

Note : `src/scripts/seed-admin.ts` est créé en Task 5. Jusque-là, remplacer la commande par `CMD ["sh", "-c", "pnpm prisma migrate deploy && pnpm start"]` et la compléter en Task 5.

- [ ] **Step 6 : Écrire le Compose de production**

`docker-compose.yml` :

```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgres://wha:${POSTGRES_PASSWORD}@postgres:5432/wha
      GOWA_BASE_URL: http://gowa:3000
    depends_on:
      postgres:
        condition: service_healthy
      gowa:
        condition: service_started
    labels:
      - traefik.enable=true
      - traefik.http.routers.wha.rule=Host(`${APP_DOMAIN}`)
      - traefik.http.routers.wha.entrypoints=websecure
      - traefik.http.routers.wha.tls.certresolver=letsencrypt
      - traefik.http.services.wha.loadbalancer.server.port=3000
    networks:
      - interne
      - dokploy-network

  gowa:
    image: aldinokemal2104/go-whatsapp-web-multidevice:latest
    restart: unless-stopped
    command: rest
    environment:
      APP_PORT: "3000"
      APP_BASIC_AUTH: ${GOWA_BASIC_AUTH}
      DB_URI: file:storages/whatsapp.db
      WHATSAPP_WEBHOOK: http://app:3000/api/webhook/gowa
      WHATSAPP_WEBHOOK_SECRET: ${GOWA_WEBHOOK_SECRET}
    volumes:
      - gowa-session:/app/storages
    networks:
      - interne

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: wha
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: wha
    volumes:
      - pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U wha -d wha"]
      interval: 5s
      timeout: 3s
      retries: 20
    networks:
      - interne

volumes:
  gowa-session:
  pg-data:

networks:
  interne:
  dokploy-network:
    external: true
```

Ni `gowa` ni `postgres` ne déclarent de `ports` ni de labels Traefik : ils sont injoignables depuis l'extérieur.

- [ ] **Step 7 : Vérifier le démarrage local**

```bash
cp .env.example .env   # renseigner MASTER_KEY, BETTER_AUTH_SECRET, POSTGRES_PASSWORD, ADMIN_*
docker network create dokploy-network || true
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
curl -s localhost:3001/app/status  # GOWA répond derrière son auth basique
docker compose exec app wget -qO- http://localhost:3000/api/health
```

Expected: `{"status":"ok","db":"up"}`.

- [ ] **Step 8 : Commit**

```bash
git add -A
git commit -m "feat: Dockerfile, Compose à trois services et sonde de santé"
```

---

### Task 5 : Better Auth et compte unique

**Files:**
- Create: `src/lib/auth.ts`, `src/lib/auth-client.ts`, `src/app/api/auth/[...all]/route.ts`, `src/proxy.ts`, `src/scripts/seed-admin.ts`, `src/app/login/page.tsx`
- Modify: `prisma/schema.prisma` (tables Better Auth), `Dockerfile` (commande de démarrage)
- Test: `tests/auth/proxy.test.ts`, `tests/auth/seed-admin.int.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 3), `getEnv()` (Task 1).
- Produces: `auth` (instance Better Auth), `requireSession(headers: Headers): Promise<{ user: { id: string; email: string } }>` qui lève une erreur si la session est absente, et `proxy(request: NextRequest)`.

- [ ] **Step 1 : Installer la dépendance**

```bash
pnpm add better-auth
```

La génération des tables vient en Step 4bis, une fois `src/lib/auth.ts` écrit : la
CLI Better Auth lit ce fichier pour savoir quelles tables produire.

- [ ] **Step 2 : Écrire les tests qui échouent**

`tests/auth/proxy.test.ts` :

```ts
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const getSessionCookie = vi.fn();
vi.mock("better-auth/cookies", () => ({ getSessionCookie }));

function requete(chemin: string): NextRequest {
  return new NextRequest(new URL(chemin, "https://wha.example.com"));
}

describe("proxy d'authentification", () => {
  it("laisse passer les routes publiques sans session", async () => {
    getSessionCookie.mockReturnValue(null);
    const { proxy } = await import("@/proxy");
    for (const chemin of ["/login", "/api/auth/sign-in", "/api/health", "/api/webhook/gowa"]) {
      expect(proxy(requete(chemin)).status).toBe(200);
    }
  });

  it("redirige vers /login quand le cookie de session est absent", async () => {
    getSessionCookie.mockReturnValue(null);
    const { proxy } = await import("@/proxy");
    const response = proxy(requete("/connexion"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://wha.example.com/login");
  });

  it("laisse passer quand le cookie de session est présent", async () => {
    getSessionCookie.mockReturnValue("jeton");
    const { proxy } = await import("@/proxy");
    expect(proxy(requete("/connexion")).status).toBe(200);
  });
});
```

`tests/auth/seed-admin.int.test.ts` :

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { seedAdmin } from "@/scripts/seed-admin";

describe("création du compte unique", () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "session", "account", "user" CASCADE');
  });

  it("crée le compte à partir de ADMIN_EMAIL et ADMIN_PASSWORD", async () => {
    await seedAdmin();
    const utilisateurs = await prisma.user.findMany();
    expect(utilisateurs).toHaveLength(1);
    expect(utilisateurs[0].email).toBe(process.env.ADMIN_EMAIL);
  });

  it("est idempotent : un deuxième appel ne crée pas de doublon", async () => {
    await seedAdmin();
    await seedAdmin();
    expect(await prisma.user.count()).toBe(1);
  });
});
```

- [ ] **Step 3 : Vérifier que les tests échouent**

Run: `pnpm test tests/auth/proxy.test.ts`
Expected: FAIL — `@/proxy` introuvable.

- [ ] **Step 4 : Implémenter la configuration Better Auth**

`src/lib/auth.ts` :

```ts
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "./prisma";
import { getEnv } from "@/config/env";

const env = getEnv();

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.BETTER_AUTH_URL],
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      secure: env.BETTER_AUTH_URL.startsWith("https://"),
      sameSite: "lax",
    },
  },
  rateLimit: { enabled: true, window: 60, max: 10 },
  plugins: [twoFactor(), nextCookies()],
});

export async function requireSession(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new Error("Session absente");
  return session;
}
```

`src/app/api/auth/[...all]/route.ts` :

```ts
import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const { GET, POST } = toNextJsHandler(auth);
```

`src/lib/auth-client.ts` :

```ts
"use client";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
export const { signIn, signOut, useSession } = authClient;
```

- [ ] **Step 4bis : Générer et migrer les tables Better Auth**

```bash
pnpm dlx @better-auth/cli@latest generate --config src/lib/auth.ts --output prisma/schema.prisma
pnpm prisma migrate dev --name better-auth
```

Les modèles `user`, `session`, `account`, `verification` et `twoFactor` sont ajoutés
à `prisma/schema.prisma`. Vérifier qu'aucun modèle métier de Task 3 n'a été écrasé
avant de migrer.

- [ ] **Step 5 : Implémenter le proxy**

`src/proxy.ts` :

```ts
import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const CHEMINS_PUBLICS = ["/login", "/api/auth", "/api/health", "/api/webhook"];

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (CHEMINS_PUBLICS.some((chemin) => pathname.startsWith(chemin))) {
    return NextResponse.next();
  }

  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

Ce contrôle est optimiste : il ne lit que la présence du cookie. Chaque route d'API sensible revérifie la session avec `requireSession()`.

- [ ] **Step 6 : Implémenter la création du compte**

`src/scripts/seed-admin.ts` :

```ts
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEnv } from "@/config/env";

export async function seedAdmin(): Promise<void> {
  const env = getEnv();
  const existant = await prisma.user.findUnique({ where: { email: env.ADMIN_EMAIL } });
  if (existant) {
    console.log(`Compte ${env.ADMIN_EMAIL} déjà présent, rien à faire.`);
    return;
  }

  const total = await prisma.user.count();
  if (total > 0) {
    throw new Error(
      "Un compte existe déjà avec une autre adresse. Cette application est mono-utilisateur.",
    );
  }

  const ctx = await auth.$context;
  const hash = await ctx.password.hash(env.ADMIN_PASSWORD);
  const utilisateur = await ctx.internalAdapter.createUser({
    email: env.ADMIN_EMAIL,
    name: "Propriétaire",
    emailVerified: true,
  });
  await ctx.internalAdapter.createAccount({
    userId: utilisateur.id,
    providerId: "credential",
    accountId: utilisateur.id,
    password: hash,
  });
  console.log(`Compte ${env.ADMIN_EMAIL} créé.`);
}

if (process.argv[1]?.endsWith("seed-admin.ts")) {
  seedAdmin()
    .then(() => process.exit(0))
    .catch((erreur) => {
      console.error(erreur);
      process.exit(1);
    });
}
```

- [ ] **Step 7 : Implémenter la page de connexion**

`src/app/login/page.tsx` :

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";

export default function Connexion() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  async function soumettre(evenement: React.FormEvent) {
    evenement.preventDefault();
    setEnCours(true);
    setErreur(null);
    const { error } = await signIn.email({ email, password: motDePasse });
    setEnCours(false);
    if (error) {
      setErreur("Identifiants incorrects.");
      return;
    }
    router.push("/connexion");
  }

  return (
    <main>
      <h1>Connexion</h1>
      <form onSubmit={soumettre}>
        <label htmlFor="email">Adresse e-mail</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="mdp">Mot de passe</label>
        <input id="mdp" type="password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} required />
        {erreur && <p role="alert">{erreur}</p>}
        <button type="submit" disabled={enCours}>{enCours ? "Connexion…" : "Se connecter"}</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 8 : Vérifier que les tests passent**

Run: `pnpm test tests/auth/proxy.test.ts`
Expected: PASS (3 tests).

Run: `DATABASE_URL_TEST=postgres://wha:wha@127.0.0.1:5432/wha_test pnpm test:int`
Expected: PASS, y compris les 2 tests de `seed-admin.int.test.ts`.

- [ ] **Step 9 : Compléter le Dockerfile**

Remplacer la commande de démarrage par :

```dockerfile
CMD ["sh", "-c", "pnpm prisma migrate deploy && pnpm tsx src/scripts/seed-admin.ts && pnpm start"]
```

- [ ] **Step 10 : Commit**

```bash
git add -A
git commit -m "feat: Better Auth, compte unique et protection des routes"
```

---

### Task 6 : Client GOWA typé

**Files:**
- Create: `src/gowa/types.ts`, `src/gowa/client.ts`
- Test: `tests/gowa/client.test.ts`

**Interfaces:**
- Consumes: rien (les options sont injectées, y compris `fetch`, ce qui rend le client testable sans réseau).
- Produces:
  - `class GowaError extends Error { readonly status?: number }`
  - `class GowaClient` avec `getStatus(): Promise<GowaStatus>`, `getLoginQr(): Promise<GowaLoginQr>`, `sendText(params: { phone: string; message: string; replyMessageId?: string }): Promise<GowaSendResult>`, `sendChatPresence(params: { phone: string; action: "start" | "stop" }): Promise<void>`
  - `type GowaStatus = { isConnected: boolean; isLoggedIn: boolean; deviceId?: string; jid?: string }`
  - `type GowaLoginQr = { code: string; durationSec: number; imagePath?: string }`
  - `type GowaSendResult = { messageId?: string; status?: string }`
  - `createGowaClient(): GowaClient` qui lit `getEnv()`

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/gowa/client.test.ts` :

```ts
import { describe, it, expect, vi } from "vitest";
import { GowaClient, GowaError } from "@/gowa/client";

function clientAvec(fetchImpl: typeof fetch): GowaClient {
  return new GowaClient({
    baseUrl: "http://gowa:3000",
    basicAuth: "admin:secret",
    fetchImpl,
    timeoutMs: 1000,
  });
}

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GowaClient", () => {
  it("envoie l'en-tête Authorization en Basic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { is_connected: true, is_logged_in: true, device_id: "d1", jid: "225@s.whatsapp.net" } }),
    );
    await clientAvec(fetchMock as unknown as typeof fetch).getStatus();
    const [, init] = fetchMock.mock.calls[0];
    const attendu = `Basic ${Buffer.from("admin:secret").toString("base64")}`;
    expect((init.headers as Record<string, string>).Authorization).toBe(attendu);
  });

  it("normalise la réponse de statut", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { is_connected: true, is_logged_in: false, device_id: "d1", jid: "" } }),
    );
    const statut = await clientAvec(fetchMock as unknown as typeof fetch).getStatus();
    expect(statut).toEqual({ isConnected: true, isLoggedIn: false, deviceId: "d1", jid: "" });
  });

  it("normalise la réponse de login en convertissant la durée", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { code: "2@abc", duration: 30, image_path: "/statics/images/qrcode/a.png" } }),
    );
    const qr = await clientAvec(fetchMock as unknown as typeof fetch).getLoginQr();
    expect(qr.code).toBe("2@abc");
    expect(qr.durationSec).toBe(30);
  });

  it("transmet phone et message au bon endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      reponseJson({ status: 200, code: "SUCCESS", message: "ok", results: { message_id: "M1", status: "sent" } }),
    );
    await clientAvec(fetchMock as unknown as typeof fetch).sendText({ phone: "225@s.whatsapp.net", message: "salut" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gowa:3000/send/message");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ phone: "225@s.whatsapp.net", message: "salut" });
  });

  it("lève une GowaError sur un statut HTTP non 2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reponseJson({ code: "ERROR", message: "non autorisé" }, 401));
    await expect(clientAvec(fetchMock as unknown as typeof fetch).getStatus()).rejects.toBeInstanceOf(GowaError);
  });

  it("lève une GowaError quand la réponse ne correspond pas au schéma", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reponseJson({ inattendu: true }));
    await expect(clientAvec(fetchMock as unknown as typeof fetch).getStatus()).rejects.toThrow(/inattendue/);
  });

  it("lève une GowaError quand la requête dépasse le délai", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    await expect(clientAvec(fetchMock as unknown as typeof fetch).getStatus()).rejects.toThrow(/délai/);
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/gowa/client.test.ts`
Expected: FAIL — `@/gowa/client` introuvable.

- [ ] **Step 3 : Implémenter les schémas**

`src/gowa/types.ts` :

```ts
import { z } from "zod";

const enveloppe = <T extends z.ZodTypeAny>(results: T) =>
  z.object({
    status: z.number().optional(),
    code: z.string(),
    message: z.string(),
    results,
  });

export const statusSchema = enveloppe(
  z.object({
    is_connected: z.boolean(),
    is_logged_in: z.boolean(),
    device_id: z.string().optional(),
    jid: z.string().optional(),
  }),
);

export const loginSchema = enveloppe(
  z.object({
    code: z.string(),
    duration: z.number(),
    image_path: z.string().optional(),
  }),
);

export const sendSchema = enveloppe(
  z.looseObject({
    message_id: z.string().optional(),
    status: z.string().optional(),
  }),
);

export const presenceSchema = enveloppe(z.unknown());

export type GowaStatus = {
  isConnected: boolean;
  isLoggedIn: boolean;
  deviceId?: string;
  jid?: string;
};

export type GowaLoginQr = {
  code: string;
  durationSec: number;
  imagePath?: string;
};

export type GowaSendResult = {
  messageId?: string;
  status?: string;
};
```

- [ ] **Step 4 : Implémenter le client**

`src/gowa/client.ts` :

```ts
import type { z } from "zod";
import { getEnv } from "@/config/env";
import {
  loginSchema,
  presenceSchema,
  sendSchema,
  statusSchema,
  type GowaLoginQr,
  type GowaSendResult,
  type GowaStatus,
} from "./types";

export class GowaError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "GowaError";
  }
}

export interface GowaClientOptions {
  baseUrl: string;
  basicAuth: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GowaClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: GowaClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async appeler<T>(
    chemin: string,
    schema: z.ZodType<T>,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), this.timeoutMs);
    const encode = Buffer.from(this.options.basicAuth).toString("base64");

    let reponse: Response;
    try {
      reponse = await this.fetchImpl(`${this.options.baseUrl}${chemin}`, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Basic ${encode}`,
          "Content-Type": "application/json",
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controleur.signal,
      });
    } catch (erreur) {
      if (erreur instanceof Error && erreur.name === "AbortError") {
        throw new GowaError(`GOWA n'a pas répondu dans le délai imparti (${chemin})`);
      }
      throw new GowaError(`GOWA injoignable (${chemin}) : ${String(erreur)}`);
    } finally {
      clearTimeout(minuteur);
    }

    if (!reponse.ok) {
      throw new GowaError(`GOWA a répondu ${reponse.status} sur ${chemin}`, reponse.status);
    }

    let brut: unknown;
    try {
      brut = await reponse.json();
    } catch {
      throw new GowaError(`Réponse GOWA illisible sur ${chemin}`);
    }

    const resultat = schema.safeParse(brut);
    if (!resultat.success) {
      throw new GowaError(`Réponse GOWA inattendue sur ${chemin}`);
    }
    return resultat.data;
  }

  async getStatus(): Promise<GowaStatus> {
    const { results } = await this.appeler("/app/status", statusSchema);
    return {
      isConnected: results.is_connected,
      isLoggedIn: results.is_logged_in,
      deviceId: results.device_id,
      jid: results.jid,
    };
  }

  async getLoginQr(): Promise<GowaLoginQr> {
    const { results } = await this.appeler("/app/login", loginSchema);
    return {
      code: results.code,
      durationSec: Math.round(results.duration),
      imagePath: results.image_path,
    };
  }

  async sendText(params: {
    phone: string;
    message: string;
    replyMessageId?: string;
  }): Promise<GowaSendResult> {
    const body: Record<string, unknown> = { phone: params.phone, message: params.message };
    if (params.replyMessageId) body.reply_message_id = params.replyMessageId;
    const { results } = await this.appeler("/send/message", sendSchema, { method: "POST", body });
    return { messageId: results.message_id, status: results.status };
  }

  async sendChatPresence(params: { phone: string; action: "start" | "stop" }): Promise<void> {
    await this.appeler("/send/chat-presence", presenceSchema, { method: "POST", body: params });
  }
}

export function createGowaClient(): GowaClient {
  const env = getEnv();
  return new GowaClient({ baseUrl: env.GOWA_BASE_URL, basicAuth: env.GOWA_BASIC_AUTH });
}
```

Note : `duration` est sérialisé par Go depuis un `time.Duration`. Si l'instance déployée renvoie des nanosecondes plutôt que des secondes, ajuster `durationSec` et le test correspondant après la première observation réelle en Task 9.

- [ ] **Step 5 : Vérifier que le test passe**

Run: `pnpm test tests/gowa/client.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6 : Commit**

```bash
git add -A
git commit -m "feat: client GOWA typé avec délais et erreurs explicites"
```

---

### Task 7 : Page d'appairage WhatsApp

**Files:**
- Create: `src/app/api/whatsapp/status/route.ts`, `src/app/api/whatsapp/qr/route.ts`, `src/app/connexion/page.tsx`
- Test: `tests/api/whatsapp.test.ts`

**Interfaces:**
- Consumes: `requireSession` (Task 5), `createGowaClient` (Task 6).
- Produces: `GET /api/whatsapp/status` → `{ isConnected, isLoggedIn, deviceId?, jid? }` ou 401 ; `GET /api/whatsapp/qr` → `{ code, durationSec }` ou 401.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/api/whatsapp.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSession = vi.fn();
const getStatus = vi.fn();
const getLoginQr = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession } },
  requireSession: async (headers: Headers) => {
    const session = await getSession({ headers });
    if (!session) throw new Error("Session absente");
    return session;
  },
}));
vi.mock("@/gowa/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/gowa/client")>();
  return { ...original, createGowaClient: () => ({ getStatus, getLoginQr }) };
});

function requete(): Request {
  return new Request("https://wha.example.com/api/whatsapp/status");
}

describe("routes WhatsApp", () => {
  beforeEach(() => {
    getSession.mockReset();
    getStatus.mockReset();
    getLoginQr.mockReset();
  });

  it("refuse le statut sans session", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/whatsapp/status/route");
    expect((await GET(requete())).status).toBe(401);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("renvoie le statut avec une session valide", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getStatus.mockResolvedValue({ isConnected: true, isLoggedIn: true, deviceId: "d1" });
    const { GET } = await import("@/app/api/whatsapp/status/route");
    const reponse = await GET(requete());
    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toMatchObject({ isLoggedIn: true });
  });

  it("refuse le QR sans session", async () => {
    getSession.mockResolvedValue(null);
    const { GET } = await import("@/app/api/whatsapp/qr/route");
    expect((await GET(requete())).status).toBe(401);
    expect(getLoginQr).not.toHaveBeenCalled();
  });

  it("renvoie le code QR sans jamais exposer image_path", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getLoginQr.mockResolvedValue({ code: "2@abc", durationSec: 30, imagePath: "/statics/a.png" });
    const { GET } = await import("@/app/api/whatsapp/qr/route");
    const corps = await (await GET(requete())).json();
    expect(corps).toEqual({ code: "2@abc", durationSec: 30 });
  });

  it("répond 502 quand GOWA est injoignable", async () => {
    getSession.mockResolvedValue({ user: { id: "u1", email: "moi@example.com" } });
    getStatus.mockRejectedValue(new Error("GOWA injoignable"));
    const { GET } = await import("@/app/api/whatsapp/status/route");
    expect((await GET(requete())).status).toBe(502);
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/api/whatsapp.test.ts`
Expected: FAIL — les routes n'existent pas.

- [ ] **Step 3 : Implémenter les routes**

`src/app/api/whatsapp/status/route.ts` :

```ts
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createGowaClient } from "@/gowa/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    const statut = await createGowaClient().getStatus();
    return NextResponse.json(statut);
  } catch {
    return NextResponse.json({ erreur: "WhatsApp injoignable" }, { status: 502 });
  }
}
```

`src/app/api/whatsapp/qr/route.ts` :

```ts
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { createGowaClient } from "@/gowa/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireSession(request.headers);
  } catch {
    return NextResponse.json({ erreur: "Non authentifié" }, { status: 401 });
  }

  try {
    const { code, durationSec } = await createGowaClient().getLoginQr();
    return NextResponse.json({ code, durationSec });
  } catch {
    return NextResponse.json({ erreur: "Impossible d'obtenir le QR code" }, { status: 502 });
  }
}
```

`imagePath` est délibérément omis : l'image est servie par GOWA, qui n'est pas exposé.

- [ ] **Step 4 : Implémenter la page**

```bash
pnpm add qrcode
pnpm add -D @types/qrcode
```

`src/app/connexion/page.tsx` :

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

type Statut = { isConnected: boolean; isLoggedIn: boolean; jid?: string };

export default function Appairage() {
  const [statut, setStatut] = useState<Statut | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const rafraichirStatut = useCallback(async () => {
    const reponse = await fetch("/api/whatsapp/status");
    if (!reponse.ok) {
      setErreur("WhatsApp est injoignable.");
      return;
    }
    setErreur(null);
    setStatut(await reponse.json());
  }, []);

  const demanderQr = useCallback(async () => {
    const reponse = await fetch("/api/whatsapp/qr");
    if (!reponse.ok) {
      setErreur("Impossible d'obtenir le QR code.");
      return;
    }
    const { code } = (await reponse.json()) as { code: string };
    setQr(await QRCode.toDataURL(code, { width: 320, margin: 1 }));
  }, []);

  useEffect(() => {
    void rafraichirStatut();
    const intervalle = setInterval(rafraichirStatut, 3000);
    return () => clearInterval(intervalle);
  }, [rafraichirStatut]);

  useEffect(() => {
    if (statut && !statut.isLoggedIn) void demanderQr();
    if (statut?.isLoggedIn) setQr(null);
  }, [statut, demanderQr]);

  return (
    <main>
      <h1>Connexion WhatsApp</h1>
      {erreur && <p role="alert">{erreur}</p>}
      {statut?.isLoggedIn ? (
        <p>Appareil appairé{statut.jid ? ` (${statut.jid})` : ""}. Rien à faire.</p>
      ) : (
        <>
          <p>Ouvre WhatsApp, puis Appareils connectés, puis scanne ce code.</p>
          {qr ? <img src={qr} alt="QR code d'appairage WhatsApp" width={320} height={320} /> : <p>Génération du code…</p>}
          <button type="button" onClick={demanderQr}>Régénérer le code</button>
        </>
      )}
    </main>
  );
}
```

- [ ] **Step 5 : Vérifier que le test passe**

Run: `pnpm test tests/api/whatsapp.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6 : Commit**

```bash
git add -A
git commit -m "feat: appairage WhatsApp par QR depuis le dashboard authentifié"
```

---

### Task 8 : Webhook d'ingestion

**Files:**
- Create: `src/ingest/signature.ts`, `src/ingest/payload.ts`, `src/ingest/handler.ts`, `src/app/api/webhook/gowa/route.ts`
- Test: `tests/ingest/signature.test.ts`, `tests/ingest/payload.test.ts`, `tests/ingest/handler.int.test.ts`

**Interfaces:**
- Consumes: `prisma` (Task 3), `getEnv()` (Task 1).
- Produces:
  - `verifierSignature(corpsBrut: string, entete: string | null, secret: string): boolean`
  - `webhookSchema` (zod) et `type WebhookMessage`
  - `ingererMessage(evenement: WebhookMessage, options: { controlGroupJid?: string }): Promise<IngestResult>`
  - `type IngestResult = { statut: "persiste" | "doublon" | "groupe_de_controle" | "ignore"; messageId?: string }`

- [ ] **Step 1 : Écrire les tests de signature et de schéma**

`tests/ingest/signature.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifierSignature } from "@/ingest/signature";

const SECRET = "secret-du-webhook";
const CORPS = JSON.stringify({ event: "message" });

function signer(corps: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(corps).digest("hex")}`;
}

describe("vérification de la signature du webhook", () => {
  it("accepte une signature valide", () => {
    expect(verifierSignature(CORPS, signer(CORPS, SECRET), SECRET)).toBe(true);
  });

  it("refuse une signature calculée avec un autre secret", () => {
    expect(verifierSignature(CORPS, signer(CORPS, "autre"), SECRET)).toBe(false);
  });

  it("refuse une signature valide pour un autre corps", () => {
    expect(verifierSignature(CORPS, signer('{"event":"autre"}', SECRET), SECRET)).toBe(false);
  });

  it("refuse un en-tête absent", () => {
    expect(verifierSignature(CORPS, null, SECRET)).toBe(false);
  });

  it("refuse un en-tête sans le préfixe sha256=", () => {
    const sansPrefixe = createHmac("sha256", SECRET).update(CORPS).digest("hex");
    expect(verifierSignature(CORPS, sansPrefixe, SECRET)).toBe(false);
  });
});
```

`tests/ingest/payload.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { webhookSchema } from "@/ingest/payload";

const evenement = {
  event: "message",
  device_id: "225xxxxx@s.whatsapp.net",
  payload: {
    id: "3EB0ABC",
    chat_id: "22500000001@s.whatsapp.net",
    from: "22500000001@s.whatsapp.net",
    from_name: "Sarah",
    body: "coucou",
    timestamp: "2026-09-17T20:04:00Z",
    is_from_me: false,
  },
};

describe("schéma du webhook GOWA", () => {
  it("accepte un message texte entrant", () => {
    const resultat = webhookSchema.safeParse(evenement);
    expect(resultat.success).toBe(true);
  });

  it("accepte un message sans body (média)", () => {
    const sansBody = { ...evenement, payload: { ...evenement.payload, body: undefined } };
    expect(webhookSchema.safeParse(sansBody).success).toBe(true);
  });

  it("accepte replied_to_id quand il est présent", () => {
    const avecReponse = { ...evenement, payload: { ...evenement.payload, replied_to_id: "3EB0PREC" } };
    const resultat = webhookSchema.parse(avecReponse);
    expect(resultat.payload.replied_to_id).toBe("3EB0PREC");
  });

  it("rejette un événement sans id de message", () => {
    const sansId = { ...evenement, payload: { ...evenement.payload, id: undefined } };
    expect(webhookSchema.safeParse(sansId).success).toBe(false);
  });
});
```

- [ ] **Step 2 : Vérifier que les tests échouent**

Run: `pnpm test tests/ingest/`
Expected: FAIL — les modules n'existent pas.

- [ ] **Step 3 : Implémenter signature et schéma**

`src/ingest/signature.ts` :

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifierSignature(
  corpsBrut: string,
  entete: string | null,
  secret: string,
): boolean {
  if (!entete || !entete.startsWith("sha256=")) return false;
  const fourni = Buffer.from(entete.slice("sha256=".length), "utf8");
  const attendu = Buffer.from(createHmac("sha256", secret).update(corpsBrut).digest("hex"), "utf8");
  if (fourni.length !== attendu.length) return false;
  return timingSafeEqual(fourni, attendu);
}
```

`src/ingest/payload.ts` :

```ts
import { z } from "zod";

export const webhookSchema = z.object({
  event: z.string(),
  device_id: z.string().optional(),
  payload: z.looseObject({
    id: z.string(),
    chat_id: z.string(),
    from: z.string(),
    from_name: z.string().optional(),
    body: z.string().optional(),
    timestamp: z.string(),
    is_from_me: z.boolean(),
    replied_to_id: z.string().optional(),
  }),
});

export type WebhookMessage = z.infer<typeof webhookSchema>;

const CLES_MEDIA = ["image", "video", "audio", "document", "sticker", "contact", "location"] as const;

export function detecterTypeMedia(payload: Record<string, unknown>): string | null {
  for (const cle of CLES_MEDIA) {
    if (payload[cle] !== undefined && payload[cle] !== null) return cle;
  }
  return null;
}
```

- [ ] **Step 4 : Écrire le test d'intégration de l'ingestion**

`tests/ingest/handler.int.test.ts` :

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { ingererMessage } from "@/ingest/handler";
import { resetDb } from "../helpers/db";

function evenement(surcharge: Record<string, unknown> = {}) {
  return {
    event: "message",
    device_id: "moi@s.whatsapp.net",
    payload: {
      id: "MSG-A",
      chat_id: "22500000001@s.whatsapp.net",
      from: "22500000001@s.whatsapp.net",
      from_name: "Sarah",
      body: "coucou",
      timestamp: "2026-09-17T20:04:00Z",
      is_from_me: false,
      ...surcharge,
    },
  };
}

describe("ingestion d'un message", () => {
  beforeEach(resetDb);

  it("crée le contact découvert en mode OFF (principe P1)", async () => {
    await ingererMessage(evenement(), {});
    const contact = await prisma.contact.findUnique({
      where: { jid: "22500000001@s.whatsapp.net" },
    });
    expect(contact?.mode).toBe("OFF");
    expect(contact?.pushName).toBe("Sarah");
  });

  it("crée le fil et persiste le message en IN / HUMAN", async () => {
    const resultat = await ingererMessage(evenement(), {});
    expect(resultat.statut).toBe("persiste");
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-A" } });
    expect(message?.direction).toBe("IN");
    expect(message?.source).toBe("HUMAN");
    expect(message?.text).toBe("coucou");
    expect(await prisma.thread.count()).toBe(1);
  });

  it("persiste un message sortant envoyé depuis le téléphone en OUT / HUMAN", async () => {
    await ingererMessage(evenement({ id: "MSG-B", is_from_me: true, from: "moi@s.whatsapp.net" }), {});
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-B" } });
    expect(message?.direction).toBe("OUT");
    expect(message?.source).toBe("HUMAN");
  });

  it("ignore un doublon sans lever d'erreur", async () => {
    await ingererMessage(evenement(), {});
    const resultat = await ingererMessage(evenement(), {});
    expect(resultat.statut).toBe("doublon");
    expect(await prisma.message.count()).toBe(1);
  });

  it("n'ingère pas les messages du groupe de contrôle", async () => {
    const resultat = await ingererMessage(
      evenement({ id: "MSG-C", chat_id: "1234-5678@g.us" }),
      { controlGroupJid: "1234-5678@g.us" },
    );
    expect(resultat.statut).toBe("groupe_de_controle");
    expect(await prisma.message.count()).toBe(0);
  });

  it("enregistre le type de média quand le message n'est pas textuel", async () => {
    await ingererMessage(
      evenement({ id: "MSG-D", body: undefined, audio: { url: "https://exemple" } }),
      {},
    );
    const message = await prisma.message.findUnique({ where: { waMessageId: "MSG-D" } });
    expect(message?.mediaType).toBe("audio");
    expect(message?.text).toBeNull();
  });

  it("met à jour lastMessageAt du fil", async () => {
    await ingererMessage(evenement(), {});
    const fil = await prisma.thread.findFirst();
    expect(fil?.lastMessageAt?.toISOString()).toBe("2026-09-17T20:04:00.000Z");
  });

  it("ne change jamais le mode d'un contact déjà activé", async () => {
    await prisma.contact.create({
      data: { jid: "22500000001@s.whatsapp.net", mode: "AUTO", thread: { create: {} } },
    });
    await ingererMessage(evenement(), {});
    const contact = await prisma.contact.findUnique({
      where: { jid: "22500000001@s.whatsapp.net" },
    });
    expect(contact?.mode).toBe("AUTO");
  });
});
```

- [ ] **Step 5 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST=postgres://wha:wha@127.0.0.1:5432/wha_test pnpm test:int`
Expected: FAIL — `@/ingest/handler` introuvable.

- [ ] **Step 6 : Implémenter l'ingestion**

`src/ingest/handler.ts` :

```ts
import { prisma } from "@/lib/prisma";
import { detecterTypeMedia, type WebhookMessage } from "./payload";

export type IngestResult = {
  statut: "persiste" | "doublon" | "groupe_de_controle" | "ignore";
  messageId?: string;
};

export async function ingererMessage(
  evenement: WebhookMessage,
  options: { controlGroupJid?: string },
): Promise<IngestResult> {
  if (evenement.event !== "message") {
    return { statut: "ignore" };
  }

  const { payload } = evenement;

  if (options.controlGroupJid && payload.chat_id === options.controlGroupJid) {
    return { statut: "groupe_de_controle" };
  }

  const existant = await prisma.message.findUnique({ where: { waMessageId: payload.id } });
  if (existant) {
    return { statut: "doublon", messageId: existant.id };
  }

  // Le contact du fil est toujours l'interlocuteur : chat_id, jamais l'expéditeur,
  // qui vaut notre propre jid quand is_from_me est vrai.
  const jidContact = payload.chat_id;

  const contact = await prisma.contact.upsert({
    where: { jid: jidContact },
    // P1 : la création se fait sans `mode`, donc en OFF. La mise à jour ne
    // touche que pushName et ne peut pas activer un contact.
    create: {
      jid: jidContact,
      pushName: payload.is_from_me ? undefined : payload.from_name,
      thread: { create: {} },
      policy: { create: {} },
    },
    update: payload.is_from_me ? {} : { pushName: payload.from_name },
    include: { thread: true },
  });

  const fil =
    contact.thread ??
    (await prisma.thread.create({ data: { contactId: contact.id } }));

  const horodatage = new Date(payload.timestamp);
  const typeMedia = detecterTypeMedia(payload as Record<string, unknown>);

  const message = await prisma.message.create({
    data: {
      threadId: fil.id,
      waMessageId: payload.id,
      direction: payload.is_from_me ? "OUT" : "IN",
      source: "HUMAN",
      text: payload.body ?? null,
      mediaType: typeMedia,
      timestamp: horodatage,
      replyToWaId: payload.replied_to_id ?? null,
    },
  });

  await prisma.thread.update({
    where: { id: fil.id },
    data: { lastMessageAt: horodatage },
  });

  return { statut: "persiste", messageId: message.id };
}
```

- [ ] **Step 7 : Implémenter la route du webhook**

`src/app/api/webhook/gowa/route.ts` :

```ts
import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { verifierSignature } from "@/ingest/signature";
import { webhookSchema } from "@/ingest/payload";
import { ingererMessage } from "@/ingest/handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const env = getEnv();
  const corpsBrut = await request.text();

  if (!verifierSignature(corpsBrut, request.headers.get("X-Hub-Signature-256"), env.GOWA_WEBHOOK_SECRET)) {
    return NextResponse.json({ erreur: "Signature invalide" }, { status: 401 });
  }

  let brut: unknown;
  try {
    brut = JSON.parse(corpsBrut);
  } catch {
    return NextResponse.json({ erreur: "Corps illisible" }, { status: 400 });
  }

  const analyse = webhookSchema.safeParse(brut);
  if (!analyse.success) {
    // Les événements non gérés (présence, accusés) sont acquittés sans traitement :
    // répondre en erreur déclencherait cinq tentatives inutiles côté GOWA.
    return NextResponse.json({ statut: "ignore" });
  }

  try {
    const resultat = await ingererMessage(analyse.data, {
      controlGroupJid: env.CONTROL_GROUP_JID,
    });
    return NextResponse.json(resultat);
  } catch (erreur) {
    console.error("Échec de l'ingestion", erreur);
    // P2 : on signale l'échec plutôt que de l'avaler. GOWA réessaiera.
    return NextResponse.json({ erreur: "Ingestion impossible" }, { status: 500 });
  }
}
```

- [ ] **Step 8 : Vérifier que tous les tests passent**

Run: `pnpm test`
Expected: PASS.

Run: `DATABASE_URL_TEST=postgres://wha:wha@127.0.0.1:5432/wha_test pnpm test:int`
Expected: PASS (8 tests d'ingestion inclus).

- [ ] **Step 9 : Commit**

```bash
git add -A
git commit -m "feat: webhook GOWA signé et persistance des messages"
```

---

### Task 9 : Déploiement Dokploy et vérification

**Files:**
- Create: `docs/deploiement.md`
- Modify: `.env.example` si une variable manque

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: une instance en ligne, et un runbook reproductible.

- [ ] **Step 1 : Générer les secrets immuables**

```bash
openssl rand -hex 32     # MASTER_KEY
openssl rand -base64 48  # BETTER_AUTH_SECRET
openssl rand -base64 24  # POSTGRES_PASSWORD
openssl rand -base64 24  # GOWA_WEBHOOK_SECRET
```

Les conserver dans un gestionnaire de mots de passe. Une rotation de `MASTER_KEY` rendra illisibles toutes les clés d'API enregistrées par la suite.

- [ ] **Step 2 : Créer le service Dokploy**

1. Créer un projet, y ajouter un service de type **Compose**.
2. Source : le dépôt Git, branche `main`, chemin du Compose `docker-compose.yml`.
3. Onglet Environment : renseigner `APP_DOMAIN`, `POSTGRES_PASSWORD`, `MASTER_KEY`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (`https://` + le domaine), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `GOWA_BASIC_AUTH`, `GOWA_WEBHOOK_SECRET`. Laisser `CONTROL_GROUP_JID` vide.
4. Onglet Domains : ajouter `APP_DOMAIN` sur le service `app`, port 3000, HTTPS avec Let's Encrypt.
5. Déployer.

- [ ] **Step 3 : Vérifier la santé**

```bash
curl -s https://$APP_DOMAIN/api/health
```

Expected: `{"status":"ok","db":"up"}`.

- [ ] **Step 4 : Vérifier l'isolement (critère 8 de la spec)**

```bash
curl -sS --max-time 5 http://$VPS_IP:3000/app/status ; echo "code=$?"
curl -sS --max-time 5 http://$VPS_IP:5432          ; echo "code=$?"
```

Expected: échec de connexion dans les deux cas. Si l'un des deux répond, un `ports:` s'est glissé dans le Compose ou un label Traefik est mal placé.

- [ ] **Step 5 : Appairer WhatsApp**

1. Ouvrir `https://$APP_DOMAIN/login`, se connecter avec `ADMIN_EMAIL`.
2. Aller sur `/connexion`, scanner le QR depuis WhatsApp (Appareils connectés).
3. Attendre que la page affiche « Appareil appairé ».

- [ ] **Step 6 : Vérifier l'ingestion de bout en bout**

Envoyer un message depuis un autre téléphone vers le numéro appairé, puis :

```bash
# Depuis Dokploy, terminal du service app
pnpm prisma studio  # ou :
docker compose exec postgres psql -U wha -d wha -c \
  'SELECT "waMessageId", direction, source, text FROM "Message" ORDER BY "createdAt" DESC LIMIT 5;'
docker compose exec postgres psql -U wha -d wha -c \
  'SELECT jid, mode FROM "Contact";'
```

Expected: le message apparaît en `IN` / `HUMAN`, et le contact est en `OFF`. Si un contact apparaît dans un autre mode, le principe P1 est violé : arrêter et corriger avant d'aller plus loin.

- [ ] **Step 7 : Vérifier la persistance au redéploiement (critère 7 de la spec)**

Relancer un déploiement depuis Dokploy, puis rouvrir `/connexion`.

Expected: la page affiche toujours « Appareil appairé », sans nouveau QR. La session reste ouverte dans le navigateur. Si un QR réapparaît, le volume `gowa-session` n'est pas monté correctement.

- [ ] **Step 8 : Vérifier la forme réelle de la durée du QR**

Dans les journaux du service `app`, relever la valeur brute de `duration` renvoyée par `/app/login`. Si elle est exprimée en nanosecondes, corriger `getLoginQr()` dans `src/gowa/client.ts` (diviser par 1e9) et adapter le test correspondant de Task 6.

- [ ] **Step 9 : Configurer les sauvegardes**

Dans Dokploy, planifier une sauvegarde quotidienne des volumes `pg-data` et `gowa-session`.

- [ ] **Step 10 : Écrire le runbook**

`docs/deploiement.md` reprend les étapes 1 à 9 de cette tâche, plus une section « En cas de problème » :

| Symptôme | Cause probable | Action |
|---|---|---|
| `/api/health` en 503 | PostgreSQL pas démarré | Vérifier le healthcheck du service `postgres` |
| QR redemandé après déploiement | volume `gowa-session` absent | Vérifier la section `volumes` du Compose |
| Webhook en 401 dans les journaux | `GOWA_WEBHOOK_SECRET` différent entre `app` et `gowa` | Les deux lisent la même variable : vérifier `.env` |
| Aucun message en base | `WHATSAPP_WEBHOOK` mal pointé | Doit valoir `http://app:3000/api/webhook/gowa` |
| Déconnexion à chaque déploiement | `BETTER_AUTH_SECRET` régénéré | Le figer dans les variables Dokploy |

- [ ] **Step 11 : Commit**

```bash
git add -A
git commit -m "docs: runbook de déploiement Dokploy"
```

---

## Ce que la phase 1 ne fait pas

Aucun message n'est envoyé, aucune IA n'est appelée, aucun contact ne peut être activé. La suite :

- **Phase 2** — règles lexicales, classifieur, Gates 0 à 3, table de décision, couche IA.
- **Phase 3** — groupe de contrôle, rédacteur et sa post-validation, planificateur d'envoi.
- **Phase 4** — onboarding, contacts, fiche contact, fournisseurs, journal.
- **Phase 5** — import d'export WhatsApp et profilage.

Chacune fera l'objet de son propre plan.
