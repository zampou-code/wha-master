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

  it("coupe un message reçu trop long plutôt que d'inonder l'écran", () => {
    const pave = "mot ".repeat(200);
    const texte = formaterEscalade({
      alias: "Sarah", risques: [RiskCategory.EMOTIONAL], messageRecu: pave,
      proposition: "ok", motifRefus: null,
    });
    // L'escalade entière doit rester lisible sur un téléphone : le message reçu
    // est coupé, mais l'en-tête, la proposition et les actions restent présents.
    expect(texte.length).toBeLessThan(600);
    expect(texte).toContain("…");
    expect(texte).toContain("1 envoyer");
  });

  it("laisse intact un message reçu de longueur normale", () => {
    const texte = formaterEscalade({
      alias: "Sarah", risques: [], messageRecu: "on se voit vendredi ?",
      proposition: "ok", motifRefus: null,
    });
    expect(texte).toContain("on se voit vendredi ?");
    expect(texte).not.toContain("…");
  });
});
