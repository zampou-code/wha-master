import { RiskCategory } from "@/generated/prisma/client";

const LIBELLES: Record<RiskCategory, string> = {
  ENGAGEMENT: "engagement",
  FACT: "question sur toi",
  EMOTIONAL: "émotionnel",
  MONEY: "argent",
  INTIMATE: "intime",
  THIRD_PARTY: "tierce personne",
  LOW_CONFIDENCE: "incertain",
  NON_TEXT: "message non textuel",
};

export function formaterEscalade(params: {
  alias: string;
  risques: RiskCategory[];
  messageRecu: string;
  proposition: string | null;
  motifRefus: string | null;
}): string {
  const risques = params.risques.length
    ? params.risques.map((r) => LIBELLES[r]).join(" + ")
    : "à vérifier";

  const entete = `⚠️ ${params.alias} — ${risques}`;
  const recu = `« ${params.messageRecu} »`;

  if (params.proposition !== null) {
    return [
      entete,
      recu,
      "",
      `Proposition : « ${params.proposition} »`,
      "1 envoyer · 2 <ton texte> · 3 ignorer · 4 pause",
    ].join("\n");
  }

  // Sans proposition, offrir « 1 envoyer » n'aurait aucun sens : on dit ce qui
  // manque et on ne propose que les actions réellement disponibles.
  return [
    entete,
    recu,
    "",
    params.motifRefus ?? "Aucune proposition n'a pu être rédigée.",
    "2 <ton texte> · 3 ignorer · 4 pause",
  ].join("\n");
}
