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

// Ces motifs sont délibérément larges. Un faux positif coûte une escalade que
// l'utilisateur balaie d'un geste ; un faux négatif envoie un message qui
// l'engage. L'asymétrie commande la sensibilité.
const REGLES: readonly Regle[] = [
  { nom: "engagement.rendez-vous", categorie: RiskCategory.ENGAGEMENT, motif: /\b(on se voit|se voir|se retrouve|rendez[- ]?vous|rdv)\b/ },
  { nom: "engagement.disponibilite", categorie: RiskCategory.ENGAGEMENT, motif: /\b(dispo|disponible|libre)\b.*\b(demain|ce soir|week[- ]?end|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b|\b(demain|ce soir|week[- ]?end|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b.*\b(dispo|disponible|libre)\b|\btu fais quoi.*\b(demain|ce soir|week[- ]?end|samedi|dimanche|lundi|mardi|mercredi|jeudi|vendredi)\b/ },
  { nom: "engagement.horaire", categorie: RiskCategory.ENGAGEMENT, motif: /\b(a|vers|pour)\s*\d{1,2}\s*(h|heures?)\b|\bquelle heure\b/ },
  { nom: "engagement.invitation", categorie: RiskCategory.ENGAGEMENT, motif: /\b(je passe|tu passes|viens|je viens|chez toi|chez moi|je t'?emmene|je te prends)\b/ },
  { nom: "engagement.annulation", categorie: RiskCategory.ENGAGEMENT, motif: /\b(annulee?|annuler|decalee?|reporter|je peux plus)\b/ },

  { nom: "fait.identite", categorie: RiskCategory.FACT, motif: /\bt'?u? ?as quel age\b|\btu as quel age\b|\bquel age\b/ },
  { nom: "fait.travail", categorie: RiskCategory.FACT, motif: /\btu (travailles|bosses)\b|\bton (travail|boulot|job|metier)\b/ },
  { nom: "fait.lieu", categorie: RiskCategory.FACT, motif: /\btu (habites|vis|es) ou\b|\btu viens d'?ou\b/ },
  { nom: "fait.relation", categorie: RiskCategory.FACT, motif: /\btu es (celibataire|en couple|mariee?)\b|\btu as (une copine|quelqu'?un|des enfants)\b/ },

  { nom: "emotionnel.sentiments", categorie: RiskCategory.EMOTIONAL, motif: /\bje t'? ?aime\b|\btu me manques\b|\bje pense a toi\b|\bje tiens a toi\b/ },
  { nom: "emotionnel.statut", categorie: RiskCategory.EMOTIONAL, motif: /\bon est quoi\b|\bc'?est quoi nous\b|\bon sort ensemble\b|\btu ressens quoi\b|\b(?:exclusif|exclusive)\b/ },
  { nom: "emotionnel.conflit", categorie: RiskCategory.EMOTIONAL, motif: /\b(decue?|blessee?|vexee?|en colere|tu m'?ignores|tu reponds jamais|ca me fait mal)\b/ },
  { nom: "emotionnel.detresse", categorie: RiskCategory.EMOTIONAL, motif: /\b(je vais mal|deprimee?|j'?en peux plus|je suis triste|aide moi)\b/ },

  { nom: "argent.demande", categorie: RiskCategory.MONEY, motif: /\b(envoie|envoyer|preter|prete|donne)\b.*\d{3,}\s*(f|fcfa|euros?|balles)\b|\b\d{3,}\s*(f|fcfa|euros?|balles)\b/ },
  { nom: "argent.vocabulaire", categorie: RiskCategory.MONEY, motif: /\b(?:un|une|le|la|les|des|ce|ces|mon|ton|son|notre|votre|leur|mes|tes|ses|nos|vos|leurs)\s+prets?\b|\bpret\s+(?:de|bancaire)|\b(credit|dette|rembourse|rembourser|virement|mobile money|wave|orange money)\b|\bbesoin d'?argent\b/ },

  { nom: "intime.photo", categorie: RiskCategory.INTIMATE, motif: /\b(envoie|montre|tu m'?envoies)\b.*\b(photo|pic|nude|image de toi)\b|\bphoto de toi\b/ },
  { nom: "intime.explicite", categorie: RiskCategory.INTIMATE, motif: /\b(nue?s?|nudes?|sexe|coucher ensemble|au lit avec)\b/ },

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
