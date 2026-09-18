import type { RiskCategory } from "@/generated/prisma/client";

export type SignalRisque = {
  categorie: RiskCategory;
  regle: string;
};
