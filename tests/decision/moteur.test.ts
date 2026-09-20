import { describe, it, expect } from "vitest";
import { decider } from "@/decision/moteur";
import type { ContexteDecision } from "@/decision/types";
import { ContactMode, DecisionOutcome, RiskCategory } from "@/generated/prisma/client";

function contexte(surcharge: Partial<ContexteDecision> = {}): ContexteDecision {
  return {
    mode: ContactMode.AUTO,
    pauseGlobale: false,
    gardeFous: { engagement: true, facts: true, emotional: true, money: true, intimate: true, thirdParty: true },
    intimateOverride: false,
    isAdult: false,
    signaux: [],
    autoStreak: 0,
    maxAutoStreak: 6,
    escaladeOuverte: false,
    dernierEchangeIlYaJours: 0,
    classifieurDisponible: true,
    ...surcharge,
  };
}

describe("moteur de décision", () => {
  it("ignore un contact en OFF, même avec des risques (P1)", () => {
    const verdict = decider(contexte({
      mode: ContactMode.OFF,
      signaux: [{ categorie: RiskCategory.ENGAGEMENT, regle: "r" }],
    }));
    expect(verdict.issue).toBe(DecisionOutcome.IGNORED);
    expect(verdict.regle).toMatch(/opt-in|mode/i);
  });

  it("ignore tout quand la pause globale est active", () => {
    expect(decider(contexte({ pauseGlobale: true })).issue).toBe(DecisionOutcome.IGNORED);
  });

  it("escalade quand un risque croise un garde-fou actif", () => {
    const verdict = decider(contexte({ signaux: [{ categorie: RiskCategory.MONEY, regle: "argent.demande" }] }));
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
    expect(verdict.risques).toContain(RiskCategory.MONEY);
  });

  it("n'escalade pas sur une catégorie dont le garde-fou est désactivé", () => {
    const verdict = decider(contexte({
      gardeFous: { engagement: false, facts: true, emotional: true, money: true, intimate: true, thirdParty: true },
      signaux: [{ categorie: RiskCategory.ENGAGEMENT, regle: "r" }],
    }));
    expect(verdict.issue).toBe(DecisionOutcome.AUTO_SENT);
  });

  it("lève INTIMATE seulement si l'override est actif ET le contact marqué adulte", () => {
    const signaux = [{ categorie: RiskCategory.INTIMATE, regle: "r" }];
    expect(decider(contexte({ signaux, intimateOverride: true, isAdult: false })).issue)
      .toBe(DecisionOutcome.ESCALATED);
    expect(decider(contexte({ signaux, intimateOverride: true, isAdult: true })).issue)
      .toBe(DecisionOutcome.AUTO_SENT);
  });

  it("escalade toujours sur LOW_CONFIDENCE, garde-fou non désactivable", () => {
    const verdict = decider(contexte({
      gardeFous: { engagement: false, facts: false, emotional: false, money: false, intimate: false, thirdParty: false },
      signaux: [{ categorie: RiskCategory.LOW_CONFIDENCE, regle: "r" }],
    }));
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
  });

  it("escalade toujours sur NON_TEXT, garde-fou non désactivable", () => {
    const verdict = decider(contexte({
      gardeFous: { engagement: false, facts: false, emotional: false, money: false, intimate: false, thirdParty: false },
      signaux: [{ categorie: RiskCategory.NON_TEXT, regle: "media.audio" }],
    }));
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
  });

  it("escalade quand le streak automatique dépasse le plafond", () => {
    const verdict = decider(contexte({ autoStreak: 6, maxAutoStreak: 6 }));
    expect(verdict.issue).toBe(DecisionOutcome.ESCALATED);
    expect(verdict.regle).toMatch(/streak/);
  });

  it("escalade quand une escalade est déjà ouverte sur le fil", () => {
    expect(decider(contexte({ escaladeOuverte: true })).issue).toBe(DecisionOutcome.ESCALATED);
  });

  it("escalade quand la conversation est dormante depuis plus de 7 jours", () => {
    expect(decider(contexte({ dernierEchangeIlYaJours: 8 })).issue).toBe(DecisionOutcome.ESCALATED);
    expect(decider(contexte({ dernierEchangeIlYaJours: 7 })).issue).toBe(DecisionOutcome.AUTO_SENT);
  });

  it("escalade quand le classifieur est indisponible", () => {
    expect(decider(contexte({ classifieurDisponible: false })).issue).toBe(DecisionOutcome.ESCALATED);
  });

  it("produit un brouillon en mode DRAFT plutôt qu'un envoi", () => {
    expect(decider(contexte({ mode: ContactMode.DRAFT })).issue).toBe(DecisionOutcome.DRAFTED);
  });

  it("autorise l'envoi seulement quand tout est calme et le mode AUTO", () => {
    expect(decider(contexte()).issue).toBe(DecisionOutcome.AUTO_SENT);
  });

  it("nomme toujours la règle qui a tranché", () => {
    expect(decider(contexte()).regle).not.toBe("");
  });
});
