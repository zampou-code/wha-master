import { RiskCategory } from "@/generated/prisma/client";
import { MARQUEUR_ESCALADE, MARQUEUR_RELANCE } from "@/controle/marqueurs";

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

// Le message reçu est la seule partie non bornée de l'escalade : la proposition
// est déjà plafonnée par la validation du rédacteur. Un contact peut envoyer un
// pavé, et l'escalade est lue sur un téléphone entre deux choses — au-delà de
// cette longueur on coupe, le fil reste consultable dans WhatsApp.
const LONGUEUR_MESSAGE_RECU = 300;

function tronquer(texte: string): string {
  // `[...texte]` découpe en points de code : un `slice` sur les unités UTF-16
  // couperait une paire de substitution en deux et produirait une demi-surrogate
  // au milieu de l'escalade, sur un message qui se termine par des émojis.
  const points = [...texte];
  return points.length > LONGUEUR_MESSAGE_RECU
    ? `${points.slice(0, LONGUEUR_MESSAGE_RECU).join("").trimEnd()}…`
    : texte;
}

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

  const entete = `${MARQUEUR_ESCALADE} ${params.alias} — ${risques}`;
  const recu = `« ${tronquer(params.messageRecu)} »`;

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

/** Combien de temps la conversation est restée muette, en français lisible. */
export function depuis(heures: number): string {
  if (heures < 48) return `${Math.round(heures)} h`;
  const jours = Math.round(heures / 24);
  return jours < 14 ? `${jours} jours` : `${Math.round(jours / 7)} semaines`;
}

/**
 * Une relance proposée dans le groupe de contrôle.
 *
 * Même grammaire de réponses qu'une escalade — « 1 » envoie, « 2 » remplace —
 * parce qu'il n'y a aucune raison d'apprendre deux vocabulaires. Ce qui change
 * est l'en-tête : il n'y a pas de message reçu à citer, mais une durée de
 * silence qui explique pourquoi la question arrive maintenant.
 */
export function formaterRelance(params: {
  alias: string;
  silenceHeures: number;
  proposition: string | null;
  motifRefus: string | null;
}): string {
  const entete = `${MARQUEUR_RELANCE} ${params.alias} — silence depuis ${depuis(params.silenceHeures)}`;

  if (params.proposition !== null) {
    return [
      entete,
      "",
      `Relance proposée : « ${params.proposition} »`,
      "1 envoyer · 2 <ton texte> · 3 laisser tomber · 4 pause",
    ].join("\n");
  }

  return [
    entete,
    "",
    params.motifRefus ?? "Je n'ai pas de relance à proposer.",
    "2 <ton texte> · 3 laisser tomber · 4 pause",
  ].join("\n");
}
