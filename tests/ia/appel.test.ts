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

  it("désactive les reprises internes du SDK et fournit un signal d'abandon (finding 5)", async () => {
    const generer = vi.fn().mockResolvedValue({ object: { risks: [] }, usage: {} });
    await appelerStructure({
      role: "classify",
      schema,
      systeme: "s",
      invite: "i",
      entrees: [entree("a", "m1")],
      generer,
    });
    expect(generer).toHaveBeenCalledTimes(1);
    const appelParams = generer.mock.calls[0][0] as { maxRetries?: number; abortSignal?: AbortSignal };
    // maxRetries: 0 — la cascade ci-dessus (TENTATIVES_PAR_ENTREE) gère déjà
    // les reprises ; le défaut du SDK (2) triplerait sinon chaque requête.
    expect(appelParams.maxRetries).toBe(0);
    expect(appelParams.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("remonte le coût quand le fournisseur le rapporte via providerMetadata (finding 6)", async () => {
    const generer = vi.fn().mockResolvedValue({
      object: { risks: [] },
      usage: {},
      providerMetadata: { openrouter: { usage: { cost: 0.00073 } } },
    });
    const resultat = await appelerStructure({
      role: "classify",
      schema,
      systeme: "s",
      invite: "i",
      entrees: [entree("a", "m1")],
      generer,
    });
    expect(resultat.costUsd).toBe(0.00073);
  });

  it("renvoie costUsd null quand le fournisseur ne le rapporte pas, sans que ce soit codé en dur (finding 6)", async () => {
    const generer = vi.fn().mockResolvedValue({ object: { risks: [] }, usage: {} });
    const resultat = await appelerStructure({
      role: "classify",
      schema,
      systeme: "s",
      invite: "i",
      entrees: [entree("a", "m1")],
      generer,
    });
    expect(resultat.costUsd).toBeNull();
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

  it("porte la cause réelle du dernier échec, pas seulement « indisponible »", async () => {
    // Un identifiant de modèle qui n'existe pas se manifestait par « le
    // rédacteur est indisponible », sans jamais dire pourquoi. La cause ne
    // vivait que dans les journaux du serveur, que personne ne lit depuis un
    // téléphone.
    const generer = vi.fn().mockRejectedValue(new Error("model not found: kimi-k2-0905-preview"));
    await expect(
      appelerStructure({
        role: "compose", schema, systeme: "s", invite: "i",
        entrees: [entree("Kimi", "kimi-k2-0905-preview")], generer,
      }),
    ).rejects.toMatchObject({
      name: "AucunFournisseurError",
      derniereErreur: expect.stringContaining("model not found"),
    });
  });

  it("nomme le fournisseur et le modèle fautifs dans la cause", async () => {
    const generer = vi.fn().mockRejectedValue(new Error("401 unauthorized"));
    try {
      await appelerStructure({
        role: "compose", schema, systeme: "s", invite: "i",
        entrees: [entree("Kimi", "kimi-k2.6")], generer,
      });
      throw new Error("aurait dû lever");
    } catch (erreur) {
      const cause = (erreur as { derniereErreur: string | null }).derniereErreur ?? "";
      expect(cause).toContain("Kimi");
      expect(cause).toContain("kimi-k2.6");
      expect(cause).toContain("401");
    }
  });
});
