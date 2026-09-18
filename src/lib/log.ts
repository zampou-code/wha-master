export type NiveauLog = "debug" | "info" | "warn" | "error";
export type ChampsLog = Record<string, unknown>;

export interface Journal {
  debug(message: string, champs?: ChampsLog): void;
  info(message: string, champs?: ChampsLog): void;
  warn(message: string, champs?: ChampsLog): void;
  error(message: string, champs?: ChampsLog): void;
  enfant(base: ChampsLog): Journal;
}

function normaliser(valeur: unknown): unknown {
  if (valeur instanceof Error) {
    return { nom: valeur.name, message: valeur.message };
  }
  return valeur;
}

export function creerJournal(
  base: ChampsLog = {},
  ecrire: (ligne: string) => void = (ligne) => process.stdout.write(`${ligne}\n`),
): Journal {
  function emettre(niveau: NiveauLog, message: string, champs: ChampsLog = {}): void {
    const objet: ChampsLog = {
      horodatage: new Date().toISOString(),
      niveau,
      message,
    };
    for (const [cle, valeur] of Object.entries(base)) objet[cle] = normaliser(valeur);
    for (const [cle, valeur] of Object.entries(champs)) objet[cle] = normaliser(valeur);

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
    ecrire(ligne);
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
