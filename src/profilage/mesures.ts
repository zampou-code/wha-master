/**
 * Ce que l'historique dit, par le calcul plutôt que par un modèle.
 *
 * Les réglages de style sont des grandeurs mesurables : la longueur des
 * messages se compte, les emoji se comptent, le tutoiement se lit, le délai de
 * réponse se chronomètre. Demander ces valeurs à un modèle de langue coûterait
 * un appel, produirait une variation d'un essai à l'autre, et ne pourrait rien
 * prouver. Ici chaque proposition arrive avec son chiffre — c'est ce que la
 * conception appelle « suggestions déduites avec leurs preuves ».
 *
 * Le modèle n'intervient que pour ce qui ne se compte pas : le ton et les
 * sujets.
 */

export type MessageMesure = {
  direction: "IN" | "OUT";
  texte: string | null;
  horodatage: Date;
};

export type Proposition<T> = {
  valeur: T;
  /** Ce qui justifie la proposition, en une phrase chiffrée. */
  preuve: string;
};

export type Mesures = {
  styleLength?: Proposition<"court" | "moyen" | "long">;
  styleEmoji?: Proposition<"jamais" | "parfois" | "souvent">;
  styleFormality?: Proposition<"tutoiement" | "vouvoiement">;
  styleInitiative?: Proposition<"jamais" | "rare" | "souvent">;
  minDelaySec?: Proposition<number>;
  maxDelaySec?: Proposition<number>;
  /** Délai de réponse médian de l'utilisateur, en secondes. */
  medianeReponseSec: number | null;
  /** Nombre de messages sortants sur lesquels les mesures portent. */
  sortants: number;
};

// En dessous, une mesure ne mesure rien : trois messages ne font pas un style,
// et proposer un réglage sur cette base donnerait une fausse assurance.
const MINIMUM_SORTANTS = 15;

// Au-delà de cette coupure, on ne parle plus d'un délai de réponse mais d'une
// conversation reprise plus tard : l'inclure ferait exploser la médiane.
const COUPURE_REPONSE_SEC = 6 * 3600;

function mediane(valeurs: number[]): number | null {
  if (valeurs.length === 0) return null;
  const tries = [...valeurs].sort((a, b) => a - b);
  const milieu = Math.floor(tries.length / 2);
  return tries.length % 2 === 1
    ? tries[milieu]
    : Math.round((tries[milieu - 1] + tries[milieu]) / 2);
}

// Les emoji de WhatsApp ne tiennent pas dans une plage Unicode unique : les
// pictogrammes, les émoticônes, les symboles divers et les drapeaux vivent dans
// des blocs séparés. `\p{Extended_Pictographic}` les couvre tous, et c'est la
// seule forme qui n'oublie pas la moitié des visages.
const EMOJI = /\p{Extended_Pictographic}/u;

/**
 * Le vouvoiement se reconnaît à des formes conjuguées, pas au mot « vous »
 * seul : « vous » apparaît aussi dans « rendez-vous », qui n'a rien à voir.
 *
 * Les bornes de mot sont écrites en lettres Unicode et non avec `\b` : `\b` ne
 * connaît que l'ASCII, donc il voit une frontière de mot entre « ê » et « t ».
 * « êtes » contenait alors « tes », compté comme un tutoiement — et une
 * conversation entièrement vouvoyée ressortait tutoyée.
 */
function mot(corps: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${corps})(?![\\p{L}\\p{N}_])`, "iu");
}

const VOUVOIEMENT = mot(
  "vous\\s+(?:ê|av|all|pouv|voul|dev|sav|fai|ven|di)\\p{L}*|votre|vos",
);
const TUTOIEMENT = mot("tu|t['\u2019](?:es|as|a)|ton|ta|tes|toi");

export function mesurer(messages: MessageMesure[]): Mesures {
  const ordonnes = [...messages].sort(
    (a, b) => a.horodatage.getTime() - b.horodatage.getTime(),
  );
  const sortants = ordonnes.filter((message) => message.direction === "OUT");
  const textesSortants = sortants
    .map((message) => message.texte?.trim())
    .filter((texte): texte is string => texte !== undefined && texte !== "");

  // Le délai de réponse de l'utilisateur : le temps entre un message reçu et sa
  // première réponse. C'est ce que le planificateur doit imiter — répondre en
  // quarante secondes quand on met habituellement un quart d'heure se remarque.
  const delais: number[] = [];
  for (let index = 1; index < ordonnes.length; index += 1) {
    const precedent = ordonnes[index - 1];
    const courant = ordonnes[index];
    if (precedent.direction !== "IN" || courant.direction !== "OUT") continue;
    const secondes = (courant.horodatage.getTime() - precedent.horodatage.getTime()) / 1000;
    if (secondes <= 0 || secondes > COUPURE_REPONSE_SEC) continue;
    delais.push(Math.round(secondes));
  }
  const medianeReponseSec = mediane(delais);

  const mesures: Mesures = { medianeReponseSec, sortants: textesSortants.length };

  if (textesSortants.length < MINIMUM_SORTANTS) return mesures;

  // Longueur : la médiane, pas la moyenne. Un seul message très long — une
  // explication, une dispute — décalerait la moyenne et ferait proposer « long »
  // pour une conversation faite de trois mots.
  const longueurs = textesSortants.map((texte) => texte.length);
  const longueurMediane = mediane(longueurs)!;
  const longueur = longueurMediane < 40 ? "court" : longueurMediane < 140 ? "moyen" : "long";
  mesures.styleLength = {
    valeur: longueur,
    preuve: `Tes messages font ${longueurMediane} caractères en médiane sur ${textesSortants.length} messages.`,
  };

  const avecEmoji = textesSortants.filter((texte) => EMOJI.test(texte)).length;
  const partEmoji = avecEmoji / textesSortants.length;
  const emoji = partEmoji < 0.1 ? "jamais" : partEmoji < 0.45 ? "parfois" : "souvent";
  mesures.styleEmoji = {
    valeur: emoji,
    preuve: `${Math.round(partEmoji * 100)} % de tes messages contiennent un emoji (${avecEmoji} sur ${textesSortants.length}).`,
  };

  const vouvoie = textesSortants.filter((texte) => VOUVOIEMENT.test(texte)).length;
  const tutoie = textesSortants.filter((texte) => TUTOIEMENT.test(texte)).length;
  if (vouvoie + tutoie > 0) {
    const formalite = vouvoie > tutoie ? "vouvoiement" : "tutoiement";
    mesures.styleFormality = {
      valeur: formalite,
      preuve:
        formalite === "vouvoiement"
          ? `${vouvoie} messages vouvoient, ${tutoie} tutoient.`
          : `${tutoie} messages tutoient, ${vouvoie} vouvoient.`,
    };
  }

  // Initiative : qui ouvre la journée. Un message qui suit le précédent de plus
  // de six heures recommence la conversation ; celui qui l'écrit la relance.
  let relancesUtilisateur = 0;
  let relancesTotales = 0;
  for (let index = 0; index < ordonnes.length; index += 1) {
    const precedent = ordonnes[index - 1];
    const ecart = precedent
      ? (ordonnes[index].horodatage.getTime() - precedent.horodatage.getTime()) / 1000
      : Infinity;
    if (ecart <= COUPURE_REPONSE_SEC) continue;
    relancesTotales += 1;
    if (ordonnes[index].direction === "OUT") relancesUtilisateur += 1;
  }
  if (relancesTotales >= 3) {
    const part = relancesUtilisateur / relancesTotales;
    const initiative = part < 0.15 ? "jamais" : part < 0.5 ? "rare" : "souvent";
    mesures.styleInitiative = {
      valeur: initiative,
      preuve: `Tu relances la conversation ${relancesUtilisateur} fois sur ${relancesTotales} reprises.`,
    };
  }

  if (medianeReponseSec !== null && delais.length >= 5) {
    // Les bornes encadrent la médiane mesurée plutôt que de la viser : un délai
    // toujours identique se repère autant qu'un délai absurde. Plancher à
    // quinze secondes, parce que personne ne lit et répond en moins.
    const bas = Math.max(15, Math.round(medianeReponseSec * 0.5));
    const haut = Math.max(bas + 30, Math.round(medianeReponseSec * 2));
    const minutes = Math.round(medianeReponseSec / 60);
    const lisible = medianeReponseSec < 90 ? `${medianeReponseSec} s` : `${minutes} min`;
    mesures.minDelaySec = {
      valeur: bas,
      preuve: `Tu réponds en ${lisible} en médiane (${delais.length} réponses mesurées).`,
    };
    mesures.maxDelaySec = {
      valeur: haut,
      preuve: `Deux fois ta médiane de ${lisible}, pour que le délai varie sans se remarquer.`,
    };
  }

  return mesures;
}
