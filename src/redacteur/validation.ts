import type { ContexteRedaction } from "./contexte";

export type BrouillonBrut = {
  reply: string;
  factsUsed: string[];
  needsFact: string | null;
};

export type ResultatValidation =
  | { valide: true; texte: string }
  | { valide: false; motif: string; regle: string };

const LONGUEUR_MAX: Record<string, number> = {
  court: 240,
  moyen: 500,
  long: 900,
};

function normaliser(texte: string): string {
  return texte.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// P4 en code, pas en consigne. Un modèle peut ignorer une instruction de prompt ;
// il ne peut pas passer à travers ces quatre contrôles. Chacun invalide le
// brouillon, ce qui provoque une escalade : le système demande plutôt qu'il
// invente.
export function validerBrouillon(
  brouillon: BrouillonBrut,
  contexte: ContexteRedaction,
): ResultatValidation {
  if (brouillon.needsFact !== null && brouillon.needsFact.trim() !== "") {
    return {
      valide: false,
      regle: "p4.fait-manquant",
      motif: `Le rédacteur a besoin d'une information que tu n'as pas renseignée : ${brouillon.needsFact}`,
    };
  }

  const connus = new Set(contexte.faits.map((f) => f.id));
  const inconnu = brouillon.factsUsed.find((id) => !connus.has(id));
  if (inconnu !== undefined) {
    return {
      valide: false,
      regle: "p4.fait-inconnu",
      motif: `Le rédacteur s'est appuyé sur un fait qui n'existe pas dans ta fiche (${inconnu}).`,
    };
  }

  const texte = brouillon.reply.trim();
  if (texte === "") {
    return { valide: false, regle: "p4.brouillon-vide", motif: "Le rédacteur n'a rien produit." };
  }

  const maximum = LONGUEUR_MAX[contexte.stylePolitique.longueur] ?? LONGUEUR_MAX.moyen;
  if (texte.length > maximum) {
    return {
      valide: false,
      regle: "p4.longueur",
      motif: `Le brouillon fait ${texte.length} caractères, au-delà des ${maximum} du style demandé.`,
    };
  }

  const normalise = normaliser(texte);
  const limite = contexte.hardLimits.find((l) => l.trim() !== "" && normalise.includes(normaliser(l)));
  if (limite !== undefined) {
    return {
      valide: false,
      regle: "p4.limite-dure",
      motif: `Le brouillon heurte une de tes limites : « ${limite} ».`,
    };
  }

  return { valide: true, texte };
}
