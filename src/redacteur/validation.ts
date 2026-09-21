import { flechi } from "@/decision/regles-lexicales";
import type { ContexteRedaction } from "./contexte";

export type BrouillonBrut = {
  reply: string;
  factsUsed: string[];
  needsFact: string | null;
};

export type ResultatValidation =
  | { valide: true; texte: string }
  | { valide: false; motif: string; regle: string };

// Une Map n'hérite d'aucune clé (contrairement à un objet littéral, où
// `LONGUEUR_MAX["constructor"]` renvoie silencieusement `Object` au lieu
// d'`undefined` et contourne le contrôle de longueur). `stylePolitique.longueur`
// est une chaîne libre en base : rien n'empêche qu'elle porte un jour la
// valeur d'une clé du prototype.
const LONGUEUR_MAX = new Map<string, number>([
  ["court", 240],
  ["moyen", 500],
  ["long", 900],
]);
const LONGUEUR_DEFAUT = 500;

function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    // Diacritiques combinants (U+0300–U+036F) : écrits en échappement plutôt
    // qu'en caractères combinants bruts dans le code source, pour rester
    // lisibles à la relecture et ne pas se faire recomposer en NFC par un
    // outil qui normaliserait le fichier lui-même.
    .replace(/[\u0300-\u036f]/g, "")
    // Apostrophes et guillemets typographiques : macOS corrige `'` en `’`
    // automatiquement, donc une limite tapée avec l'une et un brouillon
    // produit avec l'autre doivent tout de même se rencontrer.
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u0153/g, "oe")
    .replace(/\u00e6/g, "ae")
    .replace(/\s+/g, " ")
    .trim();
}

// Vérifie qu'un terme interdit apparaît comme mot entier, pas comme sous-chaîne :
// sans frontière, un terme comme « prêt » bloquerait « sous prétexte ». `flechi`
// étend ensuite le terme échappé aux accords français courants (masculin,
// féminin, singulier, pluriel) : sans lui, un terme interdit « déçu » ne
// bloque pas « déçue » — l'angle mort qui a déjà coûté plusieurs tours de
// correction ailleurs dans ce projet.
function contientMot(texte: string, terme: string): boolean {
  if (terme === "") return false;
  const echappe = terme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${flechi(echappe)}([^\\p{L}\\p{N}]|$)`, "u").test(texte);
}

// P4 en code, pas en consigne. Un modèle peut ignorer une instruction de prompt ;
// il ne peut pas passer à travers ces cinq contrôles. Chacun invalide le
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

  // Un fait peut être cité par `id` (cuid technique) ou par `key` (lisible,
  // et déjà unique en base) : un modèle qui rédige un message intime rend le
  // plus souvent la clé lisible, jamais le cuid.
  const connus = new Set(contexte.faits.flatMap((f) => [f.id, f.key]));
  const inconnu = brouillon.factsUsed.find((id) => !connus.has(id));
  if (inconnu !== undefined) {
    return {
      valide: false,
      regle: "p4.fait-inconnu",
      motif: `Le rédacteur s'est appuyé sur « ${inconnu} », qui ne fait pas partie des informations que tu as marquées partageables. Je n'envoie rien.`,
    };
  }

  const texte = brouillon.reply.trim();
  if (texte === "") {
    return { valide: false, regle: "p4.brouillon-vide", motif: "Le rédacteur n'a rien produit." };
  }

  const maximum = LONGUEUR_MAX.get(contexte.stylePolitique.longueur) ?? LONGUEUR_DEFAUT;
  if (texte.length > maximum) {
    return {
      valide: false,
      regle: "p4.longueur",
      motif: `Le brouillon fait ${texte.length} caractères, au-delà des ${maximum} du style demandé.`,
    };
  }

  // `hardLimits` reste une consigne en langue naturelle destinée au prompt
  // (« Ne jamais parler d'argent ») : aucun brouillon ne contiendra jamais
  // cette phrase littéralement. La garde mécanique porte sur `termesInterdits`,
  // des mots concrets que le propriétaire a explicitement bannis.
  const normalise = normaliser(texte);
  const terme = contexte.termesInterdits.find((t) => t.trim() !== "" && contientMot(normalise, normaliser(t)));
  if (terme !== undefined) {
    return {
      valide: false,
      regle: "p4.limite-dure",
      motif: `Le brouillon emploie « ${terme} », que tu as interdit. Je n'envoie rien.`,
    };
  }

  return { valide: true, texte };
}
