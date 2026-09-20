// Aucun test ne doit joindre un service externe. Une omission dans la remise à
// zéro de la base a déjà laissé des tests d'intégration appeler la vraie API
// d'un fournisseur d'IA — le symptôme observé était une réponse « invalid
// x-api-key ». L'hygiène des données se corrige à chaque nouvelle table ; ce
// garde-fou, lui, n'a rien à tenir à jour.
export const hotesAutorises: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "[::1]",
  // Noms de service du Compose, utilisés par les simulacres de client GOWA.
  "gowa",
  "postgres",
  "app",
];

export class AppelReseauInterditError extends Error {
  constructor(hote: string, url: string) {
    super(
      `Appel réseau interdit en test vers ${hote} (${url}). ` +
        `Injecte un simulacre plutôt que de joindre un service externe.`,
    );
    this.name = "AppelReseauInterditError";
  }
}

function hoteDe(entree: RequestInfo | URL): string {
  const brut = entree instanceof Request ? entree.url : String(entree);
  try {
    return new URL(brut).hostname;
  } catch {
    // Une URL relative ne quitte pas la machine : on la laisse passer.
    return "localhost";
  }
}

export function installerGardeReseau(): void {
  const reel = globalThis.fetch;
  globalThis.fetch = ((entree: RequestInfo | URL, init?: RequestInit) => {
    const hote = hoteDe(entree);
    if (!hotesAutorises.includes(hote)) {
      const url = entree instanceof Request ? entree.url : String(entree);
      return Promise.reject(new AppelReseauInterditError(hote, url));
    }
    return reel(entree, init);
  }) as typeof fetch;
}

installerGardeReseau();
