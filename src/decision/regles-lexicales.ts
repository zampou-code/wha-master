import { MediaType, RiskCategory } from "@/generated/prisma/client";
import type { SignalRisque } from "./types";

type Regle = {
  nom: string;
  categorie: RiskCategory;
  motif: RegExp;
};

// Normalisation : minuscules et accents retirés, pour qu'une règle écrite une
// fois attrape « à quelle heure », « a quelle heure » et « À QUELLE HEURE ».
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Les suffixes d'accord français courants pour un participe/adjectif : rien
// (masculin singulier), e (féminin), ee (féminin — accent tombé par la
// normalisation, ex. "décidée"), s et es/ees au pluriel. Six combinaisons.
const SUFFIXES_ACCORD = ["", "e", "ee", "s", "es", "ees"] as const;

// Terminaisons du futur simple et de l'imparfait pour les verbes du premier
// groupe (radical + -er), collées directement au radical.
const SUFFIXES_FUTUR = ["erai", "eras", "era", "erons", "erez", "eront"] as const;
const SUFFIXES_IMPARFAIT = ["ais", "ait", "ions", "iez", "aient"] as const;

// Construit un fragment de motif qui accepte les flexions françaises
// courantes d'un radical : masculin, féminin, singulier, pluriel. Écrire
// `flechi("annul")` plutôt que `annulee?` évite l'angle mort qui a coûté
// plusieurs tours de correction : une forme oubliée ne déclenche rien, et
// rien ne le signale. Le fragment produit doit être composé avec `new
// RegExp(...)` — un littéral `/…/` ne peut pas interpoler une chaîne.
function flechi(radical: string): string {
  return `${radical}(?:e(?:e)?)?(?:s)?`;
}

// Énumère les mêmes formes que `flechi` produit, mais comme chaînes
// concrètes plutôt que comme fragment de motif. Utilisé pour dériver les
// tests directement de la table de radicaux plutôt que d'énumérer les formes
// à la main : les deux fonctions partagent `SUFFIXES_ACCORD`, donc elles ne
// peuvent pas diverger silencieusement.
function formesFlechies(radical: string): string[] {
  return SUFFIXES_ACCORD.map((suffixe) => `${radical}${suffixe}`);
}

// Un radical de verbe fléchi ne couvre que l'accord (participe/adjectif).
// Une promesse ou une annulation s'exprime aussi au futur (« j'annulerai »)
// et à l'imparfait (« je décalais toujours ») — des formes que le modèle
// d'accord seul ne couvre pas. `conjugue` étend `flechi` avec l'infinitif, le
// futur simple et l'imparfait des verbes du premier groupe concernés
// (annul-er, décal-er, rembours-er).
function conjugue(radical: string): string {
  return formesVerbe(radical).join("|");
}

function formesVerbe(radical: string): string[] {
  return [
    ...formesFlechies(radical),
    `${radical}er`,
    ...SUFFIXES_FUTUR.map((suffixe) => `${radical}${suffixe}`),
    ...SUFFIXES_IMPARFAIT.map((suffixe) => `${radical}${suffixe}`),
  ];
}

type RadicalDeclare = {
  radical: string;
  categorie: RiskCategory;
  // Le contexte minimal requis par la règle pour que la forme fléchie soit
  // effectivement évaluée : par défaut la forme seule suffit, mais certaines
  // règles exigent un entourage (ex. fait.relation exige « tu es » avant
  // l'accord de « marié »). Sert à dériver un texte d'entrée réaliste dans
  // les tests, sans changer le motif de production.
  dansContexte?: (forme: string) => string;
};

// Source unique des radicaux dont l'accord seul varie. Exportée pour que les
// tests dérivent leurs assertions de cette table plutôt que d'énumérer des
// formes à la main.
export const RADICAUX_FLECHIS: readonly RadicalDeclare[] = [
  { radical: "mari", categorie: RiskCategory.FACT, dansContexte: (forme) => `tu es ${forme}` },
  { radical: "decu", categorie: RiskCategory.EMOTIONAL },
  { radical: "blesse", categorie: RiskCategory.EMOTIONAL },
  { radical: "vexe", categorie: RiskCategory.EMOTIONAL },
  { radical: "deprime", categorie: RiskCategory.EMOTIONAL },
  { radical: "nu", categorie: RiskCategory.INTIMATE },
];

// Source unique des radicaux de verbe (accord + infinitif + futur + imparfait).
export const RADICAUX_VERBES: readonly RadicalDeclare[] = [
  { radical: "annul", categorie: RiskCategory.ENGAGEMENT },
  { radical: "decal", categorie: RiskCategory.ENGAGEMENT },
  { radical: "rembours", categorie: RiskCategory.MONEY },
];

export { flechi, formesFlechies, formesVerbe };

// Ces motifs sont délibérément larges. Un faux positif coûte une escalade que
// l'utilisateur balaie d'un geste ; un faux négatif envoie un message qui
// l'engage. L'asymétrie commande la sensibilité.
const REGLES: readonly Regle[] = [
  { nom: "engagement.rendez-vous", categorie: RiskCategory.ENGAGEMENT, motif: /\b(on se voit|se voir|se retrouve|rendez[- ]?vous|rdv)\b/ },
  { nom: "engagement.disponibilite", categorie: RiskCategory.ENGAGEMENT, motif: /\b(dispo|disponible|libre)\b.*\b(demain|ce soir|week[- ]?end|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b|\b(demain|ce soir|week[- ]?end|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b.*\b(dispo|disponible|libre)\b|\btu fais quoi.*\b(demain|ce soir|week[- ]?end|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b/ },
  { nom: "engagement.horaire", categorie: RiskCategory.ENGAGEMENT, motif: /\b(a|vers|pour)\s*\d{1,2}\s*(h|heures?)\b|\bquelle heure\b/ },
  { nom: "engagement.invitation", categorie: RiskCategory.ENGAGEMENT, motif: /\b(je passe|tu passes|viens|je viens|chez toi|chez moi|je t'?emmene|je te prends)\b/ },
  { nom: "engagement.annulation", categorie: RiskCategory.ENGAGEMENT, motif: new RegExp(`\\b(${conjugue("annul")}|${conjugue("decal")}|reporter|je peux plus)\\b`) },

  { nom: "fait.identite", categorie: RiskCategory.FACT, motif: /\bt'?u? ?as quel age\b|\btu as quel age\b|\bquel age\b/ },
  { nom: "fait.travail", categorie: RiskCategory.FACT, motif: /\btu (travailles|bosses)\b|\bton (travail|boulot|job|metier)\b/ },
  { nom: "fait.lieu", categorie: RiskCategory.FACT, motif: /\btu (habites|vis|es) ou\b|\btu viens d'?ou\b/ },
  { nom: "fait.relation", categorie: RiskCategory.FACT, motif: new RegExp(`\\btu es (celibataire|en couple|${flechi("mari")})\\b|\\btu as (une copine|quelqu'?un|des enfants)\\b`) },

  { nom: "emotionnel.sentiments", categorie: RiskCategory.EMOTIONAL, motif: /\bje t'? ?aime\b|\btu me manques\b|\bje pense a toi\b|\bje tiens a toi\b/ },
  { nom: "emotionnel.statut", categorie: RiskCategory.EMOTIONAL, motif: /\bon est quoi\b|\bc'?est quoi nous\b|\bon sort ensemble\b|\btu ressens quoi\b|\b(?:exclusif|exclusive)\b/ },
  { nom: "emotionnel.conflit", categorie: RiskCategory.EMOTIONAL, motif: new RegExp(`\\b(${flechi("decu")}|${flechi("blesse")}|${flechi("vexe")}|en colere|tu m'?ignores|tu reponds jamais|ca me fait mal)\\b`) },
  { nom: "emotionnel.detresse", categorie: RiskCategory.EMOTIONAL, motif: new RegExp(`\\b(je vais mal|${flechi("deprime")}|j'?en peux plus|je suis triste|aide moi)\\b`) },

  // R10/finding-4 : un montant s'écrit couramment sans unité de devise dans ce
  // contexte (« envoie moi 50000 »). On exige 3 à 7 chiffres bornés par des
  // limites de mot (\b…\b) juste après le verbe : cette borne exclut déjà, par
  // construction, tout numéro de téléphone contigu de 8 chiffres ou plus — y
  // compris les numéros locaux à 10 chiffres commençant par 0 — puisqu'aucune
  // sous-séquence de 3 à 7 chiffres d'un bloc plus long ne peut satisfaire les
  // deux limites de mot en même temps.
  { nom: "argent.demande", categorie: RiskCategory.MONEY, motif: /\b(envoie|envoyer|preter|prete|donne|donner)\b.*\b\d{3,7}\b/ },
  { nom: "argent.vocabulaire", categorie: RiskCategory.MONEY, motif: new RegExp(`\\b(?:un|une|le|la|les|des|ce|ces|mon|ton|son|notre|votre|leur|mes|tes|ses|nos|vos|leurs)\\s+prets?\\b|\\bpret\\s+(?:de|bancaire)|\\b(credits?|dettes?|${conjugue("rembours")}|virements?|mobile money|wave|orange money)\\b|\\bbesoin d'?argent\\b`) },

  { nom: "intime.photo", categorie: RiskCategory.INTIMATE, motif: /\b(envoie|montre|tu m'?envoies)\b.*\b(photo|pic|nude|image de toi)\b|\bphoto de toi\b/ },
  { nom: "intime.explicite", categorie: RiskCategory.INTIMATE, motif: new RegExp(`\\b(${flechi("nu")}|nudes?|sexe|coucher ensemble|au lit avec)\\b`) },

  { nom: "tiers.personne-nommee", categorie: RiskCategory.THIRD_PARTY, motif: /\b(ta|ton|sa|son) (copine|copain|femme|mari|ex|soeur|frere|mere|pere)\b/ },
];

export function evaluerReglesLexicales(
  texte: string | null,
  typeMedia: MediaType | null,
): SignalRisque[] {
  const signaux: SignalRisque[] = [];

  // Un média n'est pas lisible par le classifieur : il escalade toujours.
  if (typeMedia !== null) {
    signaux.push({ categorie: RiskCategory.NON_TEXT, regle: `media.${typeMedia.toLowerCase()}` });
  }

  const contenu = texte?.trim() ?? "";
  if (contenu === "") {
    if (typeMedia === null) {
      signaux.push({ categorie: RiskCategory.LOW_CONFIDENCE, regle: "contenu.vide" });
    }
    return signaux;
  }

  const normalise = normaliser(contenu);
  for (const regle of REGLES) {
    if (regle.motif.test(normalise)) {
      signaux.push({ categorie: regle.categorie, regle: regle.nom });
    }
  }
  return signaux;
}
