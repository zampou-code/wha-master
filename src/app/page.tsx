"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Statut = { isConnected: boolean; isLoggedIn: boolean; jid?: string };
type EtatRail = "verification" | "attente" | "connecte" | "erreur";

const MESSAGE_RESEAU = "Connexion réseau impossible. Réessaie dans un instant.";
const MESSAGE_INJOIGNABLE = "WhatsApp ne répond pas. Vérifie le service et réessaie.";

export default function Accueil() {
  const router = useRouter();
  const [statut, setStatut] = useState<Statut | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);

  const verifierLiaison = useCallback(async () => {
    setChargement(true);
    let reponse: Response;
    try {
      reponse = await fetch("/api/whatsapp/status");
    } catch {
      setErreur(MESSAGE_RESEAU);
      setChargement(false);
      return;
    }
    if (reponse.status === 401) {
      router.push("/login");
      return;
    }
    if (!reponse.ok) {
      setErreur(MESSAGE_INJOIGNABLE);
      setChargement(false);
      return;
    }
    setErreur(null);
    setStatut(await reponse.json());
    setChargement(false);
  }, [router]);

  useEffect(() => {
    void verifierLiaison();
  }, [verifierLiaison]);

  const etat: EtatRail = erreur
    ? "erreur"
    : chargement
      ? "verification"
      : statut?.isLoggedIn
        ? "connecte"
        : "attente";

  const libelle =
    etat === "erreur"
      ? "Liaison indisponible"
      : etat === "verification"
        ? "Vérification de la liaison"
        : etat === "connecte"
          ? "Appareil relié"
          : "Aucun appareil relié";

  const detail =
    etat === "erreur"
      ? "Vérifie que le service WhatsApp tourne, puis réessaie."
      : etat === "verification"
        ? "Un instant."
        : etat === "connecte"
          ? `Cet assistant répond déjà sur WhatsApp${statut?.jid ? ` (${statut.jid})` : ""}.`
          : "Aucun téléphone n'est relié. Lance l'appairage pour en connecter un.";

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>Poste de contrôle WhatsApp</h1>
          <p>Cet assistant répond à ta place sur WhatsApp. Voici l&apos;état de la liaison.</p>
        </header>

        <div className="bloc-etat" data-etat={etat} aria-live="polite">
          <span className="bloc-etat__indicateur" aria-hidden="true" />
          <div className="bloc-etat__texte">
            <p className="bloc-etat__libelle">{libelle}</p>
            <p className="bloc-etat__detail">{detail}</p>
          </div>
        </div>

        {erreur && <p role="alert" className="alerte">{erreur}</p>}

        {erreur && (
          <button type="button" className="bouton-secondaire" onClick={() => void verifierLiaison()}>
            Réessayer
          </button>
        )}

        {!erreur && !chargement && (
          statut?.isLoggedIn ? (
            <Link href="/connexion" className="lien-discret">
              Revoir l&apos;appairage
            </Link>
          ) : (
            <Link href="/connexion" className="bouton-principal">
              Lancer l&apos;appairage
            </Link>
          )
        )}
      </div>
    </main>
  );
}
