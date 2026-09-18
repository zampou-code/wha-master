# Phase 2 — Moteur de décision et couche IA : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classer chaque message entrant, décider de façon déterministe s'il faut répondre ou escalader, et tracer cette décision — sans jamais envoyer, tout restant en mode `DRAFT`.

**Architecture:** Un pipeline à étages où le LLM ne décide jamais *quoi faire* : il ne fait que classer. Les règles lexicales et le classifieur produisent chacun des catégories de risque, réunies par une **union** ; le moteur de décision est une fonction pure sans entrées/sorties ; la couche IA résout une route, appelle, et bascule en cascade sur échec.

**Tech Stack:** Node 22, pnpm 11, TypeScript strict, Prisma 7, Zod 4, Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`), Vitest.

**Spec:** `docs/prive/conception-harness-whatsapp.md` — hors dépôt public. En cas de contradiction avec ce plan, **la spec tranche**.

## Global Constraints

- **P1 — Activation explicite par contact.** `Contact.mode` vaut `OFF` par défaut, au niveau base. Le Gate 0 rejette tout message d'un contact `OFF` **avant classification et avant tout appel à un fournisseur**. Aucun code de cette phase ne modifie `mode`.
- **P2 — Fail-closed.** Timeout, JSON invalide, fournisseur indisponible, exception non gérée, message non textuel : escalade. Aucun chemin d'erreur ne mène à un envoi.
- **P3 — Le modèle ne peut qu'ajouter du risque.** `risques = UNION(règles lexicales, classifieur)`. Jamais une intersection.
- **P5 — Tout est tracé.** Chaque message entrant produit un `Decision` immuable : risques, règle déclenchée, issue, fournisseur, latence, coût.
- Node `22.x`, pnpm `11.x` (épinglés via `packageManager` et `engines`).
- Prisma 7 : générateur `prisma-client`, adaptateur `PrismaPg`, migrations au démarrage du conteneur.
- **Zod 4 API de haut niveau** : `z.looseObject()`, `z.url()`, `z.email()`. `.loose()` et `.passthrough()` sont interdites.
- TypeScript `strict`. Aucun `any` implicite.
- Toute chaîne destinée à l'utilisateur en français, accents corrects.
- Sortie de test vierge — un avertissement est un défaut.
- **Aucun envoi de message dans cette phase.** Aucune tâche n'appelle `sendText`.
- Suite d'intégration : `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int` (le port 5434 n'est pas une faute ; 5432 est occupé sur la machine de développement).

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `src/lib/log.ts` | Journal structuré en JSON, un objet par ligne |
| `src/decision/regles-lexicales.ts` | Gate 1 : motifs déterministes → catégories de risque |
| `src/decision/classifieur.ts` | Gate 2 : appel LLM structuré → catégories de risque |
| `src/decision/moteur.ts` | Gates 0 et 3 + table de décision. **Fonction pure.** |
| `src/decision/types.ts` | Types partagés du moteur |
| `src/ia/registre.ts` | Résolution d'une route : contact → défaut → fournisseur sain |
| `src/ia/appel.ts` | Appel structuré avec repli en cascade |
| `src/ia/fournisseurs.ts` | Fabrique de modèles par `ProviderKind` |
| `src/ingest/decision.ts` | Câblage : ingestion → moteur → persistance du `Decision` |

---

### Task 1 : Journal structuré

**Files:**
- Create: `src/lib/log.ts`
- Modify: les 11 sites `console.*` de `src/` (routes API, `seed-admin.ts`, `gowa/client.ts`)
- Test: `tests/lib/log.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces:
  - `type NiveauLog = "debug" | "info" | "warn" | "error"`
  - `type ChampsLog = Record<string, unknown>`
  - `interface Journal { debug(msg: string, champs?: ChampsLog): void; info(...): void; warn(...): void; error(...): void; enfant(base: ChampsLog): Journal }`
  - `const log: Journal`
  - `function creerJournal(base: ChampsLog, ecrire?: (ligne: string) => void): Journal`

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/lib/log.test.ts` :

```ts
import { describe, it, expect, vi } from "vitest";
import { creerJournal } from "@/lib/log";

function capture() {
  const lignes: string[] = [];
  return { lignes, ecrire: (l: string) => lignes.push(l) };
}

describe("journal structuré", () => {
  it("écrit une ligne JSON par événement, avec niveau, message et horodatage", () => {
    const { lignes, ecrire } = capture();
    creerJournal({}, ecrire).info("message reçu");
    expect(lignes).toHaveLength(1);
    const objet = JSON.parse(lignes[0]);
    expect(objet.niveau).toBe("info");
    expect(objet.message).toBe("message reçu");
    expect(typeof objet.horodatage).toBe("string");
    expect(Number.isNaN(Date.parse(objet.horodatage))).toBe(false);
  });

  it("fusionne les champs de contexte et ceux de l'appel", () => {
    const { lignes, ecrire } = capture();
    creerJournal({ composant: "ingest" }, ecrire).warn("doublon", { waMessageId: "M1" });
    const objet = JSON.parse(lignes[0]);
    expect(objet.composant).toBe("ingest");
    expect(objet.waMessageId).toBe("M1");
  });

  it("laisse les champs de l'appel écraser ceux du contexte", () => {
    const { lignes, ecrire } = capture();
    creerJournal({ contactId: "a" }, ecrire).info("x", { contactId: "b" });
    expect(JSON.parse(lignes[0]).contactId).toBe("b");
  });

  it("crée un journal enfant qui hérite du contexte sans modifier le parent", () => {
    const { lignes, ecrire } = capture();
    const parent = creerJournal({ composant: "ia" }, ecrire);
    parent.enfant({ role: "classify" }).error("échec");
    parent.info("suite");
    expect(JSON.parse(lignes[0]).role).toBe("classify");
    expect(JSON.parse(lignes[1]).role).toBeUndefined();
  });

  it("sérialise une Error en message et nom, sans perdre la ligne", () => {
    const { lignes, ecrire } = capture();
    creerJournal({}, ecrire).error("échec", { erreur: new TypeError("cassé") });
    const objet = JSON.parse(lignes[0]);
    expect(objet.erreur.nom).toBe("TypeError");
    expect(objet.erreur.message).toBe("cassé");
  });

  it("ne lève jamais, même sur une valeur circulaire", () => {
    const { lignes, ecrire } = capture();
    const circulaire: Record<string, unknown> = {};
    circulaire.soi = circulaire;
    expect(() => creerJournal({}, ecrire).info("x", { circulaire })).not.toThrow();
    expect(lignes).toHaveLength(1);
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/lib/log.test.ts`
Expected: FAIL — `@/lib/log` introuvable.

- [ ] **Step 3 : Implémenter**

`src/lib/log.ts` :

```ts
export type NiveauLog = "debug" | "info" | "warn" | "error";
export type ChampsLog = Record<string, unknown>;

export interface Journal {
  debug(message: string, champs?: ChampsLog): void;
  info(message: string, champs?: ChampsLog): void;
  warn(message: string, champs?: ChampsLog): void;
  error(message: string, champs?: ChampsLog): void;
  enfant(base: ChampsLog): Journal;
}

function normaliser(valeur: unknown): unknown {
  if (valeur instanceof Error) {
    return { nom: valeur.name, message: valeur.message };
  }
  return valeur;
}

export function creerJournal(
  base: ChampsLog = {},
  ecrire: (ligne: string) => void = (ligne) => process.stdout.write(`${ligne}\n`),
): Journal {
  function emettre(niveau: NiveauLog, message: string, champs: ChampsLog = {}): void {
    const objet: ChampsLog = {
      horodatage: new Date().toISOString(),
      niveau,
      message,
    };
    for (const [cle, valeur] of Object.entries(base)) objet[cle] = normaliser(valeur);
    for (const [cle, valeur] of Object.entries(champs)) objet[cle] = normaliser(valeur);

    // Un journal qui lève masque l'incident qu'il devait révéler : on dégrade
    // plutôt que d'échouer, quitte à perdre les champs non sérialisables.
    let ligne: string;
    try {
      ligne = JSON.stringify(objet);
    } catch {
      ligne = JSON.stringify({
        horodatage: objet.horodatage,
        niveau,
        message,
        avertissement: "champs non sérialisables omis",
      });
    }
    ecrire(ligne);
  }

  return {
    debug: (m, c) => emettre("debug", m, c),
    info: (m, c) => emettre("info", m, c),
    warn: (m, c) => emettre("warn", m, c),
    error: (m, c) => emettre("error", m, c),
    enfant: (supplement) => creerJournal({ ...base, ...supplement }, ecrire),
  };
}

export const log: Journal = creerJournal();
```

- [ ] **Step 4 : Vérifier que le test passe**

Run: `pnpm test tests/lib/log.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5 : Remplacer les 11 appels `console.*`**

Repérer : `grep -rn "console\." src/ --include='*.ts' --include='*.tsx' | grep -v generated`

Pour chaque site, remplacer par `log.error` / `log.info` avec des champs nommés plutôt qu'une chaîne concaténée. Exemple, dans `src/app/api/webhook/gowa/route.ts` :

```ts
// avant
console.error("Payload de message invalide", analyse.error.issues);
// après
log.error("Payload de message invalide", { issues: analyse.error.issues, chemin: "/api/webhook/gowa" });
```

Et dans `src/gowa/client.ts` :

```ts
// avant
console.error(`Réponse GOWA hors schéma sur ${chemin} — écarts : ${details} — corps reçu : ${apercu}`);
// après
log.error("Réponse GOWA hors schéma", { chemin, ecarts: details, corps: apercu });
```

Les composants React (`"use client"`) n'utilisent pas ce journal : il écrit sur `process.stdout`, qui n'existe pas dans le navigateur. Aucun `console.*` ne subsiste côté serveur ; s'il en reste un côté client, le laisser.

- [ ] **Step 6 : Vérifier que toutes les suites restent vertes**

Run: `pnpm test` puis `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: PASS, sortie vierge.

Note : les tests qui espionnaient `console.error` (route webhook, route statut WhatsApp) doivent désormais espionner l'écriture du journal. Les adapter en injectant un journal de test plutôt qu'en espionnant `process.stdout`.

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "feat: journal structuré en JSON et remplacement des appels console"
```

---

### Task 2 : `mediaType` en énumération

**Files:**
- Modify: `prisma/schema.prisma`, `src/ingest/payload.ts`, `src/ingest/handler.ts`
- Create: `prisma/migrations/<timestamp>_media_type_enum/migration.sql` (généré)
- Test: `tests/ingest/payload.test.ts`, `tests/ingest/handler.int.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `enum MediaType { IMAGE VIDEO AUDIO DOCUMENT STICKER CONTACT LOCATION }` en base, et `detecterTypeMedia(payload: Record<string, unknown>): MediaType | null`.

**Pourquoi maintenant :** `NON_TEXT` est une valeur de `RiskCategory` et le Gate 1 devra rapprocher les deux. Une comparaison de chaîne libre contre une énumération est une source d'écart silencieux. La base de production ne contient que trois messages, tous à `mediaType` nul : la migration est gratuite aujourd'hui.

- [ ] **Step 1 : Écrire le test qui échoue**

Dans `tests/ingest/payload.test.ts`, ajouter :

```ts
import { MediaType } from "@/generated/prisma/client";

describe("detecterTypeMedia", () => {
  it("renvoie la valeur d'énumération correspondante", () => {
    expect(detecterTypeMedia({ audio: { url: "x" } })).toBe(MediaType.AUDIO);
    expect(detecterTypeMedia({ image: { url: "x" } })).toBe(MediaType.IMAGE);
    expect(detecterTypeMedia({ location: { lat: 1 } })).toBe(MediaType.LOCATION);
  });

  it("renvoie null pour un message purement textuel", () => {
    expect(detecterTypeMedia({ body: "coucou" })).toBeNull();
  });

  it("ignore une clé média à null (GOWA sérialise ainsi les absents)", () => {
    expect(detecterTypeMedia({ audio: null, body: "coucou" })).toBeNull();
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/ingest/payload.test.ts`
Expected: FAIL — `MediaType` n'existe pas dans le client généré.

- [ ] **Step 3 : Modifier le schéma**

Dans `prisma/schema.prisma`, ajouter l'énumération après `RiskCategory` :

```prisma
enum MediaType {
  IMAGE
  VIDEO
  AUDIO
  DOCUMENT
  STICKER
  CONTACT
  LOCATION
}
```

Et changer le champ du modèle `Message` :

```prisma
  mediaType   MediaType?
```

- [ ] **Step 4 : Générer la migration**

```bash
DATABASE_URL=postgres://wha:wha@127.0.0.1:5434/wha pnpm prisma migrate dev --name media_type_enum
```

Vérifier dans le SQL généré que la colonne est convertie et non supprimée puis recréée. Si Prisma propose une suppression de colonne, l'éditer pour un `USING` explicite :

```sql
ALTER TABLE "Message" ALTER COLUMN "mediaType" TYPE "MediaType" USING "mediaType"::"MediaType";
```

- [ ] **Step 5 : Implémenter**

`src/ingest/payload.ts` :

```ts
import { MediaType } from "@/generated/prisma/client";

const CLES_MEDIA: ReadonlyArray<readonly [string, MediaType]> = [
  ["image", MediaType.IMAGE],
  ["video", MediaType.VIDEO],
  ["audio", MediaType.AUDIO],
  ["document", MediaType.DOCUMENT],
  ["sticker", MediaType.STICKER],
  ["contact", MediaType.CONTACT],
  ["location", MediaType.LOCATION],
];

export function detecterTypeMedia(payload: Record<string, unknown>): MediaType | null {
  for (const [cle, type] of CLES_MEDIA) {
    if (payload[cle] !== undefined && payload[cle] !== null) return type;
  }
  return null;
}
```

`src/ingest/handler.ts` ne change pas : `mediaType: typeMedia` accepte désormais la valeur d'énumération.

- [ ] **Step 6 : Vérifier les deux suites**

Run: `pnpm test` puis `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: PASS.

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "feat: mediaType devient une énumération typée"
```

---

### Task 3 : Règles lexicales déterministes (Gate 1)

**Files:**
- Create: `src/decision/types.ts`, `src/decision/regles-lexicales.ts`
- Test: `tests/decision/regles-lexicales.test.ts`

**Interfaces:**
- Consumes: `RiskCategory` du client Prisma.
- Produces:
  - `type SignalRisque = { categorie: RiskCategory; regle: string }` dans `types.ts`
  - `function evaluerReglesLexicales(texte: string | null, typeMedia: MediaType | null): SignalRisque[]`

**Le point clé :** ces règles sont volontairement larges. Un faux positif coûte une escalade que l'utilisateur balaie d'un geste ; un faux négatif envoie un message qui l'engage. L'asymétrie commande la sensibilité.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/decision/regles-lexicales.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { evaluerReglesLexicales } from "@/decision/regles-lexicales";
import { MediaType, RiskCategory } from "@/generated/prisma/client";

function categories(texte: string | null, media: MediaType | null = null): RiskCategory[] {
  return evaluerReglesLexicales(texte, media).map((signal) => signal.categorie);
}

describe("règles lexicales", () => {
  it("repère un engagement dans une proposition de rendez-vous", () => {
    expect(categories("on se voit vendredi ?")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("tu es dispo demain soir")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("je passe te prendre à 19h")).toContain(RiskCategory.ENGAGEMENT);
  });

  it("repère une question factuelle sur l'utilisateur", () => {
    expect(categories("tu travailles où déjà ?")).toContain(RiskCategory.FACT);
    expect(categories("t'as quel âge")).toContain(RiskCategory.FACT);
  });

  it("repère l'émotionnel et le statut de la relation", () => {
    expect(categories("on est quoi tous les deux ?")).toContain(RiskCategory.EMOTIONAL);
    expect(categories("je t'aime")).toContain(RiskCategory.EMOTIONAL);
    expect(categories("tu me manques")).toContain(RiskCategory.EMOTIONAL);
  });

  it("repère l'argent", () => {
    expect(categories("tu peux m'envoyer 10000 ?")).toContain(RiskCategory.MONEY);
    expect(categories("j'ai besoin d'un prêt")).toContain(RiskCategory.MONEY);
  });

  it("repère une demande de photo", () => {
    expect(categories("envoie une photo de toi")).toContain(RiskCategory.INTIMATE);
  });

  it("classe tout message non textuel en NON_TEXT, quel que soit le texte", () => {
    expect(categories(null, MediaType.AUDIO)).toContain(RiskCategory.NON_TEXT);
    expect(categories("regarde", MediaType.IMAGE)).toContain(RiskCategory.NON_TEXT);
  });

  it("classe un message sans texte ni média en LOW_CONFIDENCE", () => {
    expect(categories(null, null)).toContain(RiskCategory.LOW_CONFIDENCE);
  });

  it("ne déclenche rien sur un échange anodin", () => {
    expect(categories("haha t'es fou")).toEqual([]);
    expect(categories("bonne nuit")).toEqual([]);
  });

  it("nomme la règle déclenchée, pour que le journal soit exploitable", () => {
    const signaux = evaluerReglesLexicales("on se voit vendredi ?", null);
    expect(signaux[0].regle).toMatch(/engagement/);
  });

  it("est insensible à la casse et aux accents manquants", () => {
    expect(categories("TU ES DISPO DEMAIN")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("je t aime")).toContain(RiskCategory.EMOTIONAL);
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/decision/regles-lexicales.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter**

`src/decision/types.ts` :

```ts
import type { RiskCategory } from "@/generated/prisma/client";

export type SignalRisque = {
  categorie: RiskCategory;
  regle: string;
};
```

`src/decision/regles-lexicales.ts` :

```ts
import { MediaType, RiskCategory } from "@/generated/prisma/client";
import type { SignalRisque } from "./types";

type Regle = {
  nom: string;
  categorie: RiskCategory;
  motif: RegExp;
};

// Normalisation : minuscules et accents retirés, pour qu'une règle écrite une
// fois attrape « à quelle heure », « a quelle heure » et « À QUELLE HEURE ».
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Ces motifs sont délibérément larges. Un faux positif coûte une escalade que
// l'utilisateur balaie d'un geste ; un faux négatif envoie un message qui
// l'engage. L'asymétrie commande la sensibilité.
const REGLES: readonly Regle[] = [
  { nom: "engagement.rendez-vous", categorie: RiskCategory.ENGAGEMENT, motif: /\b(on se voit|se voir|se retrouve|rendez[- ]?vous|rdv)\b/ },
  { nom: "engagement.disponibilite", categorie: RiskCategory.ENGAGEMENT, motif: /\b(dispo|disponible|libre)\b.*\b(demain|ce soir|week[- ]?end|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b|\b(demain|ce soir|week[- ]?end|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b.*\b(dispo|disponible|libre)\b/ },
  { nom: "engagement.horaire", categorie: RiskCategory.ENGAGEMENT, motif: /\b(a|vers|pour)\s*\d{1,2}\s*(h|heures?)\b|\bquelle heure\b/ },
  { nom: "engagement.invitation", categorie: RiskCategory.ENGAGEMENT, motif: /\b(je passe|tu passes|viens|je viens|chez toi|chez moi|je t'?emmene|je te prends)\b/ },
  { nom: "engagement.annulation", categorie: RiskCategory.ENGAGEMENT, motif: /\b(annule|annuler|decale|reporter|je peux plus)\b/ },

  { nom: "fait.identite", categorie: RiskCategory.FACT, motif: /\bt'?u? ?as quel age\b|\btu as quel age\b|\bquel age\b/ },
  { nom: "fait.travail", categorie: RiskCategory.FACT, motif: /\btu (travailles|bosses|fais quoi)\b|\bton (travail|boulot|job|metier)\b/ },
  { nom: "fait.lieu", categorie: RiskCategory.FACT, motif: /\btu (habites|vis|es) ou\b|\btu viens d'?ou\b/ },
  { nom: "fait.relation", categorie: RiskCategory.FACT, motif: /\btu es (celibataire|en couple|marie)\b|\btu as (une copine|quelqu'?un|des enfants)\b/ },

  { nom: "emotionnel.sentiments", categorie: RiskCategory.EMOTIONAL, motif: /\bje t'? ?aime\b|\btu me manques\b|\bje pense a toi\b|\bje tiens a toi\b/ },
  { nom: "emotionnel.statut", categorie: RiskCategory.EMOTIONAL, motif: /\bon est quoi\b|\bc'?est quoi nous\b|\bon sort ensemble\b|\btu ressens quoi\b|\bexclusi[fv]\b/ },
  { nom: "emotionnel.conflit", categorie: RiskCategory.EMOTIONAL, motif: /\b(dec[ue]|blesse|vexe|en colere|tu m'?ignores|tu reponds jamais|ca me fait mal)\b/ },
  { nom: "emotionnel.detresse", categorie: RiskCategory.EMOTIONAL, motif: /\b(je vais mal|deprime|j'?en peux plus|je suis triste|aide moi)\b/ },

  { nom: "argent.demande", categorie: RiskCategory.MONEY, motif: /\b(envoie|envoyer|preter|prete|donne)\b.*\b\d{3,}\b|\b\d{3,}\s*(f|fcfa|euros?|balles)\b/ },
  { nom: "argent.vocabulaire", categorie: RiskCategory.MONEY, motif: /\b(pret|credit|dette|rembourse|virement|mobile money|wave|orange money)\b|\bbesoin d'?argent\b/ },

  { nom: "intime.photo", categorie: RiskCategory.INTIMATE, motif: /\b(envoie|montre|tu m'?envoies)\b.*\b(photo|pic|nude|image de toi)\b|\bphoto de toi\b/ },
  { nom: "intime.explicite", categorie: RiskCategory.INTIMATE, motif: /\b(nue?|nudes?|sexe|coucher ensemble|au lit avec)\b/ },

  { nom: "tiers.personne-nommee", categorie: RiskCategory.THIRD_PARTY, motif: /\b(ta|ton|sa|son) (copine|copain|femme|mari|ex|soeur|frere|mere|pere)\b/ },
];

export function evaluerReglesLexicales(
  texte: string | null,
  typeMedia: MediaType | null,
): SignalRisque[] {
  const signaux: SignalRisque[] = [];

  // Un média n'est pas lisible par le classifieur : il escalade toujours.
  if (typeMedia !== null) {
    signaux.push({ categorie: RiskCategory.NON_TEXT, regle: `media.${typeMedia.toLowerCase()}` });
  }

  const contenu = texte?.trim() ?? "";
  if (contenu === "") {
    if (typeMedia === null) {
      signaux.push({ categorie: RiskCategory.LOW_CONFIDENCE, regle: "contenu.vide" });
    }
    return signaux;
  }

  const normalise = normaliser(contenu);
  for (const regle of REGLES) {
    if (regle.motif.test(normalise)) {
      signaux.push({ categorie: regle.categorie, regle: regle.nom });
    }
  }
  return signaux;
}
```

- [ ] **Step 4 : Vérifier que le test passe**

Run: `pnpm test tests/decision/regles-lexicales.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "feat: règles lexicales déterministes du Gate 1"
```

---

### Task 4 : Registre des fournisseurs et résolution de route

**Files:**
- Create: `src/ia/fournisseurs.ts`, `src/ia/registre.ts`
- Test: `tests/ia/registre.int.test.ts`

**Interfaces:**
- Consumes: `prisma`, `decryptSecret` de `@/lib/crypto`, `getEnv()`.
- Produces:
  - `type RoleIA = "classify" | "compose" | "profile" | "summarize"`
  - `type EntreeRoute = { providerId: string; nom: string; kind: ProviderKind; model: string; baseUrl: string | null; apiKey: string | null }`
  - `function resoudreRoute(role: RoleIA, options?: { contactId?: string }): Promise<EntreeRoute[]>`
  - `function modelePour(entree: EntreeRoute): LanguageModel` dans `fournisseurs.ts`

- [ ] **Step 1 : Installer les dépendances**

```bash
pnpm add ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google @ai-sdk/openai-compatible
```

- [ ] **Step 2 : Écrire le test d'intégration qui échoue**

`tests/ia/registre.int.test.ts` :

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { resoudreRoute } from "@/ia/registre";

const CLE = "a".repeat(64); // identique à MASTER_KEY dans tests/int-setup.ts

async function reset() {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ProviderRoute", "ProviderConfig" CASCADE');
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ContactPolicy", "Contact" CASCADE');
}

describe("résolution de route IA", () => {
  beforeEach(reset);

  it("renvoie les entrées de la route par défaut, dans l'ordre", async () => {
    const a = await prisma.providerConfig.create({
      data: { name: "anthropic", kind: "ANTHROPIC", apiKeyEncrypted: encryptSecret("k-a", CLE) },
    });
    const b = await prisma.providerConfig.create({
      data: { name: "openrouter", kind: "OPENAI_COMPATIBLE", baseUrl: "https://openrouter.ai/api/v1", apiKeyEncrypted: encryptSecret("k-b", CLE) },
    });
    await prisma.providerRoute.create({
      data: {
        name: "defaut",
        isDefault: true,
        entries: { classify: [{ providerId: a.id, model: "m1" }, { providerId: b.id, model: "m2" }] },
      },
    });

    const entrees = await resoudreRoute("classify");
    expect(entrees.map((e) => e.model)).toEqual(["m1", "m2"]);
    expect(entrees[0].apiKey).toBe("k-a");
    expect(entrees[1].baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("préfère la route du contact à la route par défaut", async () => {
    const p = await prisma.providerConfig.create({
      data: { name: "ollama", kind: "OLLAMA", baseUrl: "http://ollama:11434/v1" },
    });
    await prisma.providerRoute.create({
      data: { name: "defaut", isDefault: true, entries: { classify: [{ providerId: p.id, model: "defaut" }] } },
    });
    const routeContact = await prisma.providerRoute.create({
      data: { name: "permissif", entries: { classify: [{ providerId: p.id, model: "special" }] } },
    });
    const contact = await prisma.contact.create({
      data: { jid: "225@s.whatsapp.net", policy: { create: { providerRouteId: routeContact.id } } },
    });

    const entrees = await resoudreRoute("classify", { contactId: contact.id });
    expect(entrees[0].model).toBe("special");
  });

  it("ignore les fournisseurs désactivés", async () => {
    const actif = await prisma.providerConfig.create({ data: { name: "a", kind: "OLLAMA", baseUrl: "http://x/v1" } });
    const inactif = await prisma.providerConfig.create({ data: { name: "b", kind: "OLLAMA", baseUrl: "http://y/v1", enabled: false } });
    await prisma.providerRoute.create({
      data: {
        name: "defaut",
        isDefault: true,
        entries: { classify: [{ providerId: inactif.id, model: "non" }, { providerId: actif.id, model: "oui" }] },
      },
    });
    const entrees = await resoudreRoute("classify");
    expect(entrees.map((e) => e.model)).toEqual(["oui"]);
  });

  it("renvoie une liste vide quand aucune route n'existe, sans lever", async () => {
    await expect(resoudreRoute("classify")).resolves.toEqual([]);
  });

  it("ne renvoie jamais la clé chiffrée telle quelle", async () => {
    const p = await prisma.providerConfig.create({
      data: { name: "a", kind: "ANTHROPIC", apiKeyEncrypted: encryptSecret("secret-clair", CLE) },
    });
    await prisma.providerRoute.create({
      data: { name: "defaut", isDefault: true, entries: { classify: [{ providerId: p.id, model: "m" }] } },
    });
    const entrees = await resoudreRoute("classify");
    expect(entrees[0].apiKey).toBe("secret-clair");
    expect(JSON.stringify(entrees)).not.toContain(".");
  });
});
```

- [ ] **Step 3 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: FAIL — `@/ia/registre` introuvable.

- [ ] **Step 4 : Implémenter la fabrique de modèles**

`src/ia/fournisseurs.ts` :

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { ProviderKind } from "@/generated/prisma/client";
import type { EntreeRoute } from "./registre";

export class FournisseurInvalideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FournisseurInvalideError";
  }
}

export function modelePour(entree: EntreeRoute): LanguageModel {
  switch (entree.kind) {
    case ProviderKind.ANTHROPIC:
      if (!entree.apiKey) throw new FournisseurInvalideError(`Clé absente pour ${entree.nom}`);
      return createAnthropic({ apiKey: entree.apiKey })(entree.model);

    case ProviderKind.OPENAI:
      if (!entree.apiKey) throw new FournisseurInvalideError(`Clé absente pour ${entree.nom}`);
      return createOpenAI({ apiKey: entree.apiKey })(entree.model);

    case ProviderKind.GOOGLE:
      if (!entree.apiKey) throw new FournisseurInvalideError(`Clé absente pour ${entree.nom}`);
      return createGoogleGenerativeAI({ apiKey: entree.apiKey })(entree.model);

    // OpenRouter, Kimi/Moonshot et tout service compatible OpenAI passent ici :
    // ajouter un fournisseur de cette famille ne demande qu'une ligne en base.
    case ProviderKind.OPENAI_COMPATIBLE:
      if (!entree.baseUrl) throw new FournisseurInvalideError(`baseUrl absente pour ${entree.nom}`);
      return createOpenAICompatible({
        name: entree.nom,
        baseURL: entree.baseUrl,
        apiKey: entree.apiKey ?? undefined,
      })(entree.model);

    // Ollama sert en local sans clé.
    case ProviderKind.OLLAMA:
      if (!entree.baseUrl) throw new FournisseurInvalideError(`baseUrl absente pour ${entree.nom}`);
      return createOpenAICompatible({
        name: entree.nom,
        baseURL: entree.baseUrl,
        apiKey: "ollama",
      })(entree.model);
  }
}
```

- [ ] **Step 5 : Implémenter le registre**

`src/ia/registre.ts` :

```ts
import { z } from "zod";
import type { ProviderKind } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { getEnv } from "@/config/env";
import { log } from "@/lib/log";

export type RoleIA = "classify" | "compose" | "profile" | "summarize";

export type EntreeRoute = {
  providerId: string;
  nom: string;
  kind: ProviderKind;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
};

const entreesSchema = z.record(
  z.string(),
  z.array(z.object({ providerId: z.string(), model: z.string() })),
);

async function entreesDeLaRoute(routeId: string | null, role: RoleIA) {
  const route = routeId
    ? await prisma.providerRoute.findUnique({ where: { id: routeId } })
    : await prisma.providerRoute.findFirst({ where: { isDefault: true } });
  if (!route) return [];

  const analyse = entreesSchema.safeParse(route.entries);
  if (!analyse.success) {
    log.error("Route IA au format invalide", { routeId: route.id, issues: analyse.error.issues });
    return [];
  }
  return analyse.data[role] ?? [];
}

export async function resoudreRoute(
  role: RoleIA,
  options: { contactId?: string } = {},
): Promise<EntreeRoute[]> {
  let routeId: string | null = null;

  if (options.contactId) {
    const politique = await prisma.contactPolicy.findUnique({
      where: { contactId: options.contactId },
      select: { providerRouteId: true },
    });
    routeId = politique?.providerRouteId ?? null;
  }

  let brutes = await entreesDeLaRoute(routeId, role);
  // Repli sur la route par défaut si la route du contact ne couvre pas ce rôle.
  if (brutes.length === 0 && routeId !== null) {
    brutes = await entreesDeLaRoute(null, role);
  }
  if (brutes.length === 0) return [];

  const fournisseurs = await prisma.providerConfig.findMany({
    where: { id: { in: brutes.map((e) => e.providerId) }, enabled: true },
  });
  const parId = new Map(fournisseurs.map((f) => [f.id, f]));
  const masterKey = getEnv().MASTER_KEY;

  const entrees: EntreeRoute[] = [];
  for (const brute of brutes) {
    const fournisseur = parId.get(brute.providerId);
    if (!fournisseur) continue;

    let apiKey: string | null = null;
    if (fournisseur.apiKeyEncrypted) {
      try {
        apiKey = decryptSecret(fournisseur.apiKeyEncrypted, masterKey);
      } catch {
        // Une clé indéchiffrable signifie presque toujours une MASTER_KEY
        // changée. On saute l'entrée plutôt que d'échouer : la cascade de repli
        // existe précisément pour ça.
        log.error("Clé de fournisseur indéchiffrable, entrée ignorée", { fournisseur: fournisseur.name });
        continue;
      }
    }

    entrees.push({
      providerId: fournisseur.id,
      nom: fournisseur.name,
      kind: fournisseur.kind,
      model: brute.model,
      baseUrl: fournisseur.baseUrl,
      apiKey,
    });
  }
  return entrees;
}
```

- [ ] **Step 6 : Vérifier que le test passe**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: PASS (5 nouveaux tests).

- [ ] **Step 7 : Commit**

```bash
git add -A
git commit -m "feat: registre des fournisseurs IA et résolution de route"
```

---

### Task 5 : Appel IA avec repli en cascade

**Files:**
- Create: `src/ia/appel.ts`
- Test: `tests/ia/appel.test.ts`

**Interfaces:**
- Consumes: `resoudreRoute`, `modelePour`, `EntreeRoute`, `RoleIA`.
- Produces:
  - `class AucunFournisseurError extends Error`
  - `type ResultatIA<T> = { valeur: T; fournisseur: string; model: string; latencyMs: number; costUsd: number | null }`
  - `function appelerStructure<T>(params: { role: RoleIA; contactId?: string; schema: z.ZodType<T>; systeme: string; invite: string; entrees?: EntreeRoute[]; generer?: GenererObjet }): Promise<ResultatIA<T>>`
  - `type GenererObjet` = la signature injectable de `generateObject`, pour tester sans réseau.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/ia/appel.test.ts` :

```ts
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { appelerStructure, AucunFournisseurError } from "@/ia/appel";
import type { EntreeRoute } from "@/ia/registre";

const schema = z.object({ risks: z.array(z.string()) });

function entree(nom: string, model: string): EntreeRoute {
  return { providerId: nom, nom, kind: "OLLAMA", model, baseUrl: "http://x/v1", apiKey: null };
}

describe("appel IA avec repli", () => {
  it("renvoie la valeur du premier fournisseur qui répond", async () => {
    const generer = vi.fn().mockResolvedValue({ object: { risks: ["ENGAGEMENT"] }, usage: {} });
    const resultat = await appelerStructure({
      role: "classify",
      schema,
      systeme: "s",
      invite: "i",
      entrees: [entree("a", "m1"), entree("b", "m2")],
      generer,
    });
    expect(resultat.valeur.risks).toEqual(["ENGAGEMENT"]);
    expect(resultat.fournisseur).toBe("a");
    expect(generer).toHaveBeenCalledTimes(1);
  });

  it("réessaie deux fois la même entrée avant de basculer", async () => {
    const generer = vi
      .fn()
      .mockRejectedValueOnce(new Error("429"))
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValue({ object: { risks: [] }, usage: {} });
    const resultat = await appelerStructure({
      role: "classify",
      schema,
      systeme: "s",
      invite: "i",
      entrees: [entree("a", "m1"), entree("b", "m2")],
      generer,
    });
    expect(generer).toHaveBeenCalledTimes(3);
    expect(resultat.fournisseur).toBe("b");
  });

  it("lève AucunFournisseurError quand la cascade est épuisée", async () => {
    const generer = vi.fn().mockRejectedValue(new Error("panne"));
    await expect(
      appelerStructure({ role: "classify", schema, systeme: "s", invite: "i", entrees: [entree("a", "m1")], generer }),
    ).rejects.toBeInstanceOf(AucunFournisseurError);
    expect(generer).toHaveBeenCalledTimes(2);
  });

  it("lève AucunFournisseurError quand aucune entrée n'est configurée", async () => {
    const generer = vi.fn();
    await expect(
      appelerStructure({ role: "classify", schema, systeme: "s", invite: "i", entrees: [], generer }),
    ).rejects.toBeInstanceOf(AucunFournisseurError);
    expect(generer).not.toHaveBeenCalled();
  });

  it("mesure la latence et remonte le fournisseur retenu", async () => {
    const generer = vi.fn().mockResolvedValue({ object: { risks: [] }, usage: {} });
    const resultat = await appelerStructure({
      role: "classify",
      schema,
      systeme: "s",
      invite: "i",
      entrees: [entree("a", "m1")],
      generer,
    });
    expect(resultat.latencyMs).toBeGreaterThanOrEqual(0);
    expect(resultat.model).toBe("m1");
  });

  it("ne laisse jamais une clé d'API apparaître dans le message d'erreur", async () => {
    const avecCle: EntreeRoute = { ...entree("a", "m1"), apiKey: "sk-tres-secret" };
    const generer = vi.fn().mockRejectedValue(new Error("échec avec sk-tres-secret dans le message"));
    const erreur = await appelerStructure({
      role: "classify",
      schema,
      systeme: "s",
      invite: "i",
      entrees: [avecCle],
      generer,
    }).catch((e: unknown) => e as Error);
    expect(erreur.message).not.toContain("sk-tres-secret");
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/ia/appel.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter**

`src/ia/appel.ts` :

```ts
import { generateObject } from "ai";
import type { z } from "zod";
import { log } from "@/lib/log";
import { modelePour } from "./fournisseurs";
import { resoudreRoute, type EntreeRoute, type RoleIA } from "./registre";

export class AucunFournisseurError extends Error {
  constructor(role: RoleIA, tentatives: number) {
    super(`Aucun fournisseur IA n'a répondu pour le rôle ${role} (${tentatives} tentatives)`);
    this.name = "AucunFournisseurError";
  }
}

export type ResultatIA<T> = {
  valeur: T;
  fournisseur: string;
  model: string;
  latencyMs: number;
  costUsd: number | null;
};

export type GenererObjet = typeof generateObject;

const TENTATIVES_PAR_ENTREE = 2;

// Une clé d'API peut se retrouver dans le message d'erreur d'un SDK. On la
// retire avant toute journalisation ou propagation.
function assainir(message: string, entrees: EntreeRoute[]): string {
  let propre = message;
  for (const entree of entrees) {
    if (entree.apiKey) propre = propre.split(entree.apiKey).join("[clé masquée]");
  }
  return propre;
}

export async function appelerStructure<T>(params: {
  role: RoleIA;
  contactId?: string;
  schema: z.ZodType<T>;
  systeme: string;
  invite: string;
  entrees?: EntreeRoute[];
  generer?: GenererObjet;
}): Promise<ResultatIA<T>> {
  const generer = params.generer ?? generateObject;
  const entrees = params.entrees ?? (await resoudreRoute(params.role, { contactId: params.contactId }));

  if (entrees.length === 0) {
    throw new AucunFournisseurError(params.role, 0);
  }

  let tentatives = 0;
  for (const entree of entrees) {
    for (let essai = 1; essai <= TENTATIVES_PAR_ENTREE; essai++) {
      tentatives++;
      const debut = Date.now();
      try {
        const reponse = await generer({
          model: modelePour(entree),
          schema: params.schema,
          system: params.systeme,
          prompt: params.invite,
        } as Parameters<GenererObjet>[0]);

        return {
          valeur: reponse.object as T,
          fournisseur: entree.nom,
          model: entree.model,
          latencyMs: Date.now() - debut,
          costUsd: null,
        };
      } catch (erreur) {
        const message = assainir(erreur instanceof Error ? erreur.message : String(erreur), entrees);
        log.warn("Échec d'un fournisseur IA", {
          role: params.role,
          fournisseur: entree.nom,
          model: entree.model,
          essai,
          erreur: message,
        });
      }
    }
  }

  throw new AucunFournisseurError(params.role, tentatives);
}
```

- [ ] **Step 4 : Vérifier que le test passe**

Run: `pnpm test tests/ia/appel.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "feat: appel IA structuré avec repli en cascade"
```

---

### Task 6 : Classifieur de risque (Gate 2)

**Files:**
- Create: `src/decision/classifieur.ts`
- Test: `tests/decision/classifieur.test.ts`

**Interfaces:**
- Consumes: `appelerStructure`, `SignalRisque`, `RiskCategory`.
- Produces:
  - `type ResultatClassification = { signaux: SignalRisque[]; confiance: number; motif: string; fournisseur: string | null; latencyMs: number | null }`
  - `function classifier(params: { texte: string; contactId?: string; appeler?: typeof appelerStructure }): Promise<ResultatClassification>`

**Le point clé (P2) :** un échec du classifieur ne fait pas échouer la décision. Il renvoie `LOW_CONFIDENCE`, qui est un garde-fou toujours actif et provoque donc une escalade. Le système se tait plutôt que de deviner.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/decision/classifieur.test.ts` :

```ts
import { describe, it, expect, vi } from "vitest";
import { classifier } from "@/decision/classifieur";
import { AucunFournisseurError } from "@/ia/appel";
import { RiskCategory } from "@/generated/prisma/client";

describe("classifieur de risque", () => {
  it("convertit les catégories renvoyées en signaux", async () => {
    const appeler = vi.fn().mockResolvedValue({
      valeur: { risks: ["ENGAGEMENT", "FACT"], confidence: 0.9, rationale: "propose un rendez-vous" },
      fournisseur: "anthropic",
      model: "m",
      latencyMs: 120,
      costUsd: null,
    });
    const resultat = await classifier({ texte: "on se voit vendredi ?", appeler });
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.ENGAGEMENT, RiskCategory.FACT]);
    expect(resultat.fournisseur).toBe("anthropic");
    expect(resultat.latencyMs).toBe(120);
  });

  it("ajoute LOW_CONFIDENCE quand la confiance est sous le seuil", async () => {
    const appeler = vi.fn().mockResolvedValue({
      valeur: { risks: [], confidence: 0.4, rationale: "incertain" },
      fournisseur: "a", model: "m", latencyMs: 10, costUsd: null,
    });
    const resultat = await classifier({ texte: "hmm", appeler });
    expect(resultat.signaux.map((s) => s.categorie)).toContain(RiskCategory.LOW_CONFIDENCE);
  });

  it("ignore une catégorie inconnue plutôt que de lever", async () => {
    const appeler = vi.fn().mockResolvedValue({
      valeur: { risks: ["ENGAGEMENT", "CATEGORIE_INVENTEE"], confidence: 0.9, rationale: "x" },
      fournisseur: "a", model: "m", latencyMs: 10, costUsd: null,
    });
    const resultat = await classifier({ texte: "x", appeler });
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.ENGAGEMENT]);
  });

  it("renvoie LOW_CONFIDENCE quand aucun fournisseur ne répond (P2 fail-closed)", async () => {
    const appeler = vi.fn().mockRejectedValue(new AucunFournisseurError("classify", 4));
    const resultat = await classifier({ texte: "on se voit vendredi ?", appeler });
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.LOW_CONFIDENCE]);
    expect(resultat.fournisseur).toBeNull();
    expect(resultat.motif).toMatch(/indisponible/i);
  });

  it("renvoie LOW_CONFIDENCE sur n'importe quelle exception, sans la propager", async () => {
    const appeler = vi.fn().mockRejectedValue(new TypeError("cassé"));
    await expect(classifier({ texte: "x", appeler })).resolves.toMatchObject({
      signaux: [{ categorie: RiskCategory.LOW_CONFIDENCE }],
    });
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/decision/classifieur.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Implémenter**

`src/decision/classifieur.ts` :

```ts
import { z } from "zod";
import { RiskCategory } from "@/generated/prisma/client";
import { appelerStructure } from "@/ia/appel";
import { log } from "@/lib/log";
import type { SignalRisque } from "./types";

const SEUIL_CONFIANCE = 0.6;

const CATEGORIES_CLASSIFIABLES = [
  RiskCategory.ENGAGEMENT,
  RiskCategory.FACT,
  RiskCategory.EMOTIONAL,
  RiskCategory.MONEY,
  RiskCategory.INTIMATE,
  RiskCategory.THIRD_PARTY,
] as const;

const sortieSchema = z.object({
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});

const SYSTEME = `Tu classes des messages WhatsApp reçus par un utilisateur francophone.
Tu ne réponds jamais au message : tu le classes.

Catégories :
- ENGAGEMENT : rendez-vous, horaires, lieux, invitations, annulations, promesses.
- FACT : question factuelle sur l'utilisateur (travail, âge, lieu, disponibilité, autres relations).
- EMOTIONAL : sentiments, statut de la relation, conflit, reproche, détresse.
- MONEY : argent, cadeaux, transactions.
- INTIMATE : contenu sexuel explicite, demande de photo.
- THIRD_PARTY : une tierce personne nommée est impliquée.

Renvoie toutes les catégories qui s'appliquent, éventuellement aucune.
"confidence" exprime ta certitude globale, entre 0 et 1.
"rationale" est une phrase courte en français.`;

export type ResultatClassification = {
  signaux: SignalRisque[];
  confiance: number;
  motif: string;
  fournisseur: string | null;
  latencyMs: number | null;
};

function replierEnIncertitude(motif: string): ResultatClassification {
  return {
    signaux: [{ categorie: RiskCategory.LOW_CONFIDENCE, regle: "classifieur.indisponible" }],
    confiance: 0,
    motif,
    fournisseur: null,
    latencyMs: null,
  };
}

export async function classifier(params: {
  texte: string;
  contactId?: string;
  appeler?: typeof appelerStructure;
}): Promise<ResultatClassification> {
  const appeler = params.appeler ?? appelerStructure;

  try {
    const resultat = await appeler({
      role: "classify",
      contactId: params.contactId,
      schema: sortieSchema,
      systeme: SYSTEME,
      invite: params.texte,
    });

    const connues = new Set<string>(CATEGORIES_CLASSIFIABLES);
    const signaux: SignalRisque[] = resultat.valeur.risks
      .filter((brute) => connues.has(brute))
      .map((brute) => ({ categorie: brute as RiskCategory, regle: "classifieur" }));

    if (resultat.valeur.confidence < SEUIL_CONFIANCE) {
      signaux.push({ categorie: RiskCategory.LOW_CONFIDENCE, regle: "classifieur.confiance-basse" });
    }

    return {
      signaux,
      confiance: resultat.valeur.confidence,
      motif: resultat.valeur.rationale,
      fournisseur: resultat.fournisseur,
      latencyMs: resultat.latencyMs,
    };
  } catch (erreur) {
    // P2 : un classifieur indisponible ne fait pas échouer la décision, il la
    // rend incertaine. LOW_CONFIDENCE est un garde-fou toujours actif, donc
    // cette branche produit une escalade — le système se tait plutôt que de
    // deviner.
    log.error("Classifieur indisponible, repli en incertitude", {
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
    return replierEnIncertitude("Classifieur indisponible : escalade par précaution.");
  }
}
```

- [ ] **Step 4 : Vérifier que le test passe**

Run: `pnpm test tests/decision/classifieur.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5 : Commit**

```bash
git add -A
git commit -m "feat: classifieur de risque avec repli fail-closed"
```

---

### Task 7 : Moteur de décision (Gates 0 et 3, table de décision)

**Files:**
- Modify: `src/decision/types.ts`
- Create: `src/decision/moteur.ts`
- Test: `tests/decision/moteur.test.ts`

**Interfaces:**
- Consumes: `SignalRisque`, `ContactMode`, `DecisionOutcome`, `RiskCategory`.
- Produces, dans `types.ts` :
  - `type GardeFous = { engagement: boolean; facts: boolean; emotional: boolean; money: boolean; intimate: boolean; thirdParty: boolean }`
  - `type ContexteDecision = { mode: ContactMode; pauseGlobale: boolean; gardeFous: GardeFous; intimateOverride: boolean; isAdult: boolean; signaux: SignalRisque[]; autoStreak: number; maxAutoStreak: number; escaladeOuverte: boolean; dernierEchangeIlYaJours: number | null; classifieurDisponible: boolean }`
  - `type Verdict = { issue: DecisionOutcome; regle: string; risques: RiskCategory[] }`
- Et dans `moteur.ts` : `function decider(contexte: ContexteDecision): Verdict`

**Cette fonction est pure.** Aucune entrée/sortie, aucun appel réseau, aucun accès base. C'est ce qui la rend exhaustivement testable, et c'est là que vivent les principes.

- [ ] **Step 1 : Écrire le test qui échoue**

`tests/decision/moteur.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { decider } from "@/decision/moteur";
import type { ContexteDecision } from "@/decision/types";
import { ContactMode, DecisionOutcome, RiskCategory } from "@/generated/prisma/client";

function contexte(surcharge: Partial<ContexteDecision> = {}): ContexteDecision {
  return {
    mode: ContactMode.AUTO,
    pauseGlobale: false,
    gardeFous: { engagement: true, facts: true, emotional: true, money: true, intimate: true, thirdParty: true },
    intimateOverride: false,
    isAdult: false,
    signaux: [],
    autoStreak: 0,
    maxAutoStreak: 6,
    escaladeOuverte: false,
    dernierEchangeIlYaJours: 0,
    classifieurDisponible: true,
    ...surcharge,
  };
}

describe("moteur de décision", () => {
  it("ignore un contact en OFF, même avec des risques (P1)", () => {
    const verdict = decider(contexte({
      mode: ContactMode.OFF,
      signaux: [{ categorie: RiskCategory.ENGAGEMENT, regle: "r" }],
    }));
    expect(verdict.issue).toBe(DecisionOutcome.IGNORED);
    expect(verdict.regle).toMatch(/opt-in|mode/i);
  });

  it("ignore tout quand la pause globale est active", () => {
    expect(decider(contexte({ pauseGlobale: true })).issue).toBe(DecisionOutcome.IGNORED);
  });

  it("escalade quand un risque croise un garde-fou actif", () => {
    const verdict = decider(contexte({ signaux: [{ categorie: RiskCategory.MONEY, regle: "argent.demande" }] }));
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
    expect(verdict.risques).toContain(RiskCategory.MONEY);
  });

  it("n'escalade pas sur une catégorie dont le garde-fou est désactivé", () => {
    const verdict = decider(contexte({
      gardeFous: { engagement: false, facts: true, emotional: true, money: true, intimate: true, thirdParty: true },
      signaux: [{ categorie: RiskCategory.ENGAGEMENT, regle: "r" }],
    }));
    expect(verdict.issue).toBe(DecisionOutcome.AUTO_SENT);
  });

  it("lève INTIMATE seulement si l'override est actif ET le contact marqué adulte", () => {
    const signaux = [{ categorie: RiskCategory.INTIMATE, regle: "r" }];
    expect(decider(contexte({ signaux, intimateOverride: true, isAdult: false })).issue)
      .toBe(DecisionOutcome.ESCALATED);
    expect(decider(contexte({ signaux, intimateOverride: true, isAdult: true })).issue)
      .toBe(DecisionOutcome.AUTO_SENT);
  });

  it("escalade toujours sur LOW_CONFIDENCE, garde-fou non désactivable", () => {
    const verdict = decider(contexte({
      gardeFous: { engagement: false, facts: false, emotional: false, money: false, intimate: false, thirdParty: false },
      signaux: [{ categorie: RiskCategory.LOW_CONFIDENCE, regle: "r" }],
    }));
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
  });

  it("escalade toujours sur NON_TEXT, garde-fou non désactivable", () => {
    const verdict = decider(contexte({
      gardeFous: { engagement: false, facts: false, emotional: false, money: false, intimate: false, thirdParty: false },
      signaux: [{ categorie: RiskCategory.NON_TEXT, regle: "media.audio" }],
    }));
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
  });

  it("escalade quand le streak automatique dépasse le plafond", () => {
    const verdict = decider(contexte({ autoStreak: 6, maxAutoStreak: 6 }));
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
    expect(verdict.regle).toMatch(/streak/);
  });

  it("escalade quand une escalade est déjà ouverte sur le fil", () => {
    expect(decider(contexte({ escaladeOuverte: true })).issue).toBe(DecisionOutcome.ESCALATED);
  });

  it("escalade quand la conversation est dormante depuis plus de 7 jours", () => {
    expect(decider(contexte({ dernierEchangeIlYaJours: 8 })).issue).toBe(DecisionOutcome.ESCALATED);
    expect(decider(contexte({ dernierEchangeIlYaJours: 7 })).issue).toBe(DecisionOutcome.AUTO_SENT);
  });

  it("escalade quand le classifieur est indisponible", () => {
    expect(decider(contexte({ classifieurDisponible: false })).issue).toBe(DecisionOutcome.ESCALATED);
  });

  it("produit un brouillon en mode DRAFT plutôt qu'un envoi", () => {
    expect(decider(contexte({ mode: ContactMode.DRAFT })).issue).toBe(DecisionOutcome.DRAFTED);
  });

  it("autorise l'envoi seulement quand tout est calme et le mode AUTO", () => {
    expect(decider(contexte()).issue).toBe(DecisionOutcome.AUTO_SENT);
  });

  it("nomme toujours la règle qui a tranché", () => {
    expect(decider(contexte()).regle).not.toBe("");
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `pnpm test tests/decision/moteur.test.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3 : Étendre les types**

Ajouter dans `src/decision/types.ts` :

```ts
import type { ContactMode, DecisionOutcome, RiskCategory } from "@/generated/prisma/client";

export type GardeFous = {
  engagement: boolean;
  facts: boolean;
  emotional: boolean;
  money: boolean;
  intimate: boolean;
  thirdParty: boolean;
};

export type ContexteDecision = {
  mode: ContactMode;
  pauseGlobale: boolean;
  gardeFous: GardeFous;
  intimateOverride: boolean;
  isAdult: boolean;
  signaux: SignalRisque[];
  autoStreak: number;
  maxAutoStreak: number;
  escaladeOuverte: boolean;
  dernierEchangeIlYaJours: number | null;
  classifieurDisponible: boolean;
};

export type Verdict = {
  issue: DecisionOutcome;
  regle: string;
  risques: RiskCategory[];
};
```

- [ ] **Step 4 : Implémenter**

`src/decision/moteur.ts` :

```ts
import { ContactMode, DecisionOutcome, RiskCategory } from "@/generated/prisma/client";
import type { ContexteDecision, GardeFous, Verdict } from "./types";

const JOURS_AVANT_DORMANCE = 7;

// LOW_CONFIDENCE et NON_TEXT ne sont rattachés à aucun drapeau : ils ne sont
// désactivables nulle part, par construction.
const TOUJOURS_ACTIFS: ReadonlySet<RiskCategory> = new Set([
  RiskCategory.LOW_CONFIDENCE,
  RiskCategory.NON_TEXT,
]);

function gardeFouActif(categorie: RiskCategory, contexte: ContexteDecision): boolean {
  if (TOUJOURS_ACTIFS.has(categorie)) return true;

  const drapeaux: Record<string, keyof GardeFous> = {
    [RiskCategory.ENGAGEMENT]: "engagement",
    [RiskCategory.FACT]: "facts",
    [RiskCategory.EMOTIONAL]: "emotional",
    [RiskCategory.MONEY]: "money",
    [RiskCategory.INTIMATE]: "intimate",
    [RiskCategory.THIRD_PARTY]: "thirdParty",
  };

  if (categorie === RiskCategory.INTIMATE) {
    // La dérogation ne vaut que si le contact est explicitement marqué adulte.
    // Le marquage est vérifié ici en plus de la base : une incohérence de
    // données ne doit pas ouvrir la porte.
    if (contexte.intimateOverride && contexte.isAdult) return false;
    return contexte.gardeFous.intimate;
  }

  const drapeau = drapeaux[categorie];
  return drapeau ? contexte.gardeFous[drapeau] : true;
}

export function decider(contexte: ContexteDecision): Verdict {
  const risques = contexte.signaux.map((signal) => signal.categorie);

  // Gate 0 — P1. Avant tout le reste.
  if (contexte.mode === ContactMode.OFF) {
    return { issue: DecisionOutcome.IGNORED, regle: "gate0.contact-non-active", risques };
  }
  if (contexte.pauseGlobale) {
    return { issue: DecisionOutcome.IGNORED, regle: "gate0.pause-globale", risques };
  }

  // Risques croisant un garde-fou actif.
  const declencheur = contexte.signaux.find((signal) => gardeFouActif(signal.categorie, contexte));
  if (declencheur) {
    return {
      issue: DecisionOutcome.ESCALATED,
      regle: `risque.${declencheur.regle}`,
      risques,
    };
  }

  // Gate 3 — quotas et contexte.
  if (!contexte.classifieurDisponible) {
    return { issue: DecisionOutcome.ESCALATED, regle: "gate3.classifieur-indisponible", risques };
  }
  if (contexte.escaladeOuverte) {
    return { issue: DecisionOutcome.ESCALATED, regle: "gate3.escalade-ouverte", risques };
  }
  if (contexte.autoStreak >= contexte.maxAutoStreak) {
    return { issue: DecisionOutcome.ESCALATED, regle: "gate3.streak-plafond", risques };
  }
  if (
    contexte.dernierEchangeIlYaJours !== null &&
    contexte.dernierEchangeIlYaJours > JOURS_AVANT_DORMANCE
  ) {
    return { issue: DecisionOutcome.ESCALATED, regle: "gate3.conversation-dormante", risques };
  }

  if (contexte.mode === ContactMode.AUTO) {
    return { issue: DecisionOutcome.AUTO_SENT, regle: "table.auto", risques };
  }
  return { issue: DecisionOutcome.DRAFTED, regle: "table.brouillon", risques };
}
```

- [ ] **Step 5 : Vérifier que le test passe**

Run: `pnpm test tests/decision/moteur.test.ts`
Expected: PASS (14 tests).

- [ ] **Step 6 : Commit**

```bash
git add -A
git commit -m "feat: moteur de décision pur, gates 0 et 3 et table de décision"
```

---

### Task 8 : Câblage dans le pipeline et persistance des décisions

**Files:**
- Create: `src/ingest/decision.ts`
- Modify: `src/ingest/handler.ts`
- Test: `tests/ingest/decision.int.test.ts`

**Interfaces:**
- Consumes: `evaluerReglesLexicales`, `classifier`, `decider`, `prisma`, `log`.
- Produces: `function deciderEtTracer(params: { messageId: string; contactId: string; texte: string | null; typeMedia: MediaType | null; classifierImpl?: typeof classifier }): Promise<Verdict>`

**Le point clé (P3) :** les signaux des règles lexicales et ceux du classifieur sont **concaténés**, jamais intersectés. Un classifieur complaisant ne peut pas annuler une règle déterministe.

**Contrainte de phase :** `ingererMessage` appelle ce module **après** avoir persisté le message, et ne modifie jamais `Contact.mode`. Aucun envoi n'est déclenché : un verdict `AUTO_SENT` est tracé tel quel, sans conséquence, puisque le rédacteur et le planificateur arrivent en phase 3.

- [ ] **Step 1 : Écrire le test d'intégration qui échoue**

`tests/ingest/decision.int.test.ts` :

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { deciderEtTracer } from "@/ingest/decision";
import { resetDb } from "../helpers/db";
import { ContactMode, DecisionOutcome, MediaType, RiskCategory } from "@/generated/prisma/client";

async function contactAvecMessage(mode: ContactMode) {
  const contact = await prisma.contact.create({
    data: { jid: `${mode}@s.whatsapp.net`, mode, thread: { create: {} }, policy: { create: {} } },
    include: { thread: true },
  });
  const message = await prisma.message.create({
    data: {
      threadId: contact.thread!.id,
      waMessageId: `M-${mode}-${Date.now()}`,
      direction: "IN",
      source: "HUMAN",
      text: "coucou",
      timestamp: new Date(),
    },
  });
  return { contact, message };
}

const classifieurCalme = vi.fn().mockResolvedValue({
  signaux: [], confiance: 0.95, motif: "anodin", fournisseur: "test", latencyMs: 5,
});

describe("décision et traçage", () => {
  beforeEach(async () => {
    await resetDb();
    classifieurCalme.mockClear();
  });

  it("n'appelle jamais le classifieur pour un contact en OFF (P1)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.OFF);
    const verdict = await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "on se voit vendredi ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    expect(verdict.issue).toBe(DecisionOutcome.IGNORED);
    expect(classifieurCalme).not.toHaveBeenCalled();
  });

  it("persiste une Decision liée au message, avec la règle déclenchée", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "tu peux m'envoyer 50000 ?",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({ where: { messageId: message.id } });
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe(DecisionOutcome.ESCALATED);
    expect(decision!.risks).toContain(RiskCategory.MONEY);
    expect(decision!.ruleFired).toMatch(/argent/);
  });

  it("réunit les signaux lexicaux et ceux du classifieur, sans intersection (P3)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    const classifieurComplaisant = vi.fn().mockResolvedValue({
      signaux: [], confiance: 0.99, motif: "rien à signaler", fournisseur: "t", latencyMs: 1,
    });
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "on se voit vendredi ?",
      typeMedia: null, classifierImpl: classifieurComplaisant,
    });
    const decision = await prisma.decision.findUnique({ where: { messageId: message.id } });
    // Le classifieur n'a rien vu ; la règle lexicale, si. L'union l'emporte.
    expect(decision!.risks).toContain(RiskCategory.ENGAGEMENT);
    expect(decision!.outcome).toBe(DecisionOutcome.ESCALATED);
  });

  it("escalade un média sans jamais appeler le classifieur", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    const verdict = await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: null,
      typeMedia: MediaType.AUDIO, classifierImpl: classifieurCalme,
    });
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
    expect(verdict.risques).toContain(RiskCategory.NON_TEXT);
    expect(classifieurCalme).not.toHaveBeenCalled();
  });

  it("enregistre le fournisseur et la latence quand le classifieur a répondu", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.DRAFT);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "haha t'es fou",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const decision = await prisma.decision.findUnique({ where: { messageId: message.id } });
    expect(decision!.classifierProvider).toBe("test");
    expect(decision!.latencyMs).toBe(5);
  });

  it("ne modifie jamais le mode du contact (P1)", async () => {
    const { contact, message } = await contactAvecMessage(ContactMode.AUTO);
    await deciderEtTracer({
      messageId: message.id, contactId: contact.id, texte: "haha",
      typeMedia: null, classifierImpl: classifieurCalme,
    });
    const apres = await prisma.contact.findUnique({ where: { id: contact.id } });
    expect(apres!.mode).toBe(ContactMode.AUTO);
  });
});
```

- [ ] **Step 2 : Vérifier que le test échoue**

Run: `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: FAIL — `@/ingest/decision` introuvable.

- [ ] **Step 3 : Implémenter**

`src/ingest/decision.ts` :

```ts
import { ContactMode, DecisionOutcome, MediaType, RiskCategory } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { evaluerReglesLexicales } from "@/decision/regles-lexicales";
import { classifier } from "@/decision/classifieur";
import { decider } from "@/decision/moteur";
import type { ContexteDecision, SignalRisque, Verdict } from "@/decision/types";

const JOUR_MS = 24 * 60 * 60 * 1000;

export async function deciderEtTracer(params: {
  messageId: string;
  contactId: string;
  texte: string | null;
  typeMedia: MediaType | null;
  classifierImpl?: typeof classifier;
}): Promise<Verdict> {
  const classifierUtilise = params.classifierImpl ?? classifier;

  const contact = await prisma.contact.findUnique({
    where: { id: params.contactId },
    include: { policy: true, thread: true },
  });
  if (!contact) {
    throw new Error(`Contact ${params.contactId} introuvable`);
  }

  const etat = await prisma.systemState.findUnique({ where: { id: "singleton" } });
  const pauseGlobale = etat?.globalPaused ?? false;

  const politique = contact.policy;
  const gardeFous = {
    engagement: politique?.guardEngagement ?? true,
    facts: politique?.guardFacts ?? true,
    emotional: politique?.guardEmotional ?? true,
    money: politique?.guardMoney ?? true,
    intimate: politique?.guardIntimate ?? true,
    thirdParty: politique?.guardThirdParty ?? true,
  };

  const signauxLexicaux = evaluerReglesLexicales(params.texte, params.typeMedia);

  // Gate 0 avant toute dépense : un contact non activé ne déclenche aucun appel
  // à un fournisseur (P1). Idem pour un média, que le classifieur ne sait pas
  // lire et qui escalade de toute façon.
  const courtCircuit =
    contact.mode === ContactMode.OFF ||
    pauseGlobale ||
    params.typeMedia !== null ||
    params.texte === null ||
    params.texte.trim() === "";

  let signauxClassifieur: SignalRisque[] = [];
  let fournisseur: string | null = null;
  let latencyMs: number | null = null;
  let motif: string | null = null;
  let classifieurDisponible = true;

  if (!courtCircuit) {
    const resultat = await classifierUtilise({ texte: params.texte!, contactId: contact.id });
    signauxClassifieur = resultat.signaux;
    fournisseur = resultat.fournisseur;
    latencyMs = resultat.latencyMs;
    motif = resultat.motif;
    classifieurDisponible = resultat.fournisseur !== null;
  }

  // P3 : concaténation, jamais intersection. Un classifieur complaisant ne peut
  // pas annuler une règle déterministe.
  const signaux = [...signauxLexicaux, ...signauxClassifieur];

  const escaladeOuverte =
    (await prisma.escalation.count({
      where: { status: "OPEN", decision: { contactId: contact.id } },
    })) > 0;

  const dernierEchange = contact.thread?.lastMessageAt ?? null;
  const dernierEchangeIlYaJours = dernierEchange
    ? Math.floor((Date.now() - dernierEchange.getTime()) / JOUR_MS)
    : null;

  const contexte: ContexteDecision = {
    mode: contact.mode,
    pauseGlobale,
    gardeFous,
    intimateOverride: politique?.intimateOverride ?? false,
    isAdult: contact.isAdult,
    signaux,
    autoStreak: contact.thread?.autoStreak ?? 0,
    maxAutoStreak: politique?.maxAutoStreak ?? 6,
    escaladeOuverte,
    dernierEchangeIlYaJours,
    classifieurDisponible,
  };

  const verdict = decider(contexte);

  // P5 : la décision est tracée quelle qu'en soit l'issue, y compris IGNORED.
  const risquesUniques = [...new Set(verdict.risques)] as RiskCategory[];
  await prisma.decision.create({
    data: {
      messageId: params.messageId,
      contactId: contact.id,
      risks: risquesUniques,
      ruleFired: verdict.regle,
      outcome: verdict.issue,
      classifierProvider: fournisseur,
      latencyMs,
      rawClassification: motif ? { motif } : undefined,
    },
  });

  log.info("Décision prise", {
    contactId: contact.id,
    messageId: params.messageId,
    issue: verdict.issue,
    regle: verdict.regle,
    risques: risquesUniques,
    fournisseur,
    latencyMs,
  });

  return verdict;
}
```

- [ ] **Step 4 : Câbler dans l'ingestion**

Dans `src/ingest/handler.ts`, après la création du message et la mise à jour du fil, avant le `return` :

```ts
  // La décision ne doit jamais faire échouer l'ingestion : un message persisté
  // reste persisté même si le moteur tombe, et GOWA ne doit pas rejouer un
  // webhook déjà traité. On trace l'échec et on rend la main.
  try {
    await deciderEtTracer({
      messageId: message.id,
      contactId: contact.id,
      texte: payload.body ?? null,
      typeMedia: typeMedia,
    });
  } catch (erreur) {
    log.error("Décision impossible pour un message pourtant persisté", {
      messageId: message.id,
      contactId: contact.id,
      erreur: erreur instanceof Error ? erreur.message : String(erreur),
    });
  }

  return { statut: "persiste", messageId: message.id };
```

Note : seuls les messages **entrants** sont décidés. Ajouter la garde `if (payload.is_from_me) return { statut: "persiste", messageId: message.id };` avant ce bloc — un message que l'utilisateur a écrit lui-même n'a pas à être classé.

- [ ] **Step 5 : Vérifier les deux suites**

Run: `pnpm test` puis `DATABASE_URL_TEST="postgres://wha:wha@127.0.0.1:5434/wha_test" pnpm test:int`
Expected: PASS, sortie vierge.

- [ ] **Step 6 : Commit**

```bash
git add -A
git commit -m "feat: câblage du moteur de décision dans le pipeline d'ingestion"
```

---

## Deux éléments de la spec délibérément reportés

**Le debounce de 8 secondes.** La spec le place dans le pipeline, avant le Gate 0 :
les messages d'une même rafale doivent être traités comme un seul tour de parole.
L'implémenter suppose une file d'attente temporisée — exactement le mécanisme que
le planificateur d'envoi de la phase 3 apporte. Le construire ici signifierait le
construire deux fois. **Conséquence assumée pendant cette phase :** trois messages
envoyés coup sur coup produisent trois décisions au lieu d'une. Sans envoi ni
escalade postée, cela ne se voit que dans la table `Decision`.

**Les quiet hours.** La spec les décrit comme un report d'envoi, pas comme une
escalade : « hors plage, l'envoi est différé au début de la plage suivante ».
C'est une règle de planification, elle appartient donc au planificateur d'envoi
de la phase 3. `ContactPolicy` porte déjà `quietHoursStart`, `quietHoursEnd` et
`timezone` : rien n'est perdu.

## Ce que la phase 2 ne fait pas

Aucun message n'est envoyé, aucun brouillon n'est rédigé, aucune escalade n'est postée : un verdict `AUTO_SENT` ou `DRAFTED` est tracé sans conséquence. Le rédacteur, le groupe de contrôle et le planificateur d'envoi arrivent en phase 3.

Les clés d'API ne sont pas encore saisissables : `ProviderConfig` et `ProviderRoute` se remplissent à la main en base jusqu'à la phase 4, qui apporte l'écran des fournisseurs.

## Vérification après déploiement

Une fois la phase déployée, envoyer trois messages depuis un autre téléphone et lire la table `Decision` :

```sql
SELECT m.text, d.outcome, d."ruleFired", d.risks, d."classifierProvider", d."latencyMs"
FROM "Decision" d JOIN "Message" m ON m.id = d."messageId"
ORDER BY d."createdAt" DESC LIMIT 10;
```

- Un message anodin sur un contact `OFF` → `IGNORED`, règle `gate0.contact-non-active`, aucun fournisseur appelé.
- « on se voit vendredi ? » → `ESCALATED`, règle commençant par `risque.engagement`.
- Un message vocal → `ESCALATED`, risque `NON_TEXT`, aucun fournisseur appelé.
