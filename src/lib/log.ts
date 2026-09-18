export type NiveauLog = "debug" | "info" | "warn" | "error";
export type ChampsLog = Record<string, unknown>;

export interface Journal {
  debug(message: string, champs?: ChampsLog): void;
  info(message: string, champs?: ChampsLog): void;
  warn(message: string, champs?: ChampsLog): void;
  error(message: string, champs?: ChampsLog): void;
  enfant(base: ChampsLog): Journal;
}

// horodatage, niveau et message appartiennent au système : un champ d'appel
// ou de contexte qui porte l'un de ces noms ne doit jamais les écraser (sans
// quoi un opérateur qui filtre sur `message` peut ne plus jamais retrouver
// l'événement réel). Voir la fusion dans emettre().
const CHAMPS_RESERVES = new Set(["horodatage", "niveau", "message"]);

function normaliser(valeur: unknown, niveau: NiveauLog): unknown {
  if (valeur instanceof Error) {
    const erreurNormalisee: ChampsLog = { nom: valeur.name, message: valeur.message };
    // La pile n'est utile qu'au niveau error : l'inclure à info/warn/debug
    // alourdirait des lignes fréquentes pour un diagnostic secondaire.
    if (niveau === "error" && typeof valeur.stack === "string") {
      erreurNormalisee.pile = valeur.stack;
    }
    return erreurNormalisee;
  }
  return valeur;
}

export function creerJournal(
  base: ChampsLog = {},
  ecrire: (ligne: string) => void = (ligne) => process.stdout.write(`${ligne}\n`),
): Journal {
  function fusionner(objet: ChampsLog, source: ChampsLog, niveau: NiveauLog): void {
    for (const [cle, valeur] of Object.entries(source)) {
      const cible = CHAMPS_RESERVES.has(cle) ? `champ_${cle}` : cle;
      objet[cible] = normaliser(valeur, niveau);
    }
  }

  function emettre(niveau: NiveauLog, message: string, champs: ChampsLog = {}): void {
    const objet: ChampsLog = {
      horodatage: new Date().toISOString(),
      niveau,
      message,
    };
    fusionner(objet, base, niveau);
    fusionner(objet, champs, niveau);

    // Un journal qui lève masque l'incident qu'il devait révéler : on dégrade
    // plutôt que d'échouer, quitte à perdre les champs non sérialisables.
    let ligne: string;
    try {
      ligne = JSON.stringify(objet);
    } catch {
      ligne = JSON.stringify({
        horodatage: objet.horodatage,
        niveau,
        message,
        avertissement: "champs non sérialisables omis",
      });
    }

    // Un écrivain personnalisé (tâches ultérieures de la phase 2) peut
    // échouer ; le journal ne doit jamais propager cette erreur, au risque
    // de détruire l'incident qu'il était en train de consigner.
    try {
      ecrire(ligne);
    } catch {
      // Volontairement silencieux : rien de plus à faire ici sans risquer une
      // nouvelle levée.
    }
  }

  return {
    debug: (m, c) => emettre("debug", m, c),
    info: (m, c) => emettre("info", m, c),
    warn: (m, c) => emettre("warn", m, c),
    error: (m, c) => emettre("error", m, c),
    enfant: (supplement) => creerJournal({ ...base, ...supplement }, ecrire),
  };
}

export const log: Journal = creerJournal();
