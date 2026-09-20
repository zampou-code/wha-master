import type { ContactMode, DecisionOutcome, RiskCategory } from "@/generated/prisma/client";

export type SignalRisque = {
  categorie: RiskCategory;
  regle: string;
};

export type GardeFous = {
  engagement: boolean;
  facts: boolean;
  emotional: boolean;
  money: boolean;
  intimate: boolean;
  thirdParty: boolean;
};

export type ContexteDecision = {
  mode: ContactMode;
  pauseGlobale: boolean;
  gardeFous: GardeFous;
  intimateOverride: boolean;
  isAdult: boolean;
  signaux: SignalRisque[];
  autoStreak: number;
  maxAutoStreak: number;
  escaladeOuverte: boolean;
  dernierEchangeIlYaJours: number | null;
  classifieurDisponible: boolean;
};

export type Verdict = {
  issue: DecisionOutcome;
  regle: string;
  risques: RiskCategory[];
};
