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
