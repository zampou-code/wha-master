import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { appelerStructure, AucunFournisseurError } from "@/ia/appel";
import type { EntreeRoute } from "@/ia/registre";

// Le journal réel écrit sur process.stdout ; on le rend silencieux ici pour
// garder une sortie de test vierge (ce fichier ne teste pas la journalisation
// elle-même, voir tests/lib/log.test.ts).
vi.mock("@/lib/log", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/log")>();
  return { ...original, log: original.creerJournal({}, () => {}) };
});

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
    let erreur: Error | undefined;
    try {
      await appelerStructure({
        role: "classify",
        schema,
        systeme: "s",
        invite: "i",
        entrees: [avecCle],
        generer,
      });
    } catch (e) {
      erreur = e as Error;
    }
    expect(erreur).toBeInstanceOf(AucunFournisseurError);
    expect(erreur?.message).not.toContain("sk-tres-secret");
  });
});
