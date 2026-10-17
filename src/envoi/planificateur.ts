export type ReglagesEnvoi = {
  timezone: string;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  minDelaySec: number;
  maxDelaySec: number;
  /**
   * Délai de réponse médian mesuré sur l'historique (`Thread.medianReplyDelaySec`,
   * écrit par le profilage). Absent tant que le contact n'a pas été analysé.
   */
  medianeReponseSec?: number | null;
};

export type Planification =
  | { envoyable: true; delaiMs: number }
  | { envoyable: false; motif: string; regle: string; reprendreA: Date };

/**
 * Heure locale du contact, dans SA zone, pas celle du serveur.
 *
 * Le serveur tourne à Paris et le propriétaire vit à Abidjan : sans cette
 * conversion, les heures de silence se décaleraient d'une ou deux heures selon
 * la saison, et le système écrirait à quelqu'un en pleine nuit en croyant
 * respecter un réglage.
 */
export function heureLocale(maintenant: Date, timezone: string): number {
  const parties = new Intl.DateTimeFormat("fr-FR", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(maintenant);
  // `format()` rendrait « 23 h » en français, dont `Number()` fait NaN — et un
  // NaN comparé à quoi que ce soit est faux, donc les heures de silence ne se
  // déclenchaient jamais. On lit la partie « heure » plutôt que la chaîne mise
  // en forme pour l'affichage.
  const heure = parties.find((partie) => partie.type === "hour")?.value;
  return Number(heure);
}

/**
 * Vrai quand l'heure tombe dans la plage de silence, y compris quand celle-ci
 * passe minuit (22 h → 7 h est le cas normal, pas l'exception).
 */
export function dansLeSilence(heure: number, debut: number, fin: number): boolean {
  if (debut === fin) return false;
  return debut < fin ? heure >= debut && heure < fin : heure >= debut || heure < fin;
}

function prochaineFinDuSilence(maintenant: Date, timezone: string, fin: number): Date {
  // On avance heure par heure plutôt que de calculer un décalage : c'est la
  // seule façon simple de rester juste au passage à l'heure d'été, où une même
  // heure locale peut exister deux fois ou pas du tout.
  const reprise = new Date(maintenant);
  for (let i = 0; i < 48; i++) {
    reprise.setUTCHours(reprise.getUTCHours() + 1, 0, 0, 0);
    if (heureLocale(reprise, timezone) === fin) return reprise;
  }
  return reprise;
}

// Six caractères par seconde : la vitesse d'un pouce sur un téléphone, relue
// comme « cent mots par minute » dans les deux sens. Ce n'est pas une mesure,
// c'est un ordre de grandeur assumé — l'exactitude n'a pas d'intérêt ici, la
// proportionnalité si.
const CARACTERES_PAR_SECONDE = 6;

// ±35 % autour du délai calculé. Sans variation, deux messages de même longueur
// partiraient au même délai à la seconde près : c'est une signature.
const AMPLITUDE_ALEA = 0.35;

export function planifier(params: {
  maintenant: Date;
  reglages: ReglagesEnvoi;
  /** Longueur du message à envoyer, en caractères. */
  longueurMessage?: number;
  // Injectable pour les tests : le délai est volontairement aléatoire, sinon
  // les envois tomberaient tous au même intervalle et se repéreraient.
  alea?: () => number;
}): Planification {
  const { reglages } = params;
  const debut = reglages.quietHoursStart;
  const fin = reglages.quietHoursEnd;

  // Les deux bornes sont nécessaires : une seule renseignée ne décrit aucune
  // plage, et deviner l'autre reviendrait à inventer un réglage.
  if (debut !== null && fin !== null) {
    const heure = heureLocale(params.maintenant, reglages.timezone);
    if (dansLeSilence(heure, debut, fin)) {
      return {
        envoyable: false,
        regle: "envoi.heures-de-silence",
        motif: `Heures de silence (${debut} h – ${fin} h). L'envoi attend la reprise.`,
        reprendreA: prochaineFinDuSilence(params.maintenant, reglages.timezone, fin),
      };
    }
  }

  const alea = params.alea ?? Math.random;
  const minimum = Math.max(0, reglages.minDelaySec);
  const maximum = Math.max(minimum, reglages.maxDelaySec);

  // Le délai imite l'utilisateur au lieu d'être tiré au hasard dans ses bornes.
  // La conception le demandait depuis le début — « f(temps de réponse médian,
  // longueur du message, heure) » — et le code tirait un uniforme entre min et
  // max, ce qui donnait une moyenne identique pour tout le monde : cinq minutes
  // pour répondre « ok » à quelqu'un qu'on lit d'habitude dans la minute.
  //
  // Trois termes, dans cet ordre :
  //   1. la médiane mesurée, ou le milieu des bornes faute de mesure ;
  //   2. le temps d'écriture, proportionnel à la longueur — un long message ne
  //      peut pas arriver aussi vite qu'un « ok » ;
  //   3. une variation aléatoire, sans laquelle le délai devient une signature.
  const base =
    reglages.medianeReponseSec !== null && reglages.medianeReponseSec !== undefined
      ? reglages.medianeReponseSec
      : (minimum + maximum) / 2;
  const frappe = (params.longueurMessage ?? 0) / CARACTERES_PAR_SECONDE;
  const variation = 1 + (alea() * 2 - 1) * AMPLITUDE_ALEA;
  const secondes = Math.min(maximum, Math.max(minimum, (base + frappe) * variation));
  return { envoyable: true, delaiMs: Math.round(secondes * 1000) };
}
