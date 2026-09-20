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
    expect(categories("tu peux m'envoyer 10000 F ?")).toContain(RiskCategory.MONEY);
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

  it("repère les formes féminines de l'émotionnel", () => {
    expect(categories("je suis déçue")).toContain(RiskCategory.EMOTIONAL);
    expect(categories("tu m'as blessée")).toContain(RiskCategory.EMOTIONAL);
    expect(categories("tu m'as vexée")).toContain(RiskCategory.EMOTIONAL);
    expect(categories("je suis déprimée")).toContain(RiskCategory.EMOTIONAL);
  });

  it("ne confond pas prêt (adjectif) avec prêt (loan)", () => {
    expect(categories("tu es prêt ?")).toEqual([]);
    expect(categories("je suis prête dans 5 min")).toEqual([]);
    expect(categories("c'est presque prêt")).toEqual([]);
    expect(categories("tu peux me faire un prêt ?")).toContain(RiskCategory.MONEY);
  });

  it("ne classe pas l'échange de numéro en demande d'argent", () => {
    expect(categories("envoie-moi ton numéro 0778123456")).toEqual([]);
    expect(categories("donne moi ton numero")).toEqual([]);
    expect(categories("tu peux m'envoyer 10000 F ?")).toContain(RiskCategory.MONEY);
  });

  it("distingue tu fais quoi (plan) de tu travailles (fait)", () => {
    expect(categories("tu fais quoi ce soir ?")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("tu fais quoi demain ?")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("tu fais quoi ce week-end ?")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("tu fais quoi ?")).toEqual([]);
    expect(categories("tu travailles où ?")).toContain(RiskCategory.FACT);
    expect(categories("tu bosses dans quoi ?")).toContain(RiskCategory.FACT);
  });

  it("accepte les messages ordinaires du quotidien", () => {
    const messagesOrdinaires = [
      "salut ça va ?",
      "lol c'est dingue",
      "t'as vu le film hier soir ?",
      "envoie-moi ton numéro",
      "tu es prêt ?",
      "je suis occupée là",
      "à plus tard",
      "tu fais quoi ?",
    ];
    for (const msg of messagesOrdinaires) {
      expect(categories(msg)).toEqual([], `Message "${msg}" ne doit déclencher aucun signal`);
    }
  });

  it("accepte les formes grammaticales correctes en tous genres pour les adjectifs relationnels", () => {
    // Marié/mariée - past participle of "marier" (to marry)
    expect(categories("tu es marié ?")).toContain(RiskCategory.FACT);
    expect(categories("tu es mariée ?")).toContain(RiskCategory.FACT);

    // Exclusif/exclusive - relationship status adjective
    expect(categories("tu veux être exclusif avec moi ?")).toContain(RiskCategory.EMOTIONAL);
    expect(categories("tu veux être exclusive avec moi ?")).toContain(RiskCategory.EMOTIONAL);
  });

  it("accepte les formes annulée et décalée en plus des formes au masculin", () => {
    expect(categories("c'est annulé")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("c'est annulée")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("c'est décalé")).toContain(RiskCategory.ENGAGEMENT);
    expect(categories("c'est décalée")).toContain(RiskCategory.ENGAGEMENT);
  });

  it("capture prêt avec déterminants possessifs et articles", () => {
    // Possessives
    expect(categories("mon prêt")).toContain(RiskCategory.MONEY);
    expect(categories("ton prêt")).toContain(RiskCategory.MONEY);
    expect(categories("son prêt")).toContain(RiskCategory.MONEY);
    expect(categories("notre prêt")).toContain(RiskCategory.MONEY);
    expect(categories("votre prêt")).toContain(RiskCategory.MONEY);
    expect(categories("leur prêt")).toContain(RiskCategory.MONEY);

    // Possessive plurals
    expect(categories("mes prêts")).toContain(RiskCategory.MONEY);
    expect(categories("tes prêts")).toContain(RiskCategory.MONEY);
    expect(categories("ses prêts")).toContain(RiskCategory.MONEY);
    expect(categories("nos prêts")).toContain(RiskCategory.MONEY);
    expect(categories("vos prêts")).toContain(RiskCategory.MONEY);
    expect(categories("leurs prêts")).toContain(RiskCategory.MONEY);

    // Articles
    expect(categories("le prêt")).toContain(RiskCategory.MONEY);
    expect(categories("un prêt")).toContain(RiskCategory.MONEY);

    // But "tu es prêt" must still be empty
    expect(categories("tu es prêt")).toEqual([]);
    expect(categories("tu es prête")).toEqual([]);
  });

  it("capture rembourser et ses variantes", () => {
    expect(categories("je dois rembourser")).toContain(RiskCategory.MONEY);
    expect(categories("je rembourse")).toContain(RiskCategory.MONEY);
    expect(categories("remboursé")).toContain(RiskCategory.MONEY);
  });

  it("capture nu/nue aux singulier et pluriel", () => {
    expect(categories("photo nue")).toContain(RiskCategory.INTIMATE);
    expect(categories("photos nues")).toContain(RiskCategory.INTIMATE);
    expect(categories("je suis nu")).toContain(RiskCategory.INTIMATE);
    expect(categories("je suis nue")).toContain(RiskCategory.INTIMATE);
    expect(categories("elles sont nues")).toContain(RiskCategory.INTIMATE);
    expect(categories("ils sont nus")).toContain(RiskCategory.INTIMATE);
  });
});
