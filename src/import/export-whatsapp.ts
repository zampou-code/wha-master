import { MediaType } from "@/generated/prisma/client";

/**
 * Analyse d'une discussion exportée depuis WhatsApp (« Exporter la discussion »,
 * sans les médias).
 *
 * C'est la seule source d'historique réellement disponible : GOWA ne connaît
 * que ce qu'il a vu depuis l'appairage, et le reste vit sur le téléphone. Le
 * fichier exporté, lui, contient toute la conversation.
 *
 * Deux formats cohabitent selon le téléphone, et aucun n'est documenté :
 *
 *   [17/10/2026, 14:32:11] Sarah : coucou        (iOS, crochets)
 *   17/10/2026 14:32 - Sarah : coucou            (Android, tiret)
 *
 * S'y ajoutent des espaces insécables avant les deux-points en français, des
 * espaces insécables étroits dans l'heure, un préfixe invisible (U+200E) que
 * WhatsApp place devant certaines lignes, l'heure sur 12 h avec « AM/PM » selon
 * la langue du téléphone, et les messages sur plusieurs lignes dont seule la
 * première porte un horodatage.
 */

export type MessageImporte = {
  horodatage: Date;
  auteur: string;
  texte: string;
  mediaType: MediaType | null;
};

export type Analyse = {
  messages: MessageImporte[];
  auteurs: string[];
  /** Lignes qui ne sont ni un message ni une notification connue. */
  ignorees: number;
  /** `true` si l'ordre jour/mois a été déduit du contenu, `false` s'il est supposé. */
  ordreDeduit: boolean;
};

// U+200E (marque gauche-à-droite) ouvre une ligne sur deux dans les exports
// iOS ; U+202F (espace insécable étroite) sépare l'heure de « AM » ; U+00A0
// précède les deux-points en français. Invisibles à l'œil, fatals à une regex.
const INVISIBLES = /[‎‏‪-‮]/g;

function nettoyer(ligne: string): string {
  return ligne.replace(INVISIBLES, "").replace(/ /g, " ").replace(/ /g, " ");
}

// Deux formes d'en-tête, la date et l'heure capturées à part pour n'écrire
// l'analyse de l'horodatage qu'une fois.
const ENTETES = [
  /^\[(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\]\s*(.*)$/,
  /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s+-\s+(.*)$/,
];

type Entete = {
  premier: number;
  second: number;
  annee: number;
  heure: number;
  minute: number;
  seconde: number;
  reste: string;
};

function lireEntete(ligne: string): Entete | null {
  for (const forme of ENTETES) {
    const trouve = forme.exec(ligne);
    if (!trouve) continue;
    const [, a, b, anneeBrute, heureBrute, minute, seconde, moitie, reste] = trouve;
    let heure = Number(heureBrute);
    if (moitie) {
      const apresMidi = /^[Pp]/.test(moitie);
      // 12 AM = 0 h, 12 PM = 12 h : les deux seuls cas où l'arithmétique
      // naïve se trompe d'une demi-journée.
      heure = heure % 12 + (apresMidi ? 12 : 0);
    }
    const annee = Number(anneeBrute);
    return {
      premier: Number(a),
      second: Number(b),
      annee: annee < 100 ? 2000 + annee : annee,
      heure,
      minute: Number(minute),
      seconde: seconde === undefined ? 0 : Number(seconde),
      reste,
    };
  }
  return null;
}

/**
 * Jour-mois ou mois-jour ? La question n'est pas théorique : un export lu à
 * l'envers décale toute la conversation de plusieurs mois et fait répondre le
 * rédacteur à contretemps.
 *
 * Un seul nombre supérieur à 12 dans le fichier tranche définitivement. Sans
 * lui — une conversation qui tient dans les douze premiers jours du mois — on
 * suppose jour-mois, la forme des exports francophones, et on le signale.
 */
function ordreJourMois(entetes: Entete[]): { jourDabord: boolean; deduit: boolean } {
  for (const entete of entetes) {
    if (entete.premier > 12) return { jourDabord: true, deduit: true };
    if (entete.second > 12) return { jourDabord: false, deduit: true };
  }
  return { jourDabord: true, deduit: false };
}

// Les notifications du système portent un horodatage et pas d'auteur : elles
// n'ont pas à devenir des messages. La liste couvre le français et l'anglais,
// les deux langues dans lesquelles l'application existe.
const NOTIFICATIONS = [
  /chiffr[ée]s? de bout en bout/i,
  /end-to-end encrypted/i,
  /a (cré[ée]|ajout[ée]|retir[ée]|quitt[ée]|chang[ée]|rejoint)/i,
  /(created|added|removed|left|changed|joined)/i,
  /appel (manqu[ée]|vocal|vidéo)/i,
  /missed (voice|video) call/i,
  /messages? supprim[ée]/i,
  /deleted this message|message deleted/i,
  /a modifié (le sujet|l'icône|la description)/i,
  /num[ée]ro de t[ée]l[ée]phone a chang[ée]/i,
  /changed their phone number/i,
  /security code changed|code de s[ée]curit[ée]/i,
];

function estNotification(corps: string): boolean {
  return NOTIFICATIONS.some((forme) => forme.test(corps));
}

// Un média exporté sans les fichiers laisse une mention à sa place. Le texte
// n'existe pas, mais le message a bien eu lieu : l'oublier ferait croire à un
// silence, et le rédacteur lirait une conversation qui n'a jamais existé.
const MEDIAS: ReadonlyArray<readonly [RegExp, MediaType]> = [
  [/image (omise|absente)|image omitted|photo omise/i, MediaType.IMAGE],
  [/vid[ée]o (omise|absente)|video omitted/i, MediaType.VIDEO],
  [/audio omis|audio omitted|message vocal|voice message/i, MediaType.AUDIO],
  [/sticker omis|sticker omitted|autocollant/i, MediaType.STICKER],
  [/document omis|document omitted/i, MediaType.DOCUMENT],
  [/contact omis|contact card omitted|carte de visite/i, MediaType.CONTACT],
  [/localisation|location:|live location/i, MediaType.LOCATION],
  // La forme générique arrive en dernier : « pièce jointe » ne dit pas de quoi
  // il s'agit, et les formes précises ci-dessus doivent gagner.
  [/<\s*(pi[èe]ce jointe|attached)\s*:?[^>]*>/i, MediaType.DOCUMENT],
  [/(fichier|m[ée]dia) omis|media omitted/i, MediaType.DOCUMENT],
];

function typeDeMedia(texte: string): MediaType | null {
  for (const [forme, type] of MEDIAS) {
    if (forme.test(texte)) return type;
  }
  return null;
}

/**
 * Sépare l'auteur du texte. Le piège : un message peut lui-même contenir « : »
 * — une heure, une URL — alors que l'auteur n'en contient jamais. On coupe donc
 * au premier, et on refuse ce qui ressemble à une phrase plutôt qu'à un nom.
 */
const LONGUEUR_MAX_AUTEUR = 60;

function separerAuteur(corps: string): { auteur: string; texte: string } | null {
  const coupe = corps.indexOf(":");
  if (coupe <= 0) return null;
  const auteur = corps.slice(0, coupe).trim();
  if (auteur === "" || auteur.length > LONGUEUR_MAX_AUTEUR || auteur.includes("\n")) return null;
  return { auteur, texte: corps.slice(coupe + 1).trim() };
}

export function analyserExport(contenu: string): Analyse {
  // Les exports iOS utilisent parfois \r\n, et un BOM traîne en tête de
  // fichier : les deux casseraient la première ligne, donc le premier message.
  const lignes = contenu.replace(/^﻿/, "").split(/\r?\n/);

  type Brut = { entete: Entete; corps: string };
  const bruts: Brut[] = [];
  let ignorees = 0;

  for (const ligneBrute of lignes) {
    const ligne = nettoyer(ligneBrute);
    const entete = lireEntete(ligne);
    if (entete) {
      bruts.push({ entete, corps: entete.reste });
      continue;
    }
    if (ligne.trim() === "") {
      // Une ligne vide appartient au message en cours : un paragraphe sauté
      // dans un long message est fréquent, et le supprimer collerait deux
      // phrases qui n'allaient pas ensemble.
      if (bruts.length > 0) bruts[bruts.length - 1].corps += "\n";
      continue;
    }
    if (bruts.length === 0) {
      ignorees += 1;
      continue;
    }
    bruts[bruts.length - 1].corps += `\n${ligne}`;
  }

  const { jourDabord, deduit } = ordreJourMois(bruts.map((brut) => brut.entete));

  const messages: MessageImporte[] = [];
  const auteurs: string[] = [];

  for (const { entete, corps } of bruts) {
    const nettoye = corps.trim();
    if (nettoye === "") {
      ignorees += 1;
      continue;
    }
    const separe = separerAuteur(nettoye);
    if (separe === null || estNotification(nettoye)) {
      // Notification du système : comptée comme ignorée, jamais comme message.
      ignorees += 1;
      continue;
    }

    const jour = jourDabord ? entete.premier : entete.second;
    const mois = jourDabord ? entete.second : entete.premier;
    // Construit en UTC : l'export ne porte aucun décalage horaire, et laisser
    // le fuseau du serveur s'en mêler ferait glisser tous les horodatages d'une
    // conversation entière selon la machine qui l'importe.
    const horodatage = new Date(
      Date.UTC(entete.annee, mois - 1, jour, entete.heure, entete.minute, entete.seconde),
    );
    if (Number.isNaN(horodatage.getTime())) {
      ignorees += 1;
      continue;
    }

    const mediaType = typeDeMedia(separe.texte);
    messages.push({
      horodatage,
      auteur: separe.auteur,
      // Un média sans texte ne laisse qu'une mention de remplacement : la
      // garder comme contenu ferait lire « image omise » au rédacteur.
      texte: mediaType === null ? separe.texte : "",
      mediaType,
    });
    if (!auteurs.includes(separe.auteur)) auteurs.push(separe.auteur);
  }

  return { messages, auteurs, ignorees, ordreDeduit: deduit };
}
