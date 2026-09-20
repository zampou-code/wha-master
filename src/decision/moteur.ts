import { ContactMode, DecisionOutcome, RiskCategory } from "@/generated/prisma/client";
import type { ContexteDecision, GardeFous, Verdict } from "./types";

const JOURS_AVANT_DORMANCE = 7;

// LOW_CONFIDENCE et NON_TEXT ne sont rattachés à aucun drapeau : ils ne sont
// désactivables nulle part, par construction.
const TOUJOURS_ACTIFS: ReadonlySet<RiskCategory> = new Set([
  RiskCategory.LOW_CONFIDENCE,
  RiskCategory.NON_TEXT,
]);

function gardeFouActif(categorie: RiskCategory, contexte: ContexteDecision): boolean {
  if (TOUJOURS_ACTIFS.has(categorie)) return true;

  if (categorie === RiskCategory.INTIMATE) {
    // La dérogation ne vaut que si le contact est explicitement marqué adulte.
    // Le marquage est vérifié ici en plus de la base : une incohérence de
    // données ne doit pas ouvrir la porte.
    if (contexte.intimateOverride && contexte.isAdult) return false;
    return contexte.gardeFous.intimate;
  }

  const drapeaux: Partial<Record<RiskCategory, keyof GardeFous>> = {
    [RiskCategory.ENGAGEMENT]: "engagement",
    [RiskCategory.FACT]: "facts",
    [RiskCategory.EMOTIONAL]: "emotional",
    [RiskCategory.MONEY]: "money",
    [RiskCategory.THIRD_PARTY]: "thirdParty",
  };

  const drapeau = drapeaux[categorie];
  return drapeau ? contexte.gardeFous[drapeau] : true;
}

export function decider(contexte: ContexteDecision): Verdict {
  const risques = contexte.signaux.map((signal) => signal.categorie);

  // Gate 0 — P1. Avant tout le reste.
  if (contexte.mode === ContactMode.OFF) {
    return { issue: DecisionOutcome.IGNORED, regle: "gate0.mode-off", risques };
  }
  if (contexte.pauseGlobale) {
    return { issue: DecisionOutcome.IGNORED, regle: "gate0.pause-globale", risques };
  }

  // Risques croisant un garde-fou actif.
  const declencheur = contexte.signaux.find((signal) => gardeFouActif(signal.categorie, contexte));
  if (declencheur) {
    return {
      issue: DecisionOutcome.ESCALATED,
      regle: `risque.${declencheur.regle}`,
      risques,
    };
  }

  // Gate 3 — quotas et contexte.
  if (!contexte.classifieurDisponible) {
    return { issue: DecisionOutcome.ESCALATED, regle: "gate3.classifieur-indisponible", risques };
  }
  if (contexte.escaladeOuverte) {
    return { issue: DecisionOutcome.ESCALATED, regle: "gate3.escalade-ouverte", risques };
  }
  if (contexte.autoStreak >= contexte.maxAutoStreak) {
    return { issue: DecisionOutcome.ESCALATED, regle: "gate3.streak-plafond", risques };
  }
  if (
    contexte.dernierEchangeIlYaJours !== null &&
    contexte.dernierEchangeIlYaJours > JOURS_AVANT_DORMANCE
  ) {
    return { issue: DecisionOutcome.ESCALATED, regle: "gate3.conversation-dormante", risques };
  }

  if (contexte.mode === ContactMode.AUTO) {
    return { issue: DecisionOutcome.AUTO_SENT, regle: "table.auto", risques };
  }
  return { issue: DecisionOutcome.DRAFTED, regle: "table.brouillon", risques };
}
