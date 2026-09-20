import { describe, it, expect, vi } from "vitest";
import { classifier } from "@/decision/classifieur";
import { AucunFournisseurError, type appelerStructure } from "@/ia/appel";
import { RiskCategory } from "@/generated/prisma/client";

// Le journal réel écrit sur process.stdout ; on le rend silencieux ici pour
// garder une sortie de test vierge (ce fichier ne teste pas la journalisation
// elle-même, voir tests/lib/log.test.ts).
vi.mock("@/lib/log", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/log")>();
  return { ...original, log: original.creerJournal({}, () => {}) };
});

// `vi.fn()` ne s'assigne pas proprement à `typeof appelerStructure` sous
// `strict` (générique, surcharges). On caste explicitement ici plutôt que
// d'assouplir le type de production — voir la décision du contrôleur.
function commeAppeler(mock: ReturnType<typeof vi.fn>): typeof appelerStructure {
  return mock as unknown as typeof appelerStructure;
}

describe("classifieur de risque", () => {
  it("convertit les catégories renvoyées en signaux", async () => {
    const appeler = commeAppeler(
      vi.fn().mockResolvedValue({
        valeur: { risks: ["ENGAGEMENT", "FACT"], confidence: 0.9, rationale: "propose un rendez-vous" },
        fournisseur: "anthropic",
        model: "m",
        latencyMs: 120,
        costUsd: null,
      }),
    );
    const resultat = await classifier({ texte: "on se voit vendredi ?", appeler });
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.ENGAGEMENT, RiskCategory.FACT]);
    expect(resultat.fournisseur).toBe("anthropic");
    expect(resultat.latencyMs).toBe(120);
  });

  it("ajoute LOW_CONFIDENCE quand la confiance est sous le seuil", async () => {
    const appeler = commeAppeler(
      vi.fn().mockResolvedValue({
        valeur: { risks: [], confidence: 0.4, rationale: "incertain" },
        fournisseur: "a",
        model: "m",
        latencyMs: 10,
        costUsd: null,
      }),
    );
    const resultat = await classifier({ texte: "hmm", appeler });
    expect(resultat.signaux.map((s) => s.categorie)).toContain(RiskCategory.LOW_CONFIDENCE);
  });

  it("ignore une catégorie inconnue plutôt que de lever", async () => {
    const appeler = commeAppeler(
      vi.fn().mockResolvedValue({
        valeur: { risks: ["ENGAGEMENT", "CATEGORIE_INVENTEE"], confidence: 0.9, rationale: "x" },
        fournisseur: "a",
        model: "m",
        latencyMs: 10,
        costUsd: null,
      }),
    );
    const resultat = await classifier({ texte: "x", appeler });
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.ENGAGEMENT]);
  });

  it("renvoie LOW_CONFIDENCE quand aucun fournisseur ne répond (P2 fail-closed)", async () => {
    const appeler = commeAppeler(vi.fn().mockRejectedValue(new AucunFournisseurError("classify", 4)));
    const resultat = await classifier({ texte: "on se voit vendredi ?", appeler });
    expect(resultat.signaux.map((s) => s.categorie)).toEqual([RiskCategory.LOW_CONFIDENCE]);
    expect(resultat.fournisseur).toBeNull();
    expect(resultat.motif).toMatch(/indisponible/i);
  });

  it("renvoie LOW_CONFIDENCE sur n'importe quelle exception, sans la propager", async () => {
    const appeler = commeAppeler(vi.fn().mockRejectedValue(new TypeError("cassé")));
    await expect(classifier({ texte: "x", appeler })).resolves.toMatchObject({
      signaux: [{ categorie: RiskCategory.LOW_CONFIDENCE }],
    });
  });
});
