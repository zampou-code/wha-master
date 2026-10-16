import { describe, it, expect, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { ProviderKind, RiskCategory } from "@/generated/prisma/client";
import { enregistrerFournisseur, enregistrerRoles } from "@/fournisseurs/service";
import { classifier } from "@/decision/classifieur";
import { resetDb } from "../helpers/db";

async function router(kinds: { kind: ProviderKind; nom: string }[]) {
  const ids: string[] = [];
  for (const { kind, nom } of kinds) {
    const reglages = await enregistrerFournisseur({
      name: nom,
      kind,
      apiKey: "cle-de-test",
      baseUrl: kind === ProviderKind.OPENAI_COMPATIBLE ? "https://exemple/v1" : undefined,
      enabled: true,
    });
    ids.push(reglages.fournisseurs.find((f) => f.name === nom)!.id);
  }
  await enregistrerRoles({
    classify: ids.map((providerId) => ({ providerId, model: "m" })),
  });
  return ids;
}

const reponseJev = {
  signaux: [{ categorie: RiskCategory.MONEY, regle: "jev" }],
  probabilites: { [RiskCategory.MONEY]: 0.98, [RiskCategory.EMOTIONAL]: 0.18 },
  tokensEntree: 300,
};

describe("classifieur adossé à Jev", () => {
  beforeEach(resetDb);

  it("emprunte Jev quand la route le désigne, sans passer par l'AI SDK", async () => {
    // Le piège classique de ce projet : un réglage stocké dans la bonne forme
    // que le code de production ne lit jamais. L'AI SDK lève ici : s'il est
    // appelé, le test échoue.
    await router([{ kind: ProviderKind.TYPESAFE, nom: "Jev" }]);
    const appeler = vi.fn().mockRejectedValue(new Error("l'AI SDK ne doit pas être appelé"));
    const jev = vi.fn().mockResolvedValue(reponseJev);

    const resultat = await classifier({
      texte: "tu peux m'envoyer 50000 F ?",
      appeler: appeler as never,
      jev: jev as never,
    });

    expect(appeler).not.toHaveBeenCalled();
    expect(jev).toHaveBeenCalledOnce();
    expect(resultat.fournisseur).toBe("Jev");
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.MONEY]);
    expect(resultat.motif).toContain("MONEY 0.98");
    expect(resultat.costUsd).toBeCloseTo(0.0000126, 9);
  });

  it("ne déclare jamais une confiance basse — chaque probabilité est calibrée à part", async () => {
    // Déclarer une confiance globale faible ajouterait LOW_CONFIDENCE à chaque
    // message, donc une escalade systématique : ce serait annuler l'intérêt du
    // modèle.
    await router([{ kind: ProviderKind.TYPESAFE, nom: "Jev" }]);
    const resultat = await classifier({
      texte: "coucou",
      appeler: vi.fn() as never,
      jev: vi.fn().mockResolvedValue({ signaux: [], probabilites: {}, tokensEntree: 120 }) as never,
    });

    expect(resultat.signaux).toEqual([]);
    expect(resultat.confiance).toBe(1);
  });

  it("retombe sur le fournisseur générique quand Jev échoue", async () => {
    // La cascade garde son sens : Jev en premier, un modèle de langue derrière.
    await router([
      { kind: ProviderKind.TYPESAFE, nom: "Jev" },
      { kind: ProviderKind.ANTHROPIC, nom: "Anthropic" },
    ]);
    const jev = vi.fn().mockRejectedValue(new Error("503 overloaded"));
    const appeler = vi.fn().mockResolvedValue({
      valeur: { risks: ["EMOTIONAL"], confidence: 0.9, rationale: "déception" },
      fournisseur: "Anthropic",
      model: "claude-haiku-4-5-20251001",
      latencyMs: 400,
      costUsd: 0.0002,
    });

    const resultat = await classifier({
      texte: "je suis déçue",
      appeler: appeler as never,
      jev: jev as never,
    });

    expect(jev).toHaveBeenCalledOnce();
    expect(appeler).toHaveBeenCalledOnce();
    expect(resultat.fournisseur).toBe("Anthropic");
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.EMOTIONAL]);
  });

  it("escalade par précaution quand Jev échoue et qu'il n'y a personne derrière", async () => {
    // P2 : un classifieur indisponible rend le message incertain, et
    // LOW_CONFIDENCE est un garde-fou toujours actif.
    await router([{ kind: ProviderKind.TYPESAFE, nom: "Jev" }]);
    const resultat = await classifier({
      texte: "coucou",
      appeler: vi.fn().mockRejectedValue(new Error("aucun fournisseur")) as never,
      jev: vi.fn().mockRejectedValue(new Error("401 invalid key")) as never,
    });

    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.LOW_CONFIDENCE]);
    expect(resultat.fournisseur).toBeNull();
  });

  it("ignore Jev quand son fournisseur est désactivé", async () => {
    const [id] = await router([
      { kind: ProviderKind.TYPESAFE, nom: "Jev" },
      { kind: ProviderKind.ANTHROPIC, nom: "Anthropic" },
    ]);
    await enregistrerFournisseur({
      id, name: "Jev", kind: ProviderKind.TYPESAFE, apiKey: "", enabled: false,
    });

    const jev = vi.fn();
    const appeler = vi.fn().mockResolvedValue({
      valeur: { risks: [], confidence: 0.95, rationale: "anodin" },
      fournisseur: "Anthropic", model: "m", latencyMs: 10, costUsd: 0,
    });

    const resultat = await classifier({ texte: "coucou", appeler: appeler as never, jev: jev as never });

    expect(jev).not.toHaveBeenCalled();
    expect(resultat.fournisseur).toBe("Anthropic");
  });
});
