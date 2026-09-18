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
