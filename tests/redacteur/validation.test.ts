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
