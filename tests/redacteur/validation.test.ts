import { describe, it, expect } from "vitest";
import { validerBrouillon } from "@/redacteur/validation";
import type { ContexteRedaction } from "@/redacteur/contexte";

function contexte(surcharge: Partial<ContexteRedaction> = {}): ContexteRedaction {
  return {
    styleGuide: {},
    hardLimits: ["Ne jamais promettre une date"],
    termesInterdits: [],
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

  it("accepte un factsUsed exprimé par la clé lisible du fait, pas seulement par son cuid", () => {
    const ctx = contexte({
      faits: [{ id: "cmg3x7k2p0000l8a1b2c3d4e5", key: "ville", value: "Abidjan" }],
    });
    const r = validerBrouillon({ reply: "Je suis à Abidjan", factsUsed: ["ville"], needsFact: null }, ctx);
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

  it("refuse même quand la longueur du style est une clé du prototype d'objet (fail-closed)", () => {
    const long = "mot ".repeat(200);
    const r = validerBrouillon(
      { reply: long, factsUsed: [], needsFact: null },
      contexte({ stylePolitique: { longueur: "constructor", emoji: "parfois", formalite: "tutoiement", langue: "fr" } }),
    );
    expect(r.valide).toBe(false);
    if (!r.valide) expect(r.regle).toBe("p4.longueur");
  });

  it("refuse un brouillon employant un terme interdit", () => {
    const r = validerBrouillon(
      { reply: "Promis, on se voit samedi", factsUsed: [], needsFact: null },
      contexte({ termesInterdits: ["samedi"] }),
    );
    expect(r.valide).toBe(false);
    if (!r.valide) expect(r.regle).toBe("p4.limite-dure");
  });

  it("une hardLimits en langue naturelle ne bloque rien mécaniquement, contrairement à termesInterdits (forme réelle du produit)", () => {
    const brouillon = { reply: "Je te rembourse les 50 000 FCFA lundi", factsUsed: [], needsFact: null };

    // hardLimits est une consigne de prompt : la comparaison littérale ne la
    // trouve jamais dans un brouillon réel.
    const sansGarde = validerBrouillon(brouillon, contexte({ hardLimits: ["Ne jamais parler d'argent"], termesInterdits: [] }));
    expect(sansGarde.valide).toBe(true);

    // termesInterdits est la garde mécanique : elle porte sur un mot concret.
    const avecGarde = validerBrouillon(
      brouillon,
      contexte({ hardLimits: ["Ne jamais parler d'argent"], termesInterdits: ["rembourse"] }),
    );
    expect(avecGarde.valide).toBe(false);
    if (!avecGarde.valide) expect(avecGarde.regle).toBe("p4.limite-dure");
  });

  // F1 : un terme interdit doit bloquer ses formes fléchies (masculin/féminin,
  // singulier/pluriel), sans quoi « rembourse » n'arrête pas « remboursée » —
  // l'angle mort qui a déjà coûté plusieurs tours de correction ailleurs dans
  // ce projet (cf. src/decision/regles-lexicales.ts). L'accord ne doit pas
  // pour autant rouvrir le faux positif sur une sous-chaîne (« prêt » dans
  // « sous prétexte »), ni casser l'échappement des caractères spéciaux de
  // regex dans un terme (« c'est+ »), ni un terme à plusieurs mots.
  it.each([
    ["« déçu » bloque la forme fléchie « deçue » (accord féminin)", ["déçu"], "Tu vas être deçue", false],
    ["« déçu » bloque la forme fléchie « déçus » (pluriel masculin)", ["déçu"], "On dirait qu'ils sont déçus", false],
    ["« déçu » bloque la forme fléchie « déçues » (pluriel féminin)", ["déçu"], "Elles étaient déçues", false],
    ["« rembourse » bloque la forme fléchie « remboursée »", ["rembourse"], "Elle a été remboursée hier soir", false],
    ["« rembourse » bloque la forme fléchie « rembourses »", ["rembourse"], "Tu rembourses quand ?", false],
    [
      "« prêt » continue de laisser passer « sous prétexte » : flechi ne rouvre pas le faux positif",
      ["prêt"],
      "Il a dit ça sous prétexte que j'étais en retard",
      true,
    ],
    ["« mon adresse » (terme à plusieurs mots) bloque toujours", ["mon adresse"], "Je t'envoie mon adresse tout à l'heure", false],
    ["« c'est+ » reste échappé : bloque la forme exacte « c'est+ »", ["c'est+"], "c'est+ trop tard, désolé", false],
    ["« c'est+ » reste échappé : ne bloque pas « c'est » seul", ["c'est+"], "c'est trop tard, désolé", true],
  ] as const)("%s", (_description, termesInterdits, reply, valideAttendu) => {
    const r = validerBrouillon({ reply, factsUsed: [], needsFact: null }, contexte({ termesInterdits: [...termesInterdits] }));
    expect(r.valide).toBe(valideAttendu);
    if (!r.valide) expect(r.regle).toBe("p4.limite-dure");
  });

  it.each([
    ["accent : é précomposé dans le terme, décomposé dans le brouillon", ["café"], "on se voit au café du coin"],
    ["casse : terme en majuscule, brouillon en minuscule", ["Rembourse"], "je te rembourse demain"],
    ["apostrophe : terme droit, brouillon typographique (macOS)", ["l'argent"], "je n'ai pas l’argent en ce moment"],
    ["apostrophe : terme typographique, brouillon droit", ["l’argent"], "je n'ai pas l'argent en ce moment"],
    ["ligature : terme en œ, brouillon en oe", ["sœur"], "j'étais avec ma soeur hier"],
  ])("normalise avant de comparer un terme interdit : %s", (_description, termesInterdits, reply) => {
    const r = validerBrouillon({ reply, factsUsed: [], needsFact: null }, contexte({ termesInterdits }));
    expect(r.valide).toBe(false);
    if (!r.valide) expect(r.regle).toBe("p4.limite-dure");
  });

  it("renvoie le texte nettoyé quand tout est correct", () => {
    const r = validerBrouillon({ reply: "  Salut  ", factsUsed: [], needsFact: null }, contexte());
    expect(r.valide && r.texte).toBe("Salut");
  });
});
