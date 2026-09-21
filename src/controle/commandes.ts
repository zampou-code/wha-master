export type Commande =
  | { type: "envoyer" }
  | { type: "texte"; contenu: string }
  | { type: "ignorer" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "go" }
  | { type: "mode"; alias: string; mode: "auto" | "draft" | "off" }
  | { type: "statut" }
  | { type: "qui"; alias: string }
  | { type: "inconnue"; brut: string };

const MODES = new Set(["auto", "draft", "off"]);

export function analyserCommande(brut: string): Commande {
  const texte = brut.trim();
  if (texte === "") return { type: "inconnue", brut };

  if (texte.startsWith("/")) {
    const [mot, ...reste] = texte.slice(1).split(/\s+/);
    const commande = mot.toLowerCase();

    if (commande === "stop") return { type: "stop" };
    if (commande === "go") return { type: "go" };
    if (commande === "statut" || commande === "status") return { type: "statut" };
    if ((commande === "qui" || commande === "who") && reste[0]) return { type: "qui", alias: reste[0] };
    if (commande === "mode" && reste.length >= 2) {
      const mode = reste[1].toLowerCase();
      if (MODES.has(mode)) {
        return { type: "mode", alias: reste[0], mode: mode as "auto" | "draft" | "off" };
      }
    }
    return { type: "inconnue", brut };
  }

  const minuscule = texte.toLowerCase();
  if (minuscule === "1" || minuscule === "ok") return { type: "envoyer" };
  if (minuscule === "3") return { type: "ignorer" };
  if (minuscule === "4") return { type: "pause" };

  // « 2 <texte> » exige l'espace : sans lui, « 2000 c'est trop cher » serait
  // amputé de son premier caractère et envoyé tel quel.
  const remplacement = texte.match(/^2\s+(.+)$/s);
  if (remplacement) return { type: "texte", contenu: remplacement[1].trim() };

  return { type: "texte", contenu: texte };
}
