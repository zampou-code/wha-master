export type ReglagesEnvoi = {
  timezone: string;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  minDelaySec: number;
  maxDelaySec: number;
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

export function planifier(params: {
  maintenant: Date;
  reglages: ReglagesEnvoi;
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
  const secondes = minimum + alea() * (maximum - minimum);
  return { envoyable: true, delaiMs: Math.round(secondes * 1000) };
}
