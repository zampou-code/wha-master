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
  termesInterdits: [],
  faits: [{ id: "f1", key: "ville", value: "Abidjan" }],
  resumeFil: "",
  derniersMessages: [{ direction: "IN", texte: "tu fais quoi ?" }],
  stylePolitique: { longueur: "court", emoji: "parfois", formalite: "tutoiement", langue: "fr" },
};

function reponse(valeur: unknown) {
  return { valeur, fournisseur: "test", model: "m", latencyMs: 12, costUsd: 0.0001 };
}

// Le simulacre vitest n'a pas la signature générique d'`appelerStructure` :
// ce seul cast (`as never`), centralisé ici et commenté une fois, branche le
// mock sur le paramètre `appeler` de `rediger` pour tous les tests du fichier.
type Appeler = NonNullable<Parameters<typeof rediger>[0]["appeler"]>;
function commeAppeler(mock: ReturnType<typeof vi.fn>): Appeler {
  return mock as never;
}

describe("rédacteur", () => {
  it("renvoie le brouillon validé et les métadonnées du fournisseur", async () => {
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "Rien de spécial", factsUsed: [], needsFact: null }));
    const r = await rediger({ contexte, tourDeParole: "tu fais quoi ?", appeler: commeAppeler(appeler) });
    expect(r.brouillon).toBe("Rien de spécial");
    expect(r.fournisseur).toBe("test");
    expect(r.costUsd).toBe(0.0001);
    expect(r.motifRefus).toBeNull();
  });

  it("refuse le brouillon quand le modèle invente un fait (P4)", async () => {
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "J'ai 34 ans", factsUsed: ["inconnu"], needsFact: null }));
    const r = await rediger({ contexte, tourDeParole: "tu as quel âge ?", appeler: commeAppeler(appeler) });
    expect(r.brouillon).toBeNull();
    expect(r.regleRefus).toBe("p4.fait-inconnu");
  });

  it("refuse et remonte la question quand le modèle déclare un fait manquant", async () => {
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "", factsUsed: [], needsFact: "Tu bosses samedi ?" }));
    const r = await rediger({ contexte, tourDeParole: "tu bosses samedi ?", appeler: commeAppeler(appeler) });
    expect(r.brouillon).toBeNull();
    expect(r.motifRefus).toContain("Tu bosses samedi ?");
  });

  it("ne lève jamais quand aucun fournisseur ne répond (P2)", async () => {
    const appeler = vi.fn().mockRejectedValue(new AucunFournisseurError("compose", 4));
    const r = await rediger({ contexte, tourDeParole: "x", appeler: commeAppeler(appeler) });
    expect(r.brouillon).toBeNull();
    expect(r.regleRefus).toBe("redacteur.indisponible");
    expect(r.fournisseur).toBeNull();
  });

  it("ne lève pas non plus sur une exception inattendue", async () => {
    const appeler = vi.fn().mockRejectedValue(new TypeError("cassé"));
    await expect(rediger({ contexte, tourDeParole: "x", appeler: commeAppeler(appeler) })).resolves.toMatchObject({
      brouillon: null,
      regleRefus: "redacteur.indisponible",
    });
  });

  it("ne lève pas non plus quand le modèle répond une forme inexploitable (ceinture et bretelles sur la validation de l'AI SDK)", async () => {
    // factsUsed: null passerait le schéma de l'AI SDK d'une version future ou
    // d'un fournisseur laxiste ; rediger doit refuser, pas lever.
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "ok", factsUsed: null, needsFact: null }));
    const r = await rediger({ contexte, tourDeParole: "x", appeler: commeAppeler(appeler) });
    expect(r.brouillon).toBeNull();
    expect(r.regleRefus).toBe("redacteur.brouillon-illisible");
  });

  it("compose le prompt avec les faits reçus dans le contexte (le filtre des faits partageables, lui, est éprouvé dans tests/redacteur/contexte.int.test.ts)", async () => {
    const appeler = vi.fn().mockResolvedValue(reponse({ reply: "ok", factsUsed: [], needsFact: null }));
    await rediger({ contexte, tourDeParole: "x", appeler: commeAppeler(appeler) });
    // `mock.calls[0][0]` est typé `unknown[]` par vitest : ce cast lit les
    // champs `invite`/`systeme` de l'objet passé à `appeler`, dont la forme
    // est garantie par la signature de `rediger`.
    const [{ invite, systeme }] = appeler.mock.calls[0] as [{ invite: string; systeme: string }];
    expect(`${invite}${systeme}`).toContain("Abidjan");
  });
});
