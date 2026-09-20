# Phase 3a — Rédacteur et groupe de contrôle : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire rédiger une réponse par l'IA, la soumettre à l'utilisateur dans un groupe WhatsApp dédié, et ne l'envoyer au contact que sur son approbation explicite.

**Architecture:** Le rédacteur n'a accès qu'aux faits marqués partageables et sa sortie est validée **mécaniquement** avant tout envoi : une référence à un fait absent invalide le brouillon. Les escalades sont postées dans un groupe de contrôle et résolues par une réponse native WhatsApp, ce qui lève toute ambiguïté quand plusieurs sont ouvertes. **Aucun envoi automatique dans cette phase** : rien ne part vers un contact sans un geste de l'utilisateur.

**Tech Stack:** Node 22, pnpm 11, TypeScript strict, Prisma 7, Zod 4, Vercel AI SDK, Vitest.

**Spec:** `docs/prive/conception-harness-whatsapp.md` — hors dépôt public. En cas de contradiction avec ce plan, **la spec tranche**.

## Global Constraints

- **P1 — Activation explicite par contact.** `Contact.mode` vaut `OFF` par défaut ; aucun code de cette phase ne le change, y compris les commandes du groupe de contrôle (`/mode` sur un contact inconnu est refusé).
- **P2 — Fail-closed.** Toute anomalie mène à l'escalade, jamais à un envoi.
- **P3 — Le modèle ne peut qu'ajouter du risque.** Acquis en phase 2, à ne pas défaire.
- **P4 — Le rédacteur ne peut pas inventer de faits.** Il n'accède qu'aux faits `shareable`. Sa sortie est validée en code : `needsFact` non nul, ou un identifiant de `factsUsed` absent, invalide le brouillon et déclenche une escalade.
- **P5 — Tout est tracé.**
- **Aucun envoi vers un contact sans geste explicite de l'utilisateur.** Le seul envoi automatique autorisé est le message d'escalade vers le groupe de contrôle.
- Node `22.x`, pnpm `11.x` (épinglés via `packageManager` et `engines`).
- Prisma 7 : générateur `prisma-client`, adaptateur `PrismaPg`.
- **Zod 4 API de haut niveau** : `z.looseObject()`, `z.url()`, `z.email()`. `.loose()` et `.passthrough()` sont interdites.
- TypeScript `strict`. Aucun `any` implicite.
- Toute chaîne destinée à l'utilisateur en français, accents corrects.
- Aucun `console.*` : le journal structuré de `src/lib/log.ts` est la seule sortie.
- Sortie de test vierge — un avertissement est un défaut.
- **Lancer `npx tsc --noEmit` avant de rapporter.** Une suite verte ne prouve pas que le code compile.
- Suite d'intégration : `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int` (le port 5434 n'est pas une faute).

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `src/lib/prisma.ts` | Instance Prisma, désormais paresseuse |
| `tests/garde-reseau.ts` | Interdit tout appel sortant hors localhost pendant les tests |
| `src/scripts/seed-persona.ts` | Charge le style et les faits depuis un fichier local |
| `src/redacteur/contexte.ts` | Assemble le contexte transmis au modèle |
| `src/redacteur/redacteur.ts` | Appelle le modèle, renvoie le brouillon brut |
| `src/redacteur/validation.ts` | Validation mécanique P4 du brouillon |
| `src/escalade/format.ts` | Mise en forme du message d'escalade |
| `src/escalade/service.ts` | Création, résolution et expiration des escalades |
| `src/controle/commandes.ts` | Analyse d'une entrée du groupe de contrôle |
| `src/controle/routeur.ts` | Exécution d'une commande analysée |

---

### Task 1 : Instance Prisma paresseuse

**Files:**
- Modify: `src/lib/prisma.ts`
- Modify: `src/ia/appel.ts` (retirer l'import dynamique devenu inutile)
- Test: `tests/lib/prisma.test.ts`

**Interfaces:**
- Consumes: `getEnv()` de `@/config/env`.
- Produces: `prisma` — même type `PrismaClient`, mêmes usages, mais l'instanciation et l'appel à `getEnv()` n'ont plus lieu au chargement du module.

**Pourquoi :** l'instanciation au niveau module a déjà forcé deux contournements — des variables factices dans le Dockerfile en phase 1, et un `await import()` dans `src/ia/appel.ts` en phase 2. La phase 3 ajoute un planificateur et des tests de rédacteur qui voudront importer ces modules sans base. La troisième occurrence est déjà programmée ; on paie la dette maintenant.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/lib/prisma.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("instance Prisma paresseuse", () => {
  const ancien = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...ancien };
  });

  it("s'importe sans lever quand aucune variable d'environnement n'est définie", async () => {
    for (const cle of ["DATABASE_URL", "MASTER_KEY", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "ADMIN_EMAIL", "ADMIN_PASSWORD", "GOWA_BASE_URL", "GOWA_BASIC_AUTH", "GOWA_WEBHOOK_SECRET"]) {
      delete process.env[cle];
    }
    await expect(import("@/lib/prisma")).resolves.toBeDefined();
  });

  it("ne construit le client qu'au premier accès à une propriété", async () => {
    delete process.env.DATABASE_URL;
    const { prisma } = await import("@/lib/prisma");
    // L'import seul n'a rien construit : c'est la lecture d'une propriété qui
    // déclenche getEnv(), et donc l'erreur de configuration attendue.
    expect(() => prisma.contact).toThrow(/Configuration d'environnement invalide/);
  });

  it("réutilise la même instance entre deux accès", async () => {
    process.env.DATABASE_URL = "postgres://wha:test@localhost:5432/test";
    process.env.MASTER_KEY = "a".repeat(64);
    process.env.BETTER_AUTH_SECRET = "b".repeat(32);
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.ADMIN_EMAIL = "test@example.com";
    process.env.ADMIN_PASSWORD = "motdepassetest12";
    process.env.GOWA_BASE_URL = "http://localhost:3001";
    process.env.GOWA_BASIC_AUTH = "admin:test";
    process.env.GOWA_WEBHOOK_SECRET = "c".repeat(16);
    const { prisma } = await import("@/lib/prisma");
    expect(prisma.contact).toBe(prisma.contact);
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/lib/prisma.test.ts`
Expected: FAIL — l'import lève immédiatement, faute de `DATABASE_URL`.

- [ ] **Step 3 : Implémenter**

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

function instance(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = creerClient();
  }
  return globalForPrisma.prisma;
}

// Instanciation paresseuse. Un `const prisma = creerClient()` au niveau module
// exécutait getEnv() à l'import, ce qui a imposé deux contournements : des
// variables factices dans le Dockerfile pour que `next build` passe, et un
// `await import()` dans la couche IA pour que ses tests unitaires tournent sans
// base. Le proxy préserve exactement l'API — `import { prisma }` puis
// `prisma.contact...` — mais ne construit rien tant qu'aucune propriété n'est lue.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_cible, propriete) {
    // Ni `recepteur` passé à Reflect.get, ni fonction renvoyée telle quelle :
    // dans les deux cas `this` vaudrait le proxy à l'intérieur du client
    // Prisma, dont les accesseurs lisent des champs privés (`#`) qui lèvent
    // sur tout autre objet que l'instance réelle.
    const reel = instance();
    const valeur = Reflect.get(reel, propriete);
    return typeof valeur === "function" ? valeur.bind(reel) : valeur;
  },
  has(_cible, propriete) {
    return Reflect.has(instance(), propriete);
  },
});
```

- [ ] **Step 4 : Retirer le contournement devenu inutile**

Dans `src/ia/appel.ts`, remplacer l'import dynamique par un import statique et supprimer le commentaire qui l'expliquait :

```ts
// avant
const entrees = params.entrees ?? (await (await import("./registre")).resoudreRoute(params.role, { contactId: params.contactId }));
// après
const entrees = params.entrees ?? (await resoudreRoute(params.role, { contactId: params.contactId }));
```

avec, en tête de fichier, `import { resoudreRoute, type EntreeRoute, type RoleIA } from "./registre";`.

- [ ] **Step 5 : Vérifier les deux suites et le typecheck**

Run: `pnpm test`, puis `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`, puis `npx tsc --noEmit`
Expected: tout vert, sortie vierge.

- [ ] **Step 6 : Commit**

```bash
git add -A
git commit -m "fix: instancier Prisma paresseusement et retirer le contournement de la couche IA"
```

---

### Task 2 : Garde-fou réseau et liste de truncate dérivée

**Files:**
- Create: `tests/garde-reseau.ts`
- Modify: `vitest.config.ts`, `vitest.int.config.ts`, `tests/helpers/db.ts`
- Test: `tests/garde-reseau.test.ts`, `tests/helpers/db.int.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: un `setupFiles` qui remplace `globalThis.fetch` par une version refusant toute requête dont l'hôte n'est pas local, `hotesAutorises` exporté pour le test, et un `resetDb()` dont la liste de tables est dérivée de `information_schema` au lieu d'être maintenue à la main.

**Pourquoi :** deux défauts de la même famille, corrigés ensemble parce qu'ils se couvrent mutuellement. La liste de tables de `resetDb()` a été trouvée incomplète **trois fois** ; l'une de ces omissions a laissé des tests d'intégration appeler la **vraie API d'Anthropic** — une réponse « invalid x-api-key » a été observée. Une liste dérivée ne peut plus rien oublier, et le garde-fou réseau attrape ce que l'hygiène des données laisserait encore passer. La phase 3 ajoute `PersonaFact` et `PersonaProfile` au chemin critique : sans cette tâche, la quatrième omission est déjà programmée.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/garde-reseau.test.ts` :

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installerGardeReseau, hotesAutorises } from "./garde-reseau";

describe("garde-fou réseau", () => {
  const fetchOriginal = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = fetchOriginal;
  });

  it("laisse passer localhost et 127.0.0.1", async () => {
    const espion = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = espion as unknown as typeof fetch;
    installerGardeReseau();
    await globalThis.fetch("http://localhost:3001/app/status");
    await globalThis.fetch("http://127.0.0.1:5434/");
    expect(espion).toHaveBeenCalledTimes(2);
  });

  it("refuse une requête vers un hôte externe, en nommant l'hôte", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    installerGardeReseau();
    await expect(globalThis.fetch("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      /api\.anthropic\.com/,
    );
  });

  it("refuse aussi quand l'URL est passée en objet Request", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    installerGardeReseau();
    await expect(globalThis.fetch(new Request("https://openrouter.ai/api/v1"))).rejects.toThrow(
      /openrouter\.ai/,
    );
  });

  it("laisse passer les hôtes de service internes du Compose", async () => {
    const espion = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = espion as unknown as typeof fetch;
    installerGardeReseau();
    await globalThis.fetch("http://gowa:3000/app/status");
    expect(espion).toHaveBeenCalledTimes(1);
  });

  it("expose la liste des hôtes autorisés, pour que le refus soit auditable", () => {
    expect(hotesAutorises).toContain("localhost");
    expect(hotesAutorises).toContain("127.0.0.1");
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/garde-reseau.test.ts`
Expected: FAIL — `./garde-reseau` introuvable.

- [ ] **Step 3 : Implémenter**

`tests/garde-reseau.ts` :

```ts
// Aucun test ne doit joindre un service externe. Une omission dans la remise à
// zéro de la base a déjà laissé des tests d'intégration appeler la vraie API
// d'un fournisseur d'IA — le symptôme observé était une réponse « invalid
// x-api-key ». L'hygiène des données se corrige à chaque nouvelle table ; ce
// garde-fou, lui, n'a rien à tenir à jour.
export const hotesAutorises: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  // Noms de service du Compose, utilisés par les simulacres de client GOWA.
  "gowa",
  "postgres",
  "app",
];

export class AppelReseauInterditError extends Error {
  constructor(hote: string, url: string) {
    super(
      `Appel réseau interdit en test vers ${hote} (${url}). ` +
        `Injecte un simulacre plutôt que de joindre un service externe.`,
    );
    this.name = "AppelReseauInterditError";
  }
}

function hoteDe(entree: RequestInfo | URL): string {
  const brut = entree instanceof Request ? entree.url : String(entree);
  try {
    return new URL(brut).hostname;
  } catch {
    // Une URL relative ne quitte pas la machine : on la laisse passer.
    return "localhost";
  }
}

export function installerGardeReseau(): void {
  const reel = globalThis.fetch;
  globalThis.fetch = ((entree: RequestInfo | URL, init?: RequestInit) => {
    const hote = hoteDe(entree);
    if (!hotesAutorises.includes(hote)) {
      const url = entree instanceof Request ? entree.url : String(entree);
      return Promise.reject(new AppelReseauInterditError(hote, url));
    }
    return reel(entree, init);
  }) as typeof fetch;
}

installerGardeReseau();
```

- [ ] **Step 4 : Brancher le garde-fou sur les deux configurations**

Dans `vitest.config.ts` et `vitest.int.config.ts`, ajouter `setupFiles: ["./tests/garde-reseau.ts"]` (ou l'ajouter à la liste existante).

Attention : `tests/garde-reseau.test.ts` remplace `globalThis.fetch` par un espion **avant** d'appeler `installerGardeReseau()`, donc il teste bien l'enveloppe et non le `fetch` réel.

- [ ] **Step 5 : Écrire le test de la liste dérivée**

`tests/helpers/db.int.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, tablesATronquer } from "./db";

describe("remise à zéro de la base", () => {
  it("couvre toutes les tables métier, y compris celles ajoutées après coup", async () => {
    const tables = await tablesATronquer();
    for (const attendue of ["Contact", "Decision", "Escalation", "PersonaFact", "PersonaProfile", "SystemState"]) {
      expect(tables).toContain(attendue);
    }
  });

  it("n'inclut pas la table de migrations de Prisma", async () => {
    expect(await tablesATronquer()).not.toContain("_prisma_migrations");
  });

  it("vide effectivement une table que personne n'a pensé à lister", async () => {
    await prisma.personaFact.create({ data: { key: "temoin", value: "x", shareable: true } });
    await resetDb();
    expect(await prisma.personaFact.count()).toBe(0);
  });
});
```

- [ ] **Step 6 : Dériver la liste de tables**

Remplacer le contenu de `tests/helpers/db.ts` :

```ts
import { prisma } from "@/lib/prisma";

// La liste tenue à la main a été trouvée incomplète trois fois, et l'une de ces
// omissions a laissé des tests d'intégration atteindre un vrai fournisseur d'IA.
// Une liste dérivée du schéma ne peut plus rien oublier : toute table ajoutée
// par une migration future est nettoyée sans que personne y pense.
let cache: string[] | null = null;

export async function tablesATronquer(): Promise<string[]> {
  if (cache) return cache;
  const lignes = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT LIKE '\\_prisma%'`,
  );
  cache = lignes.map((l) => l.table_name);
  return cache;
}

export async function resetDb(): Promise<void> {
  const tables = await tablesATronquer();
  if (tables.length === 0) return;
  const liste = tables.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${liste} RESTART IDENTITY CASCADE`);
}
```

Attention : `resetDb()` tronque désormais **aussi les tables Better Auth**. Si un test d'intégration dépend du compte administrateur amorcé, il doit le recréer lui-même — le signaler dans le rapport si un test casse pour cette raison.

- [ ] **Step 7 : Vérifier que rien ne casse**

Run: `pnpm test`, puis `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`, puis `npx tsc --noEmit`
Expected: tout vert. **Si un test échoue avec `AppelReseauInterditError`, c'est une découverte, pas une régression** : ce test joignait un service externe. Le signaler dans le rapport avec le nom du test et l'hôte visé, et injecter un simulacre plutôt que d'élargir la liste d'hôtes autorisés.

- [ ] **Step 8 : Commit**

```bash
git add -A
git commit -m "test: interdire les appels réseau externes et dériver la liste de truncate"
```

---

### Task 3 : Amorçage de la persona

**Files:**
- Create: `src/scripts/seed-persona.ts`, `persona.exemple.json`
- Modify: `package.json` (script `persona`), `.gitignore` (`persona.json`)
- Test: `tests/persona/seed-persona.int.test.ts`

**Interfaces:**
- Consumes: `prisma`, `log`.
- Produces: `chargerPersona(donnees: DonneesPersona): Promise<{ faits: number; limites: number }>` et le schéma zod `personaSchema`, avec `type DonneesPersona = z.infer<typeof personaSchema>`.

**Pourquoi :** le rédacteur de la tâche suivante ne peut citer que des faits marqués partageables, et la spec place le questionnaire d'onboarding en phase 4. Sans moyen de renseigner la fiche, le rédacteur n'a rien à dire de l'utilisateur et le principe P4 ne peut pas être exercé. Ce script est le minimum utile, pas l'interface finale.

- [ ] **Step 1 : Écrire le fichier d'exemple**

`persona.exemple.json` — versionné, sert de gabarit. `persona.json`, qui contiendra les vraies données, est ignoré par git.

```json
{
  "styleGuide": {
    "longueur": "court",
    "emoji": "parfois",
    "tutoiement": true,
    "langue": "fr",
    "registre": "familier",
    "traits": ["taquin", "direct", "pas de superlatifs"]
  },
  "hardLimits": [
    "Ne jamais promettre une date ou un horaire",
    "Ne jamais parler d'argent",
    "Ne jamais évoquer une autre personne par son nom"
  ],
  "faits": [
    { "key": "prenom", "value": "Ibrahim", "shareable": true },
    { "key": "ville", "value": "Abidjan", "shareable": true },
    { "key": "metier", "value": "développeur", "shareable": true },
    { "key": "adresse_exacte", "value": "…", "shareable": false }
  ]
}
```

- [ ] **Step 2 : Écrire le test qui échoue**

`tests/persona/seed-persona.int.test.ts` :

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { chargerPersona, personaSchema } from "@/scripts/seed-persona";
import { resetDb } from "../helpers/db";

const donnees = {
  styleGuide: { longueur: "court", tutoiement: true },
  hardLimits: ["Ne jamais promettre une date"],
  faits: [
    { key: "prenom", value: "Ibrahim", shareable: true },
    { key: "adresse", value: "secrète", shareable: false },
  ],
};

describe("amorçage de la persona", () => {
  beforeEach(resetDb);

  it("crée le profil unique et ses faits", async () => {
    const resume = await chargerPersona(personaSchema.parse(donnees));
    expect(resume.faits).toBe(2);
    expect(resume.limites).toBe(1);
    const profil = await prisma.personaProfile.findUnique({ where: { id: "self" } });
    expect(profil?.hardLimits).toEqual(["Ne jamais promettre une date"]);
  });

  it("préserve le drapeau shareable, qui décide de ce que le rédacteur peut citer", async () => {
    await chargerPersona(personaSchema.parse(donnees));
    const partageables = await prisma.personaFact.findMany({ where: { shareable: true } });
    expect(partageables.map((f) => f.key)).toEqual(["prenom"]);
  });

  it("est idempotent : relancer met à jour sans dupliquer", async () => {
    await chargerPersona(personaSchema.parse(donnees));
    await chargerPersona(personaSchema.parse({
      ...donnees,
      faits: [{ key: "prenom", value: "Ibra", shareable: true }],
    }));
    const faits = await prisma.personaFact.findMany();
    expect(faits).toHaveLength(2);
    expect(faits.find((f) => f.key === "prenom")?.value).toBe("Ibra");
  });

  it("refuse un fait sans clé, avec un message en français", () => {
    expect(() => personaSchema.parse({ ...donnees, faits: [{ value: "x", shareable: true }] }))
      .toThrow(/clé/i);
  });
});
```

- [ ] **Step 3 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: FAIL — `@/scripts/seed-persona` introuvable.

- [ ] **Step 4 : Implémenter**

`src/scripts/seed-persona.ts` :

```ts
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

export const personaSchema = z.object({
  styleGuide: z.record(z.string(), z.unknown()),
  hardLimits: z.array(z.string()),
  faits: z.array(
    z.object({
      key: z.string().min(1, "chaque fait doit porter une clé non vide"),
      value: z.string().min(1, "chaque fait doit porter une valeur non vide"),
      shareable: z.boolean(),
    }),
  ),
});

export type DonneesPersona = z.infer<typeof personaSchema>;

export async function chargerPersona(donnees: DonneesPersona): Promise<{ faits: number; limites: number }> {
  await prisma.personaProfile.upsert({
    where: { id: "self" },
    create: { id: "self", styleGuide: donnees.styleGuide, hardLimits: donnees.hardLimits },
    update: { styleGuide: donnees.styleGuide, hardLimits: donnees.hardLimits },
  });

  for (const fait of donnees.faits) {
    await prisma.personaFact.upsert({
      where: { key: fait.key },
      create: { key: fait.key, value: fait.value, shareable: fait.shareable },
      update: { value: fait.value, shareable: fait.shareable },
    });
  }

  return { faits: donnees.faits.length, limites: donnees.hardLimits.length };
}

if (process.argv[1]?.endsWith("seed-persona.ts")) {
  const chemin = process.argv[2] ?? "persona.json";
  readFile(chemin, "utf8")
    .then((brut) => chargerPersona(personaSchema.parse(JSON.parse(brut))))
    .then((resume) => {
      log.info("Persona chargée", { faits: resume.faits, limites: resume.limites, chemin });
      process.exit(0);
    })
    .catch((erreur) => {
      log.error("Chargement de la persona impossible", {
        chemin,
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
      process.exit(1);
    });
}
```

Ajouter dans `package.json` : `"persona": "tsx src/scripts/seed-persona.ts"`.
Ajouter `persona.json` à `.gitignore` — il contient des informations personnelles.

- [ ] **Step 5 : Vérifier**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`, puis `pnpm test`, puis `npx tsc --noEmit`
Expected: tout vert.

- [ ] **Step 6 : Commit**

```bash
git add -A
git commit -m "feat: amorçage de la persona depuis un fichier local"
```

---

### Task 4 : Contexte du rédacteur

**Files:**
- Create: `src/redacteur/contexte.ts`
- Test: `tests/redacteur/contexte.int.test.ts`

**Interfaces:**
- Consumes: `prisma`.
- Produces:
  - `type FaitPartageable = { id: string; key: string; value: string }`
  - `type ContexteRedaction = { styleGuide: Record<string, unknown>; hardLimits: string[]; faits: FaitPartageable[]; resumeFil: string; derniersMessages: { direction: "IN" | "OUT"; texte: string }[]; stylePolitique: { longueur: string; emoji: string; formalite: string; langue: string } }`
  - `function assemblerContexte(contactId: string): Promise<ContexteRedaction>`

**Le point clé (P4) :** cette fonction est le seul endroit où les faits sont sélectionnés. Elle ne renvoie **que** les faits `shareable`. Un fait non partageable n'atteint jamais le modèle — ce n'est pas une consigne de prompt, c'est une requête filtrée.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/redacteur/contexte.int.test.ts` :

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { assemblerContexte } from "@/redacteur/contexte";
import { resetDb } from "../helpers/db";

async function preparer() {
  await prisma.personaProfile.create({
    data: { id: "self", styleGuide: { longueur: "court" }, hardLimits: ["Ne jamais promettre une date"] },
  });
  await prisma.personaFact.createMany({
    data: [
      { key: "prenom", value: "Ibrahim", shareable: true },
      { key: "ville", value: "Abidjan", shareable: true },
      { key: "adresse", value: "SECRET", shareable: false },
    ],
  });
  const contact = await prisma.contact.create({
    data: { jid: "225@s.whatsapp.net", thread: { create: { rollingSummary: "on se taquine" } }, policy: { create: {} } },
    include: { thread: true },
  });
  for (let i = 0; i < 25; i++) {
    await prisma.message.create({
      data: {
        threadId: contact.thread!.id,
        waMessageId: `M-${i}`,
        direction: i % 2 === 0 ? "IN" : "OUT",
        source: "HUMAN",
        text: `message ${i}`,
        timestamp: new Date(Date.now() - (25 - i) * 60_000),
      },
    });
  }
  return contact;
}

describe("contexte du rédacteur", () => {
  beforeEach(resetDb);

  it("ne transmet que les faits partageables (P4)", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.faits.map((f) => f.key).sort()).toEqual(["prenom", "ville"]);
    expect(JSON.stringify(contexte)).not.toContain("SECRET");
  });

  it("donne à chaque fait un identifiant, pour que la validation puisse le retrouver", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    for (const fait of contexte.faits) {
      expect(fait.id).toBeTruthy();
    }
  });

  it("joint les limites dures et le résumé du fil", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.hardLimits).toEqual(["Ne jamais promettre une date"]);
    expect(contexte.resumeFil).toBe("on se taquine");
  });

  it("borne l'historique aux 20 derniers messages, du plus ancien au plus récent", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.derniersMessages).toHaveLength(20);
    expect(contexte.derniersMessages[0].texte).toBe("message 5");
    expect(contexte.derniersMessages[19].texte).toBe("message 24");
  });

  it("reprend les paramètres de style du contact", async () => {
    const contact = await preparer();
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.stylePolitique.langue).toBe("fr");
  });

  it("fonctionne sur une persona vide sans lever", async () => {
    const contact = await prisma.contact.create({
      data: { jid: "226@s.whatsapp.net", thread: { create: {} }, policy: { create: {} } },
    });
    const contexte = await assemblerContexte(contact.id);
    expect(contexte.faits).toEqual([]);
    expect(contexte.hardLimits).toEqual([]);
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter**

`src/redacteur/contexte.ts` :

```ts
import { prisma } from "@/lib/prisma";

export type FaitPartageable = { id: string; key: string; value: string };

export type ContexteRedaction = {
  styleGuide: Record<string, unknown>;
  hardLimits: string[];
  faits: FaitPartageable[];
  resumeFil: string;
  derniersMessages: { direction: "IN" | "OUT"; texte: string }[];
  stylePolitique: { longueur: string; emoji: string; formalite: string; langue: string };
};

const NOMBRE_DE_MESSAGES = 20;

export async function assemblerContexte(contactId: string): Promise<ContexteRedaction> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    include: { policy: true, thread: true },
  });
  if (!contact) throw new Error(`Contact ${contactId} introuvable`);

  const profil = await prisma.personaProfile.findUnique({ where: { id: "self" } });

  // P4 : le filtre est ici, dans la requête. Un fait non partageable n'atteint
  // jamais le modèle — ce n'est pas une consigne de prompt qu'il pourrait
  // ignorer, c'est une donnée qui ne lui est pas transmise.
  const faits = await prisma.personaFact.findMany({
    where: { shareable: true },
    select: { id: true, key: true, value: true },
    orderBy: { key: "asc" },
  });

  const messages = contact.thread
    ? await prisma.message.findMany({
        where: { threadId: contact.thread.id },
        orderBy: { timestamp: "desc" },
        take: NOMBRE_DE_MESSAGES,
        select: { direction: true, text: true },
      })
    : [];

  return {
    styleGuide: (profil?.styleGuide as Record<string, unknown>) ?? {},
    hardLimits: profil?.hardLimits ?? [],
    faits,
    resumeFil: contact.thread?.rollingSummary ?? "",
    derniersMessages: messages
      .reverse()
      .map((m) => ({ direction: m.direction, texte: m.text ?? "" })),
    stylePolitique: {
      longueur: contact.policy?.styleLength ?? "moyen",
      emoji: contact.policy?.styleEmoji ?? "parfois",
      formalite: contact.policy?.styleFormality ?? "tutoiement",
      langue: contact.policy?.styleLanguage ?? "fr",
    },
  };
}
```

- [ ] **Step 4 : Vérifier**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: PASS (6 tests).

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "feat: assemblage du contexte de rédaction, faits partageables seuls"
```

---

### Task 5 : Rédacteur et validation P4

**Files:**
- Create: `src/redacteur/redacteur.ts`, `src/redacteur/validation.ts`
- Test: `tests/redacteur/validation.test.ts`, `tests/redacteur/redacteur.test.ts`

**Interfaces:**
- Consumes: `appelerStructure` de `@/ia/appel`, `ContexteRedaction` et `FaitPartageable` de `@/redacteur/contexte`.
- Produces:
  - `type BrouillonBrut = { reply: string; factsUsed: string[]; needsFact: string | null }`
  - `type ResultatValidation = { valide: true; texte: string } | { valide: false; motif: string; regle: string }`
  - `function validerBrouillon(brouillon: BrouillonBrut, contexte: ContexteRedaction): ResultatValidation`
  - `type ResultatRedaction = { brouillon: string | null; motifRefus: string | null; regleRefus: string | null; fournisseur: string | null; latencyMs: number | null; costUsd: number | null }`
  - `function rediger(params: { contexte: ContexteRedaction; tourDeParole: string; contactId?: string; appeler?: typeof appelerStructure }): Promise<ResultatRedaction>`

**Le point clé (P4) :** la validation est du **code**, pas une consigne. Quatre contrôles mécaniques, chacun capable d'invalider le brouillon. Un rédacteur qui invente un fait ne produit pas un message envoyable.

- [ ] **Step 1 : Écrire le test de validation qui échoue**

`tests/redacteur/validation.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { validerBrouillon } from "@/redacteur/validation";
import type { ContexteRedaction } from "@/redacteur/contexte";

function contexte(surcharge: Partial<ContexteRedaction> = {}): ContexteRedaction {
  return {
    styleGuide: {},
    hardLimits: ["Ne jamais promettre une date"],
    faits: [
      { id: "f1", key: "prenom", value: "Ibrahim" },
      { id: "f2", key: "ville", value: "Abidjan" },
    ],
    resumeFil: "",
    derniersMessages: [],
    stylePolitique: { longueur: "court", emoji: "parfois", formalite: "tutoiement", langue: "fr" },
    ...surcharge,
  };
}

describe("validation du brouillon", () => {
  it("accepte un brouillon n'utilisant que des faits connus", () => {
    const r = validerBrouillon({ reply: "Salut, je suis à Abidjan", factsUsed: ["f2"], needsFact: null }, contexte());
    expect(r.valide).toBe(true);
  });

  it("refuse quand le modèle déclare avoir besoin d'un fait absent", () => {
    const r = validerBrouillon({ reply: "", factsUsed: [], needsFact: "Tu travailles samedi ?" }, contexte());
    expect(r.valide).toBe(false);
    if (!r.valide) {
      expect(r.regle).toBe("p4.fait-manquant");
      expect(r.motif).toContain("Tu travailles samedi ?");
    }
  });

  it("refuse quand un identifiant de fait n'existe pas (P4)", () => {
    const r = validerBrouillon({ reply: "J'ai 34 ans", factsUsed: ["f9"], needsFact: null }, contexte());
    expect(r.valide).toBe(false);
    if (!r.valide) expect(r.regle).toBe("p4.fait-inconnu");
  });

  it("refuse un brouillon vide", () => {
    const r = validerBrouillon({ reply: "   ", factsUsed: [], needsFact: null }, contexte());
    expect(r.valide).toBe(false);
    if (!r.valide) expect(r.regle).toBe("p4.brouillon-vide");
  });

  it("refuse un brouillon dépassant la longueur du style demandé", () => {
    const long = "mot ".repeat(200);
    const r = validerBrouillon({ reply: long, factsUsed: [], needsFact: null }, contexte());
    expect(r.valide).toBe(false);
    if (!r.valide) expect(r.regle).toBe("p4.longueur");
  });

  it("refuse un brouillon heurtant une limite dure", () => {
    const r = validerBrouillon(
      { reply: "Promis, on se voit samedi", factsUsed: [], needsFact: null },
      contexte({ hardLimits: ["samedi"] }),
    );
    expect(r.valide).toBe(false);
    if (!r.valide) expect(r.regle).toBe("p4.limite-dure");
  });

  it("renvoie le texte nettoyé quand tout est correct", () => {
    const r = validerBrouillon({ reply: "  Salut  ", factsUsed: [], needsFact: null }, contexte());
    expect(r.valide && r.texte).toBe("Salut");
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/redacteur/validation.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter la validation**

`src/redacteur/validation.ts` :

```ts
import type { ContexteRedaction } from "./contexte";

export type BrouillonBrut = {
  reply: string;
  factsUsed: string[];
  needsFact: string | null;
};

export type ResultatValidation =
  | { valide: true; texte: string }
  | { valide: false; motif: string; regle: string };

const LONGUEUR_MAX: Record<string, number> = {
  court: 240,
  moyen: 500,
  long: 900,
};

function normaliser(texte: string): string {
  return texte.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// P4 en code, pas en consigne. Un modèle peut ignorer une instruction de prompt ;
// il ne peut pas passer à travers ces quatre contrôles. Chacun invalide le
// brouillon, ce qui provoque une escalade : le système demande plutôt qu'il
// invente.
export function validerBrouillon(
  brouillon: BrouillonBrut,
  contexte: ContexteRedaction,
): ResultatValidation {
  if (brouillon.needsFact !== null && brouillon.needsFact.trim() !== "") {
    return {
      valide: false,
      regle: "p4.fait-manquant",
      motif: `Le rédacteur a besoin d'une information que tu n'as pas renseignée : ${brouillon.needsFact}`,
    };
  }

  const connus = new Set(contexte.faits.map((f) => f.id));
  const inconnu = brouillon.factsUsed.find((id) => !connus.has(id));
  if (inconnu !== undefined) {
    return {
      valide: false,
      regle: "p4.fait-inconnu",
      motif: `Le rédacteur s'est appuyé sur un fait qui n'existe pas dans ta fiche (${inconnu}).`,
    };
  }

  const texte = brouillon.reply.trim();
  if (texte === "") {
    return { valide: false, regle: "p4.brouillon-vide", motif: "Le rédacteur n'a rien produit." };
  }

  const maximum = LONGUEUR_MAX[contexte.stylePolitique.longueur] ?? LONGUEUR_MAX.moyen;
  if (texte.length > maximum) {
    return {
      valide: false,
      regle: "p4.longueur",
      motif: `Le brouillon fait ${texte.length} caractères, au-delà des ${maximum} du style demandé.`,
    };
  }

  const normalise = normaliser(texte);
  const limite = contexte.hardLimits.find((l) => l.trim() !== "" && normalise.includes(normaliser(l)));
  if (limite !== undefined) {
    return {
      valide: false,
      regle: "p4.limite-dure",
      motif: `Le brouillon heurte une de tes limites : « ${limite} ».`,
    };
  }

  return { valide: true, texte };
}
```

- [ ] **Step 4 : Écrire le test du rédacteur qui échoue**

`tests/redacteur/redacteur.test.ts` :

```ts
import { describe, it, expect, vi } from "vitest";
import { rediger } from "@/redacteur/redacteur";
import { AucunFournisseurError } from "@/ia/appel";
import type { ContexteRedaction } from "@/redacteur/contexte";

vi.mock("@/lib/log", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/log")>();
  return { ...original, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), enfant: () => original.log } };
});

const contexte: ContexteRedaction = {
  styleGuide: { registre: "familier" },
  hardLimits: [],
  faits: [{ id: "f1", key: "ville", value: "Abidjan" }],
  resumeFil: "",
  derniersMessages: [{ direction: "IN", texte: "tu fais quoi ?" }],
  stylePolitique: { longueur: "court", emoji: "parfois", formalite: "tutoiement", langue: "fr" },
};

function reponse(valeur: unknown) {
  return { valeur, fournisseur: "test", model: "m", latencyMs: 12, costUsd: 0.0001 };
}

describe("rédacteur", () => {
  it("renvoie le brouillon validé et les métadonnées du fournisseur", async () => {
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "Rien de spécial", factsUsed: [], needsFact: null }));
    const r = await rediger({ contexte, tourDeParole: "tu fais quoi ?", appeler: appeler as never });
    expect(r.brouillon).toBe("Rien de spécial");
    expect(r.fournisseur).toBe("test");
    expect(r.costUsd).toBe(0.0001);
    expect(r.motifRefus).toBeNull();
  });

  it("refuse le brouillon quand le modèle invente un fait (P4)", async () => {
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "J'ai 34 ans", factsUsed: ["inconnu"], needsFact: null }));
    const r = await rediger({ contexte, tourDeParole: "tu as quel âge ?", appeler: appeler as never });
    expect(r.brouillon).toBeNull();
    expect(r.regleRefus).toBe("p4.fait-inconnu");
  });

  it("refuse et remonte la question quand le modèle déclare un fait manquant", async () => {
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "", factsUsed: [], needsFact: "Tu bosses samedi ?" }));
    const r = await rediger({ contexte, tourDeParole: "tu bosses samedi ?", appeler: appeler as never });
    expect(r.brouillon).toBeNull();
    expect(r.motifRefus).toContain("Tu bosses samedi ?");
  });

  it("ne lève jamais quand aucun fournisseur ne répond (P2)", async () => {
    const appeler = vi.fn().mockRejectedValue(new AucunFournisseurError("compose", 4));
    const r = await rediger({ contexte, tourDeParole: "x", appeler: appeler as never });
    expect(r.brouillon).toBeNull();
    expect(r.regleRefus).toBe("redacteur.indisponible");
    expect(r.fournisseur).toBeNull();
  });

  it("ne lève pas non plus sur une exception inattendue", async () => {
    const appeler = vi.fn().mockRejectedValue(new TypeError("cassé"));
    await expect(rediger({ contexte, tourDeParole: "x", appeler: appeler as never })).resolves.toMatchObject({
      brouillon: null,
      regleRefus: "redacteur.indisponible",
    });
  });

  it("ne transmet jamais un fait non partageable : le contexte reçu fait foi", async () => {
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "ok", factsUsed: [], needsFact: null }));
    await rediger({ contexte, tourDeParole: "x", appeler: appeler as never });
    const invite = appeler.mock.calls[0][0].invite as string;
    const systeme = appeler.mock.calls[0][0].systeme as string;
    expect(`${invite}${systeme}`).toContain("Abidjan");
    expect(`${invite}${systeme}`).not.toContain("SECRET");
  });
});
```

- [ ] **Step 5 : Implémenter le rédacteur**

`src/redacteur/redacteur.ts` :

```ts
import { z } from "zod";
import { appelerStructure } from "@/ia/appel";
import { log } from "@/lib/log";
import type { ContexteRedaction } from "./contexte";
import { validerBrouillon, type BrouillonBrut } from "./validation";

const sortieSchema = z.object({
  reply: z.string(),
  factsUsed: z.array(z.string()),
  needsFact: z.string().nullable(),
});

export type ResultatRedaction = {
  brouillon: string | null;
  motifRefus: string | null;
  regleRefus: string | null;
  fournisseur: string | null;
  latencyMs: number | null;
  costUsd: number | null;
};

function construireSysteme(contexte: ContexteRedaction): string {
  const faits = contexte.faits.length
    ? contexte.faits.map((f) => `- [${f.id}] ${f.key} : ${f.value}`).join("\n")
    : "- (aucun fait renseigné)";
  const limites = contexte.hardLimits.length
    ? contexte.hardLimits.map((l) => `- ${l}`).join("\n")
    : "- (aucune)";

  return `Tu écris à la place d'un utilisateur francophone dans une conversation WhatsApp privée.
Tu produis UNE réponse courte, dans son style, jamais un commentaire sur la conversation.

Style demandé : longueur ${contexte.stylePolitique.longueur}, emoji ${contexte.stylePolitique.emoji}, ${contexte.stylePolitique.formalite}, langue ${contexte.stylePolitique.langue}.
Préférences : ${JSON.stringify(contexte.styleGuide)}

Faits que tu peux citer, et EUX SEULS :
${faits}

Limites à ne jamais franchir :
${limites}

Règles absolues :
- N'affirme aucun fait sur l'utilisateur qui ne figure pas dans la liste ci-dessus.
- Si répondre correctement exige une information absente de cette liste, laisse
  "reply" vide et pose la question dans "needsFact".
- "factsUsed" liste les identifiants entre crochets des faits que tu as réellement utilisés.`;
}

function construireInvite(contexte: ContexteRedaction, tourDeParole: string): string {
  const historique = contexte.derniersMessages
    .map((m) => `${m.direction === "IN" ? "Elle/il" : "Toi"} : ${m.texte}`)
    .join("\n");
  const resume = contexte.resumeFil ? `Résumé du fil : ${contexte.resumeFil}\n\n` : "";
  return `${resume}${historique}\n\nMessage auquel répondre :\n${tourDeParole}`;
}

export async function rediger(params: {
  contexte: ContexteRedaction;
  tourDeParole: string;
  contactId?: string;
  appeler?: typeof appelerStructure;
}): Promise<ResultatRedaction> {
  const appeler = params.appeler ?? appelerStructure;

  let resultat;
  try {
    resultat = await appeler({
      role: "compose",
      contactId: params.contactId,
      schema: sortieSchema,
      systeme: construireSysteme(params.contexte),
      invite: construireInvite(params.contexte, params.tourDeParole),
    });
  } catch (erreur) {
    // P2 : un rédacteur indisponible ne produit pas de message, il produit une
    // escalade. Le système se tait et demande.
    log.error("Rédacteur indisponible", {
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    return {
      brouillon: null,
      motifRefus: "Le rédacteur est indisponible.",
      regleRefus: "redacteur.indisponible",
      fournisseur: null,
      latencyMs: null,
      costUsd: null,
    };
  }

  const validation = validerBrouillon(resultat.valeur as BrouillonBrut, params.contexte);
  if (!validation.valide) {
    log.info("Brouillon refusé par la validation", { regle: validation.regle });
    return {
      brouillon: null,
      motifRefus: validation.motif,
      regleRefus: validation.regle,
      fournisseur: resultat.fournisseur,
      latencyMs: resultat.latencyMs,
      costUsd: resultat.costUsd,
    };
  }

  return {
    brouillon: validation.texte,
    motifRefus: null,
    regleRefus: null,
    fournisseur: resultat.fournisseur,
    latencyMs: resultat.latencyMs,
    costUsd: resultat.costUsd,
  };
}
```

- [ ] **Step 6 : Vérifier**

Run: `pnpm test tests/redacteur/`, puis `pnpm test`, puis `npx tsc --noEmit`
Expected: PASS (13 tests sur les deux fichiers).

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "feat: rédacteur et validation mécanique anti-invention"
```

---

### Task 6 : Mise en forme et création des escalades

**Files:**
- Create: `src/escalade/format.ts`, `src/escalade/service.ts`
- Test: `tests/escalade/format.test.ts`, `tests/escalade/service.int.test.ts`

**Interfaces:**
- Consumes: `prisma`, `log`.
- Produces:
  - `function formaterEscalade(params: { alias: string; risques: RiskCategory[]; messageRecu: string; proposition: string | null; motifRefus: string | null }): string`
  - `function creerEscalade(params: { decisionId: string; proposition: string | null; expiresAt?: Date }): Promise<{ id: string }>`
  - `function marquerPostee(escaladeId: string, controlMessageWaId: string): Promise<void>`
  - `const DUREE_ESCALADE_MS: number`

- [ ] **Step 1 : Écrire le test de mise en forme qui échoue**

`tests/escalade/format.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { formaterEscalade } from "@/escalade/format";
import { RiskCategory } from "@/generated/prisma/client";

describe("mise en forme d'une escalade", () => {
  it("nomme le contact, les risques et le message reçu", () => {
    const texte = formaterEscalade({
      alias: "Sarah",
      risques: [RiskCategory.ENGAGEMENT],
      messageRecu: "on se voit vendredi ?",
      proposition: "Vendredi ça me va, plutôt en soirée ?",
      motifRefus: null,
    });
    expect(texte).toContain("Sarah");
    expect(texte).toContain("on se voit vendredi ?");
    expect(texte).toContain("Vendredi ça me va");
  });

  it("propose les quatre actions quand une proposition existe", () => {
    const texte = formaterEscalade({
      alias: "Sarah", risques: [RiskCategory.ENGAGEMENT], messageRecu: "x",
      proposition: "y", motifRefus: null,
    });
    expect(texte).toContain("1");
    expect(texte).toContain("2");
    expect(texte).toContain("3");
    expect(texte).toContain("4");
  });

  it("explique pourquoi il n'y a pas de proposition, plutôt que de laisser un vide", () => {
    const texte = formaterEscalade({
      alias: "Sarah", risques: [RiskCategory.FACT], messageRecu: "tu bosses samedi ?",
      proposition: null, motifRefus: "Le rédacteur a besoin d'une information que tu n'as pas renseignée : Tu bosses samedi ?",
    });
    expect(texte).toContain("Tu bosses samedi ?");
    expect(texte).not.toMatch(/1\s+envoyer/);
  });

  it("traduit les catégories de risque en français", () => {
    const texte = formaterEscalade({
      alias: "S", risques: [RiskCategory.MONEY, RiskCategory.EMOTIONAL], messageRecu: "x",
      proposition: null, motifRefus: "y",
    });
    expect(texte.toLowerCase()).toContain("argent");
    expect(texte.toLowerCase()).toContain("émotionnel");
  });

  it("reste lisible sans risque identifié", () => {
    const texte = formaterEscalade({ alias: "S", risques: [], messageRecu: "x", proposition: "y", motifRefus: null });
    expect(texte).toContain("S");
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/escalade/format.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter la mise en forme**

`src/escalade/format.ts` :

```ts
import { RiskCategory } from "@/generated/prisma/client";

const LIBELLES: Record<RiskCategory, string> = {
  ENGAGEMENT: "engagement",
  FACT: "question sur toi",
  EMOTIONAL: "émotionnel",
  MONEY: "argent",
  INTIMATE: "intime",
  THIRD_PARTY: "tierce personne",
  LOW_CONFIDENCE: "incertain",
  NON_TEXT: "message non textuel",
};

export function formaterEscalade(params: {
  alias: string;
  risques: RiskCategory[];
  messageRecu: string;
  proposition: string | null;
  motifRefus: string | null;
}): string {
  const risques = params.risques.length
    ? params.risques.map((r) => LIBELLES[r]).join(" + ")
    : "à vérifier";

  const entete = `⚠️ ${params.alias} — ${risques}`;
  const recu = `« ${params.messageRecu} »`;

  if (params.proposition !== null) {
    return [
      entete,
      recu,
      "",
      `Proposition : « ${params.proposition} »`,
      "1 envoyer · 2 <ton texte> · 3 ignorer · 4 pause",
    ].join("\n");
  }

  // Sans proposition, offrir « 1 envoyer » n'aurait aucun sens : on dit ce qui
  // manque et on ne propose que les actions réellement disponibles.
  return [
    entete,
    recu,
    "",
    params.motifRefus ?? "Aucune proposition n'a pu être rédigée.",
    "2 <ton texte> · 3 ignorer · 4 pause",
  ].join("\n");
}
```

- [ ] **Step 4 : Écrire le test du service qui échoue**

`tests/escalade/service.int.test.ts` :

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { creerEscalade, marquerPostee, DUREE_ESCALADE_MS } from "@/escalade/service";
import { resetDb } from "../helpers/db";

async function decision() {
  const contact = await prisma.contact.create({
    data: { jid: "225@s.whatsapp.net", thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Date.now()}`,
      direction: "IN", source: "HUMAN", text: "on se voit vendredi ?", timestamp: new Date(),
    },
  });
  return prisma.decision.create({
    data: {
      messageId: message.id, contactId: contact.id, risks: ["ENGAGEMENT"],
      ruleFired: "risque.engagement.rendez-vous", outcome: "ESCALATED",
    },
  });
}

describe("service d'escalade", () => {
  beforeEach(resetDb);

  it("crée une escalade ouverte liée à la décision", async () => {
    const d = await decision();
    const { id } = await creerEscalade({ decisionId: d.id, proposition: "Vendredi ça me va" });
    const e = await prisma.escalation.findUnique({ where: { id } });
    expect(e?.status).toBe("OPEN");
    expect(e?.proposedText).toBe("Vendredi ça me va");
    expect(e?.decisionId).toBe(d.id);
  });

  it("fixe une échéance par défaut à six heures", async () => {
    const d = await decision();
    const avant = Date.now();
    const { id } = await creerEscalade({ decisionId: d.id, proposition: null });
    const e = await prisma.escalation.findUnique({ where: { id } });
    const ecart = e!.expiresAt.getTime() - avant;
    expect(ecart).toBeGreaterThan(DUREE_ESCALADE_MS - 5_000);
    expect(ecart).toBeLessThan(DUREE_ESCALADE_MS + 5_000);
  });

  it("enregistre l'identifiant du message de contrôle, qui sert à la résolution", async () => {
    const d = await decision();
    const { id } = await creerEscalade({ decisionId: d.id, proposition: null });
    await marquerPostee(id, "WA-CTRL-1");
    const e = await prisma.escalation.findUnique({ where: { id } });
    expect(e?.controlMessageWaId).toBe("WA-CTRL-1");
  });

  it("refuse deux escalades pour la même décision", async () => {
    const d = await decision();
    await creerEscalade({ decisionId: d.id, proposition: null });
    await expect(creerEscalade({ decisionId: d.id, proposition: null })).rejects.toThrow();
  });
});
```

- [ ] **Step 5 : Implémenter le service**

`src/escalade/service.ts` :

```ts
import { prisma } from "@/lib/prisma";

// Six heures : au-delà, une escalade non résolue ne correspond plus au fil de la
// conversation. Rien n'est envoyé, un rappel est posté.
export const DUREE_ESCALADE_MS = 6 * 60 * 60 * 1000;

export async function creerEscalade(params: {
  decisionId: string;
  proposition: string | null;
  expiresAt?: Date;
}): Promise<{ id: string }> {
  const escalade = await prisma.escalation.create({
    data: {
      decisionId: params.decisionId,
      proposedText: params.proposition,
      expiresAt: params.expiresAt ?? new Date(Date.now() + DUREE_ESCALADE_MS),
    },
    select: { id: true },
  });
  return escalade;
}

export async function marquerPostee(escaladeId: string, controlMessageWaId: string): Promise<void> {
  await prisma.escalation.update({
    where: { id: escaladeId },
    data: { controlMessageWaId },
  });
}
```

- [ ] **Step 6 : Vérifier**

Run: `pnpm test tests/escalade/format.test.ts`, puis `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: PASS (9 tests).

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "feat: mise en forme et création des escalades"
```

---

### Task 7 : Analyse des commandes du groupe de contrôle

**Files:**
- Create: `src/controle/commandes.ts`
- Test: `tests/controle/commandes.test.ts`

**Interfaces:**
- Consumes: rien — fonction pure.
- Produces:
  - `type Commande = { type: "envoyer" } | { type: "texte"; contenu: string } | { type: "ignorer" } | { type: "pause" } | { type: "stop" } | { type: "go" } | { type: "mode"; alias: string; mode: "auto" | "draft" | "off" } | { type: "statut" } | { type: "qui"; alias: string } | { type: "inconnue"; brut: string }`
  - `function analyserCommande(brut: string): Commande`

**Fonction pure**, exhaustivement testable. C'est elle qui traduit un geste du pouce en action.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/controle/commandes.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { analyserCommande } from "@/controle/commandes";

describe("analyse des commandes du groupe de contrôle", () => {
  it("reconnaît l'envoi", () => {
    expect(analyserCommande("1")).toEqual({ type: "envoyer" });
    expect(analyserCommande("ok")).toEqual({ type: "envoyer" });
    expect(analyserCommande("  OK  ")).toEqual({ type: "envoyer" });
  });

  it("reconnaît un texte de remplacement préfixé", () => {
    expect(analyserCommande("2 je passe plutôt dimanche")).toEqual({
      type: "texte", contenu: "je passe plutôt dimanche",
    });
  });

  it("traite un texte libre comme un texte de remplacement", () => {
    expect(analyserCommande("dis-lui que je rappelle")).toEqual({
      type: "texte", contenu: "dis-lui que je rappelle",
    });
  });

  it("reconnaît ignorer et pause", () => {
    expect(analyserCommande("3")).toEqual({ type: "ignorer" });
    expect(analyserCommande("4")).toEqual({ type: "pause" });
  });

  it("reconnaît les commandes globales", () => {
    expect(analyserCommande("/stop")).toEqual({ type: "stop" });
    expect(analyserCommande("/go")).toEqual({ type: "go" });
    expect(analyserCommande("/statut")).toEqual({ type: "statut" });
  });

  it("reconnaît un changement de mode avec son alias", () => {
    expect(analyserCommande("/mode sarah draft")).toEqual({
      type: "mode", alias: "sarah", mode: "draft",
    });
    expect(analyserCommande("/MODE Sarah AUTO")).toEqual({
      type: "mode", alias: "Sarah", mode: "auto",
    });
  });

  it("refuse un mode inconnu plutôt que de deviner", () => {
    expect(analyserCommande("/mode sarah turbo")).toEqual({ type: "inconnue", brut: "/mode sarah turbo" });
  });

  it("reconnaît la consultation d'une fiche, sous ses deux noms", () => {
    expect(analyserCommande("/qui sarah")).toEqual({ type: "qui", alias: "sarah" });
    expect(analyserCommande("/who sarah")).toEqual({ type: "qui", alias: "sarah" });
  });

  it("renvoie inconnue sur une commande slash non reconnue", () => {
    expect(analyserCommande("/danse")).toEqual({ type: "inconnue", brut: "/danse" });
  });

  it("ne confond pas un texte commençant par un chiffre avec une commande", () => {
    expect(analyserCommande("2000 c'est trop cher")).toEqual({
      type: "texte", contenu: "2000 c'est trop cher",
    });
  });

  it("renvoie inconnue sur une entrée vide", () => {
    expect(analyserCommande("   ")).toEqual({ type: "inconnue", brut: "   " });
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/controle/commandes.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter**

`src/controle/commandes.ts` :

```ts
export type Commande =
  | { type: "envoyer" }
  | { type: "texte"; contenu: string }
  | { type: "ignorer" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "go" }
  | { type: "mode"; alias: string; mode: "auto" | "draft" | "off" }
  | { type: "statut" }
  | { type: "qui"; alias: string }
  | { type: "inconnue"; brut: string };

const MODES = new Set(["auto", "draft", "off"]);

export function analyserCommande(brut: string): Commande {
  const texte = brut.trim();
  if (texte === "") return { type: "inconnue", brut };

  if (texte.startsWith("/")) {
    const [mot, ...reste] = texte.slice(1).split(/\s+/);
    const commande = mot.toLowerCase();

    if (commande === "stop") return { type: "stop" };
    if (commande === "go") return { type: "go" };
    if (commande === "statut" || commande === "status") return { type: "statut" };
    if ((commande === "qui" || commande === "who") && reste[0]) return { type: "qui", alias: reste[0] };
    if (commande === "mode" && reste.length >= 2) {
      const mode = reste[1].toLowerCase();
      if (MODES.has(mode)) {
        return { type: "mode", alias: reste[0], mode: mode as "auto" | "draft" | "off" };
      }
    }
    return { type: "inconnue", brut };
  }

  const minuscule = texte.toLowerCase();
  if (minuscule === "1" || minuscule === "ok") return { type: "envoyer" };
  if (minuscule === "3") return { type: "ignorer" };
  if (minuscule === "4") return { type: "pause" };

  // « 2 <texte> » exige l'espace : sans lui, « 2000 c'est trop cher » serait
  // amputé de son premier caractère et envoyé tel quel.
  const remplacement = texte.match(/^2\s+(.+)$/s);
  if (remplacement) return { type: "texte", contenu: remplacement[1].trim() };

  return { type: "texte", contenu: texte };
}
```

- [ ] **Step 4 : Vérifier**

Run: `pnpm test tests/controle/commandes.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "feat: analyse des commandes du groupe de contrôle"
```

---

### Task 8 : Exécution des commandes et résolution des escalades

**Files:**
- Create: `src/controle/routeur.ts`
- Test: `tests/controle/routeur.int.test.ts`

**Interfaces:**
- Consumes: `analyserCommande`, `prisma`, `createGowaClient`, `log`.
- Produces: `function traiterMessageControle(params: { texte: string; replyToWaId: string | null; envoyer?: (jid: string, texte: string) => Promise<void> }): Promise<{ action: string; reponse: string }>`

**Deux points structurants :**
- **La résolution passe par la réponse native** (`replyToWaId`). Sans elle, une commande d'envoi appliquée à la mauvaise escalade enverrait un message à la mauvaise personne.
- **P1 tient ici aussi** : `/mode` sur un contact inconnu est refusé. Une commande ne peut pas activer un contact qui n'existe pas.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/controle/routeur.int.test.ts` :

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { traiterMessageControle } from "@/controle/routeur";
import { resetDb } from "../helpers/db";

async function escaladeOuverte(proposition: string | null = "Vendredi ça me va") {
  const contact = await prisma.contact.create({
    data: { jid: "22500000001@s.whatsapp.net", alias: "sarah", mode: "DRAFT", thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Date.now()}-${Math.random()}`,
      direction: "IN", source: "HUMAN", text: "on se voit vendredi ?", timestamp: new Date(),
    },
  });
  const decision = await prisma.decision.create({
    data: {
      messageId: message.id, contactId: contact.id, risks: ["ENGAGEMENT"],
      ruleFired: "risque.engagement.rendez-vous", outcome: "ESCALATED",
    },
  });
  const escalade = await prisma.escalation.create({
    data: {
      decisionId: decision.id, proposedText: proposition,
      controlMessageWaId: "WA-CTRL-1", expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return { contact, escalade };
}

describe("routeur du groupe de contrôle", () => {
  beforeEach(resetDb);

  it("envoie la proposition au contact sur « 1 » et résout l'escalade", async () => {
    const { contact, escalade } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue(undefined);
    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).toHaveBeenCalledWith(contact.jid, "Vendredi ça me va");
    expect(r.action).toBe("envoyer");
    const apres = await prisma.escalation.findUnique({ where: { id: escalade.id } });
    expect(apres?.status).toBe("RESOLVED");
    expect(apres?.resolvedText).toBe("Vendredi ça me va");
  });

  it("envoie le texte de l'utilisateur plutôt que la proposition", async () => {
    const { contact } = await escaladeOuverte();
    const envoyer = vi.fn().mockResolvedValue(undefined);
    await traiterMessageControle({ texte: "2 je passe dimanche", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).toHaveBeenCalledWith(contact.jid, "je passe dimanche");
  });

  it("refuse « 1 » quand l'escalade n'a pas de proposition", async () => {
    await escaladeOuverte(null);
    const envoyer = vi.fn();
    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.reponse).toMatch(/aucune proposition/i);
  });

  it("résout sans rien envoyer sur « 3 »", async () => {
    const { escalade } = await escaladeOuverte();
    const envoyer = vi.fn();
    await traiterMessageControle({ texte: "3", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    const apres = await prisma.escalation.findUnique({ where: { id: escalade.id } });
    expect(apres?.status).toBe("RESOLVED");
  });

  it("passe le contact en DRAFT sur « 4 », sans jamais l'activer", async () => {
    const { contact } = await escaladeOuverte();
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: "AUTO" } });
    await traiterMessageControle({ texte: "4", replyToWaId: "WA-CTRL-1", envoyer: vi.fn() });
    const apres = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(apres?.mode).toBe("DRAFT");
  });

  it("refuse une action d'escalade sans réponse native, plutôt que de deviner laquelle", async () => {
    await escaladeOuverte();
    const envoyer = vi.fn();
    const r = await traiterMessageControle({ texte: "1", replyToWaId: null, envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.reponse).toMatch(/réponds au message/i);
  });

  it("refuse d'agir sur une escalade déjà résolue", async () => {
    const { escalade } = await escaladeOuverte();
    await prisma.escalation.update({ where: { id: escalade.id }, data: { status: "RESOLVED" } });
    const envoyer = vi.fn();
    const r = await traiterMessageControle({ texte: "1", replyToWaId: "WA-CTRL-1", envoyer });
    expect(envoyer).not.toHaveBeenCalled();
    expect(r.reponse).toMatch(/déjà/i);
  });

  it("bascule la pause globale sur /stop et /go", async () => {
    await traiterMessageControle({ texte: "/stop", replyToWaId: null, envoyer: vi.fn() });
    let etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
    expect(etat?.globalPaused).toBe(true);
    await traiterMessageControle({ texte: "/go", replyToWaId: null, envoyer: vi.fn() });
    etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
    expect(etat?.globalPaused).toBe(false);
  });

  it("refuse /mode sur un contact inconnu (P1)", async () => {
    const r = await traiterMessageControle({ texte: "/mode inconnue auto", replyToWaId: null, envoyer: vi.fn() });
    expect(r.reponse).toMatch(/introuvable|interface/i);
    expect(await prisma.contact.count()).toBe(0);
  });

  it("change le mode d'un contact connu", async () => {
    const { contact } = await escaladeOuverte();
    await traiterMessageControle({ texte: "/mode sarah off", replyToWaId: null, envoyer: vi.fn() });
    const apres = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(apres?.mode).toBe("OFF");
  });

  it("répond quelque chose d'utile sur une commande inconnue", async () => {
    const r = await traiterMessageControle({ texte: "/danse", replyToWaId: null, envoyer: vi.fn() });
    expect(r.action).toBe("inconnue");
    expect(r.reponse.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: FAIL — `@/controle/routeur` introuvable.

- [ ] **Step 3 : Implémenter**

`src/controle/routeur.ts` :

```ts
import { ContactMode } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";
import { analyserCommande, type Commande } from "./commandes";

type Envoyeur = (jid: string, texte: string) => Promise<void>;

async function envoyerParGowa(jid: string, texte: string): Promise<void> {
  await createGowaClient().sendText({ phone: jid, message: texte });
}

async function escaladeDepuisReponse(replyToWaId: string | null) {
  if (replyToWaId === null) return null;
  return prisma.escalation.findFirst({
    where: { controlMessageWaId: replyToWaId },
    include: { decision: { include: { contact: true } } },
  });
}

async function basculerPause(valeur: boolean): Promise<void> {
  await prisma.systemState.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", globalPaused: valeur },
    update: { globalPaused: valeur },
  });
}

export async function traiterMessageControle(params: {
  texte: string;
  replyToWaId: string | null;
  envoyer?: Envoyeur;
}): Promise<{ action: string; reponse: string }> {
  const envoyer = params.envoyer ?? envoyerParGowa;
  const commande: Commande = analyserCommande(params.texte);

  if (commande.type === "stop") {
    await basculerPause(true);
    return { action: "stop", reponse: "Pause globale activée." };
  }
  if (commande.type === "go") {
    await basculerPause(false);
    return { action: "go", reponse: "Pause globale levée." };
  }
  if (commande.type === "statut") {
    const [actifs, ouvertes] = await Promise.all([
      prisma.contact.count({ where: { mode: { not: ContactMode.OFF } } }),
      prisma.escalation.count({ where: { status: "OPEN" } }),
    ]);
    return { action: "statut", reponse: `${actifs} contact(s) actif(s), ${ouvertes} escalade(s) ouverte(s).` };
  }
  if (commande.type === "qui") {
    const contact = await prisma.contact.findFirst({
      where: { alias: commande.alias },
      include: { policy: true },
    });
    if (!contact) return { action: "qui", reponse: `Contact « ${commande.alias} » introuvable.` };
    return {
      action: "qui",
      reponse: `${contact.alias ?? contact.jid} — mode ${contact.mode}, adulte ${contact.isAdult ? "oui" : "non"}.`,
    };
  }
  if (commande.type === "mode") {
    const contact = await prisma.contact.findFirst({ where: { alias: commande.alias } });
    // P1 : une commande ne crée jamais un contact. L'activation initiale passe
    // obligatoirement par l'interface web.
    if (!contact) {
      return {
        action: "mode",
        reponse: `Contact « ${commande.alias} » introuvable. L'activation initiale passe par l'interface.`,
      };
    }
    const cible = commande.mode.toUpperCase() as ContactMode;
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: cible } });
    return { action: "mode", reponse: `${commande.alias} est maintenant en ${cible}.` };
  }

  // À partir d'ici, tout porte sur une escalade précise.
  const escalade = await escaladeDepuisReponse(params.replyToWaId);
  if (!escalade) {
    return {
      action: "sans-cible",
      reponse: "Réponds au message d'escalade concerné pour agir dessus.",
    };
  }
  if (escalade.status !== "OPEN") {
    return { action: "deja-resolue", reponse: "Cette escalade est déjà résolue." };
  }

  const contact = escalade.decision.contact;

  if (commande.type === "envoyer") {
    if (!escalade.proposedText) {
      return { action: "envoyer", reponse: "Aucune proposition à envoyer. Écris ton texte." };
    }
    await envoyer(contact.jid, escalade.proposedText);
    await prisma.escalation.update({
      where: { id: escalade.id },
      data: { status: "RESOLVED", resolution: "envoyer", resolvedText: escalade.proposedText, resolvedAt: new Date() },
    });
    log.info("Escalade résolue par envoi", { escaladeId: escalade.id, contactId: contact.id });
    return { action: "envoyer", reponse: "Envoyé." };
  }

  if (commande.type === "texte") {
    await envoyer(contact.jid, commande.contenu);
    await prisma.escalation.update({
      where: { id: escalade.id },
      data: { status: "RESOLVED", resolution: "texte", resolvedText: commande.contenu, resolvedAt: new Date() },
    });
    log.info("Escalade résolue par texte personnalisé", { escaladeId: escalade.id, contactId: contact.id });
    return { action: "texte", reponse: "Envoyé." };
  }

  if (commande.type === "ignorer") {
    await prisma.escalation.update({
      where: { id: escalade.id },
      data: { status: "RESOLVED", resolution: "ignorer", resolvedAt: new Date() },
    });
    return { action: "ignorer", reponse: "Ignoré, rien n'a été envoyé." };
  }

  if (commande.type === "pause") {
    await prisma.contact.update({ where: { id: contact.id }, data: { mode: ContactMode.DRAFT } });
    await prisma.escalation.update({
      where: { id: escalade.id },
      data: { status: "RESOLVED", resolution: "pause", resolvedAt: new Date() },
    });
    return { action: "pause", reponse: `${contact.alias ?? contact.jid} repasse en brouillon.` };
  }

  return { action: "inconnue", reponse: "Commande non reconnue. 1 envoyer · 2 <texte> · 3 ignorer · 4 pause" };
}
```

- [ ] **Step 4 : Vérifier**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`, puis `pnpm test`, puis `npx tsc --noEmit`
Expected: PASS (11 nouveaux tests).

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "feat: exécution des commandes et résolution des escalades"
```

---

### Task 9 : Câblage — escalader, poster, router

**Files:**
- Modify: `src/ingest/decision.ts`, `src/ingest/handler.ts`
- Create: `src/escalade/publication.ts`
- Test: `tests/escalade/publication.int.test.ts`, ajouts à `tests/ingest/decision.int.test.ts`

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: `function publierEscalade(params: { decisionId: string; contactId: string; messageRecu: string; risques: RiskCategory[]; envoyer?: (jid: string, texte: string) => Promise<{ messageId?: string }> }): Promise<{ escaladeId: string } | null>`

**Ce que cette tâche connecte :** quand le moteur rend `ESCALATED` ou `DRAFTED`, le rédacteur produit une proposition, une escalade est créée, le message est posté dans le groupe de contrôle, et son identifiant est enregistré pour permettre la résolution par réponse. Et les messages **venant** du groupe de contrôle sont routés vers `traiterMessageControle` au lieu d'être ingérés.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/escalade/publication.int.test.ts` :

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { publierEscalade } from "@/escalade/publication";
import { resetDb } from "../helpers/db";

vi.mock("@/redacteur/redacteur", () => ({
  rediger: vi.fn().mockResolvedValue({
    brouillon: "Vendredi ça me va", motifRefus: null, regleRefus: null,
    fournisseur: "test", latencyMs: 10, costUsd: 0.0002,
  }),
}));

async function decision() {
  const contact = await prisma.contact.create({
    data: { jid: "225@s.whatsapp.net", alias: "sarah", mode: "DRAFT", thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Date.now()}`,
      direction: "IN", source: "HUMAN", text: "on se voit vendredi ?", timestamp: new Date(),
    },
  });
  const d = await prisma.decision.create({
    data: {
      messageId: message.id, contactId: contact.id, risks: ["ENGAGEMENT"],
      ruleFired: "risque.engagement.rendez-vous", outcome: "ESCALATED",
    },
  });
  return { contact, decision: d };
}

describe("publication d'une escalade", () => {
  beforeEach(resetDb);

  it("crée l'escalade, poste le message et enregistre son identifiant", async () => {
    const { contact, decision: d } = await decision();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-CTRL-9" });
    const r = await publierEscalade({
      decisionId: d.id, contactId: contact.id, messageRecu: "on se voit vendredi ?",
      risques: ["ENGAGEMENT"], envoyer,
    });
    expect(r).not.toBeNull();
    expect(envoyer).toHaveBeenCalledTimes(1);
    const e = await prisma.escalation.findUnique({ where: { id: r!.escaladeId } });
    expect(e?.controlMessageWaId).toBe("WA-CTRL-9");
    expect(e?.proposedText).toBe("Vendredi ça me va");
  });

  it("poste le message dans le groupe de contrôle, pas au contact", async () => {
    const { contact, decision: d } = await decision();
    const envoyer = vi.fn().mockResolvedValue({ messageId: "WA-CTRL-9" });
    await publierEscalade({
      decisionId: d.id, contactId: contact.id, messageRecu: "x", risques: [], envoyer,
    });
    const [destinataire] = envoyer.mock.calls[0];
    expect(destinataire).not.toBe(contact.jid);
  });

  it("ne lève pas quand le groupe de contrôle n'est pas configuré", async () => {
    const { contact, decision: d } = await decision();
    delete process.env.CONTROL_GROUP_JID;
    await expect(
      publierEscalade({ decisionId: d.id, contactId: contact.id, messageRecu: "x", risques: [], envoyer: vi.fn() }),
    ).resolves.toBeNull();
  });

  it("crée quand même l'escalade si l'envoi échoue, pour ne pas la perdre", async () => {
    const { contact, decision: d } = await decision();
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    const envoyer = vi.fn().mockRejectedValue(new Error("GOWA injoignable"));
    const r = await publierEscalade({
      decisionId: d.id, contactId: contact.id, messageRecu: "x", risques: [], envoyer,
    });
    expect(r).not.toBeNull();
    const e = await prisma.escalation.findUnique({ where: { id: r!.escaladeId } });
    expect(e?.status).toBe("OPEN");
    expect(e?.controlMessageWaId).toBeNull();
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: FAIL — `@/escalade/publication` introuvable.

- [ ] **Step 3 : Implémenter la publication**

`src/escalade/publication.ts` :

```ts
import type { RiskCategory } from "@/generated/prisma/client";
import { getEnv } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";
import { assemblerContexte } from "@/redacteur/contexte";
import { rediger } from "@/redacteur/redacteur";
import { creerEscalade, marquerPostee } from "./service";
import { formaterEscalade } from "./format";

type Envoyeur = (jid: string, texte: string) => Promise<{ messageId?: string }>;

async function envoyerParGowa(jid: string, texte: string): Promise<{ messageId?: string }> {
  return createGowaClient().sendText({ phone: jid, message: texte });
}

export async function publierEscalade(params: {
  decisionId: string;
  contactId: string;
  messageRecu: string;
  risques: RiskCategory[];
  envoyer?: Envoyeur;
}): Promise<{ escaladeId: string } | null> {
  const groupe = getEnv().CONTROL_GROUP_JID;
  if (!groupe) {
    log.warn("Groupe de contrôle non configuré, escalade non publiée", { decisionId: params.decisionId });
    return null;
  }

  const contact = await prisma.contact.findUnique({ where: { id: params.contactId } });
  if (!contact) return null;

  const contexte = await assemblerContexte(params.contactId);
  const redaction = await rediger({
    contexte,
    tourDeParole: params.messageRecu,
    contactId: params.contactId,
  });

  const { id: escaladeId } = await creerEscalade({
    decisionId: params.decisionId,
    proposition: redaction.brouillon,
  });

  const texte = formaterEscalade({
    alias: contact.alias ?? contact.jid,
    risques: params.risques,
    messageRecu: params.messageRecu,
    proposition: redaction.brouillon,
    motifRefus: redaction.motifRefus,
  });

  const envoyer = params.envoyer ?? envoyerParGowa;
  try {
    const resultat = await envoyer(groupe, texte);
    if (resultat.messageId) await marquerPostee(escaladeId, resultat.messageId);
  } catch (erreur) {
    // L'escalade existe déjà en base : on ne la perd pas parce que la
    // publication a échoué. Elle reste OPEN et pourra être republiée.
    log.error("Publication de l'escalade impossible", {
      escaladeId,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  return { escaladeId };
}
```

- [ ] **Step 4 : Câbler dans la décision**

Dans `src/ingest/decision.ts`, ajouter en tête `import { publierEscalade } from "@/escalade/publication";` puis, après la création de la `Decision` et avant le `return`, quand l'issue est `ESCALATED` ou `DRAFTED` :

```ts
  if (verdict.issue === DecisionOutcome.ESCALATED || verdict.issue === DecisionOutcome.DRAFTED) {
    try {
      await publierEscalade({
        decisionId: decisionCreee.id,
        contactId: contact.id,
        messageRecu: params.texte ?? "(message non textuel)",
        risques: risquesUniques,
      });
    } catch (erreur) {
      // Une escalade non publiée ne doit pas faire échouer la décision, qui est
      // déjà tracée. Le journal en garde la trace.
      log.error("Escalade non publiée", {
        decisionId: decisionCreee.id,
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  }
```

Cela suppose de récupérer la `Decision` créée : remplacer `await prisma.decision.create({...})` par `const decisionCreee = await prisma.decision.create({ ..., select: { id: true } })`.

- [ ] **Step 5 : Router les messages du groupe de contrôle**

Dans `src/ingest/handler.ts`, ajouter en tête `import { traiterMessageControle } from "@/controle/routeur";` puis remplacer la branche qui renvoie `groupe_de_controle` — elle doit désormais **traiter** le message au lieu de simplement l'ignorer :

```ts
  if (options.controlGroupJid && payload.chat_id === options.controlGroupJid) {
    // Seuls les messages que l'utilisateur écrit lui-même dans le groupe sont
    // des commandes ; ceux que le système y poste ne doivent pas se déclencher
    // eux-mêmes.
    if (payload.is_from_me) {
      try {
        const resultat = await traiterMessageControle({
          texte: payload.body ?? "",
          replyToWaId: payload.replied_to_id ?? null,
        });
        log.info("Commande de contrôle traitée", { action: resultat.action });
      } catch (erreur) {
        log.error("Commande de contrôle en échec", {
          erreur: erreur instanceof Error ? erreur.message : String(erreur),
        });
      }
    }
    return { statut: "groupe_de_controle" };
  }
```

- [ ] **Step 6 : Ajouter les tests de câblage**

Dans `tests/ingest/decision.int.test.ts`, ajouter :

```ts
  it("publie une escalade quand le verdict est ESCALATED", async () => {
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "tu peux m'envoyer 50000 F ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({
      where: { messageId: message.id }, include: { escalation: true },
    });
    expect(decision?.escalation).not.toBeNull();
  });

  it("ne publie pas d'escalade sur un verdict IGNORED (P1)", async () => {
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
    const { contact, message } = await contactAvecMessage(ContactMode.OFF);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "on se voit vendredi ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({
      where: { messageId: message.id }, include: { escalation: true },
    });
    expect(decision?.escalation).toBeNull();
  });
```

- [ ] **Step 7 : Vérifier**

Run: `pnpm test`, puis `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`, puis `npx tsc --noEmit`
Expected: tout vert, sortie vierge.

- [ ] **Step 8 : Commit**

```bash
git add -A
git commit -m "feat: publication des escalades et routage du groupe de contrôle"
```

---

### Task 10 : Expiration des escalades

**Files:**
- Create: `src/escalade/expiration.ts`, `src/app/api/taches/escalades/route.ts`
- Test: `tests/escalade/expiration.int.test.ts`

**Interfaces:**
- Consumes: `prisma`, `log`, `createGowaClient`, `getEnv`.
- Produces: `function expirerEscalades(params?: { maintenant?: Date; envoyer?: (jid: string, texte: string) => Promise<unknown> }): Promise<{ expirees: number }>`

**Déclenchement :** une route protégée par le secret du webhook, appelée par une tâche planifiée Dokploy. Pas de minuterie en processus : elle ne survivrait pas à un redéploiement, et cette phase a déjà appris ce que coûte un mécanisme qui s'exécute là où personne ne le regarde.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/escalade/expiration.int.test.ts` :

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { expirerEscalades } from "@/escalade/expiration";
import { resetDb } from "../helpers/db";

async function escalade(expiresAt: Date, status: "OPEN" | "RESOLVED" = "OPEN") {
  const contact = await prisma.contact.create({
    data: { jid: `${Math.random()}@s.whatsapp.net`, alias: "sarah", thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id, waMessageId: `M-${Math.random()}`,
      direction: "IN", source: "HUMAN", text: "x", timestamp: new Date(),
    },
  });
  const decision = await prisma.decision.create({
    data: { messageId: message.id, contactId: contact.id, risks: [], ruleFired: "r", outcome: "ESCALATED" },
  });
  return prisma.escalation.create({ data: { decisionId: decision.id, status, expiresAt } });
}

describe("expiration des escalades", () => {
  beforeEach(async () => {
    await resetDb();
    process.env.CONTROL_GROUP_JID = "1234-5678@g.us";
  });

  it("expire une escalade ouverte dont l'échéance est passée", async () => {
    const e = await escalade(new Date(Date.now() - 1000));
    const r = await expirerEscalades({ envoyer: vi.fn() });
    expect(r.expirees).toBe(1);
    const apres = await prisma.escalation.findUnique({ where: { id: e.id } });
    expect(apres?.status).toBe("EXPIRED");
  });

  it("laisse intacte une escalade encore valide", async () => {
    const e = await escalade(new Date(Date.now() + 3_600_000));
    await expirerEscalades({ envoyer: vi.fn() });
    const apres = await prisma.escalation.findUnique({ where: { id: e.id } });
    expect(apres?.status).toBe("OPEN");
  });

  it("ne touche pas une escalade déjà résolue", async () => {
    const e = await escalade(new Date(Date.now() - 1000), "RESOLVED");
    await expirerEscalades({ envoyer: vi.fn() });
    const apres = await prisma.escalation.findUnique({ where: { id: e.id } });
    expect(apres?.status).toBe("RESOLVED");
  });

  it("poste un rappel unique plutôt qu'un message par escalade", async () => {
    await escalade(new Date(Date.now() - 1000));
    await escalade(new Date(Date.now() - 2000));
    const envoyer = vi.fn().mockResolvedValue({});
    await expirerEscalades({ envoyer });
    expect(envoyer).toHaveBeenCalledTimes(1);
    expect(String(envoyer.mock.calls[0][1])).toContain("2");
  });

  it("n'envoie aucun rappel quand rien n'a expiré", async () => {
    await escalade(new Date(Date.now() + 3_600_000));
    const envoyer = vi.fn();
    await expirerEscalades({ envoyer });
    expect(envoyer).not.toHaveBeenCalled();
  });

  it("n'envoie jamais rien au contact — seul le groupe est destinataire", async () => {
    await escalade(new Date(Date.now() - 1000));
    const envoyer = vi.fn().mockResolvedValue({});
    await expirerEscalades({ envoyer });
    expect(envoyer.mock.calls[0][0]).toBe("1234-5678@g.us");
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter**

`src/escalade/expiration.ts` :

```ts
import { getEnv } from "@/config/env";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { createGowaClient } from "@/gowa/client";

type Envoyeur = (jid: string, texte: string) => Promise<unknown>;

async function envoyerParGowa(jid: string, texte: string): Promise<unknown> {
  return createGowaClient().sendText({ phone: jid, message: texte });
}

export async function expirerEscalades(params: {
  maintenant?: Date;
  envoyer?: Envoyeur;
} = {}): Promise<{ expirees: number }> {
  const maintenant = params.maintenant ?? new Date();
  const envoyer = params.envoyer ?? envoyerParGowa;

  const depassees = await prisma.escalation.findMany({
    where: { status: "OPEN", expiresAt: { lt: maintenant } },
    select: { id: true },
  });
  if (depassees.length === 0) return { expirees: 0 };

  await prisma.escalation.updateMany({
    where: { id: { in: depassees.map((e) => e.id) } },
    data: { status: "EXPIRED" },
  });

  const groupe = getEnv().CONTROL_GROUP_JID;
  if (groupe) {
    // Un rappel groupé plutôt qu'un message par escalade : à six heures
    // d'échéance, plusieurs peuvent expirer ensemble, et autant de
    // notifications rendraient le groupe inutilisable.
    const texte =
      `⏳ ${depassees.length} escalade(s) expirée(s) sans réponse. ` +
      `Rien n'a été envoyé.`;
    try {
      await envoyer(groupe, texte);
    } catch (erreur) {
      log.error("Rappel d'expiration non posté", {
        erreur: erreur instanceof Error ? erreur.message : String(erreur),
      });
    }
  }

  log.info("Escalades expirées", { nombre: depassees.length });
  return { expirees: depassees.length };
}
```

`src/app/api/taches/escalades/route.ts` :

```ts
import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { log } from "@/lib/log";
import { expirerEscalades } from "@/escalade/expiration";

export const dynamic = "force-dynamic";

// Déclenchée par une tâche planifiée, pas par une minuterie en processus : une
// minuterie ne survit pas à un redéploiement et s'exécute là où personne ne la
// regarde. Le secret du webhook sert d'authentification.
export async function POST(request: Request) {
  const fourni = request.headers.get("X-Tache-Secret");
  if (fourni !== getEnv().GOWA_WEBHOOK_SECRET) {
    return NextResponse.json({ erreur: "Non autorisé" }, { status: 401 });
  }
  try {
    const resultat = await expirerEscalades();
    return NextResponse.json(resultat);
  } catch (erreur) {
    log.error("Expiration des escalades en échec", {
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    return NextResponse.json({ erreur: "Expiration impossible" }, { status: 500 });
  }
}
```

Ajouter `/api/taches` à la liste des chemins publics de `src/proxy.ts` — la route s'authentifie par son propre secret, pas par une session.

- [ ] **Step 4 : Vérifier**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`, puis `pnpm test`, puis `npx tsc --noEmit`
Expected: PASS (6 nouveaux tests).

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "feat: expiration des escalades et tâche planifiée associée"
```

---

## Ce que la phase 3a ne fait pas

**Aucun envoi automatique.** Un verdict `AUTO_SENT` est tracé et produit une escalade comme un `DRAFTED` : dans cette phase, le système propose toujours et n'agit jamais seul. Le planificateur d'envoi, les délais humains, l'indicateur de frappe, le regroupement des messages en rafale et les heures de silence arrivent en phase 3b.

Le résumé glissant du fil (`Thread.rollingSummary`) est lu mais jamais écrit — le rôle `summarize` reste inutilisé jusqu'à ce qu'un fil devienne assez long pour en avoir besoin.

## Mise en service

1. Copier `persona.exemple.json` vers `persona.json`, le remplir, lancer `pnpm persona`.
2. Créer un groupe WhatsApp avec le numéro appairé, relever son JID, le renseigner dans `CONTROL_GROUP_JID` côté Dokploy.
3. Renseigner au moins un fournisseur d'IA en base pour le rôle `compose` — sans lui, chaque escalade arrivera sans proposition, ce qui reste utilisable mais sans intérêt.
4. Créer dans Dokploy une tâche planifiée horaire appelant `POST /api/taches/escalades` avec l'en-tête `X-Tache-Secret`.
