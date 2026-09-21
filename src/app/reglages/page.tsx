"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Groupe = {
  jid: string;
  nom: string;
  participants: number | null;
  estCommunaute: boolean;
  annoncesSeulement: boolean;
};
type GroupeDeControle = { jid: string; nom: string | null; source: "interface" | "environnement" };

const MESSAGE_RESEAU = "Connexion réseau impossible. Réessaie dans un instant.";
const MESSAGE_INJOIGNABLE = "WhatsApp ne répond pas. Vérifie que l'appareil est relié, puis réessaie.";

export default function Reglages() {
  const router = useRouter();
  const [actuel, setActuel] = useState<GroupeDeControle | null>(null);
  const [groupes, setGroupes] = useState<Groupe[] | null>(null);
  const [choisi, setChoisi] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [succes, setSucces] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [enregistrement, setEnregistrement] = useState(false);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur(null);
    let reglage: Response;
    let liste: Response;
    try {
      [reglage, liste] = await Promise.all([
        fetch("/api/controle/groupe"),
        fetch("/api/controle/groupes"),
      ]);
    } catch {
      setErreur(MESSAGE_RESEAU);
      setChargement(false);
      return;
    }
    if (reglage.status === 401 || liste.status === 401) {
      router.push("/login");
      return;
    }
    if (reglage.ok) setActuel(((await reglage.json()) as { groupe: GroupeDeControle | null }).groupe);
    if (liste.ok) {
      setGroupes(((await liste.json()) as { groupes: Groupe[] }).groupes);
    } else {
      setGroupes(null);
      setErreur(MESSAGE_INJOIGNABLE);
    }
    setChargement(false);
  }, [router]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const relier = useCallback(async () => {
    if (!choisi) return;
    setEnregistrement(true);
    setErreur(null);
    setSucces(null);
    let reponse: Response;
    try {
      reponse = await fetch("/api/controle/groupe", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jid: choisi }),
      });
    } catch {
      setErreur(MESSAGE_RESEAU);
      setEnregistrement(false);
      return;
    }
    if (reponse.status === 401) {
      router.push("/login");
      return;
    }
    const corps = (await reponse.json().catch(() => null)) as
      | { groupe?: GroupeDeControle; confirmationEnvoyee?: boolean; erreur?: string }
      | null;
    if (!reponse.ok) {
      setErreur(corps?.erreur ?? MESSAGE_INJOIGNABLE);
      setEnregistrement(false);
      return;
    }
    setActuel(corps?.groupe ?? null);
    setChoisi(null);
    setSucces(
      corps?.confirmationEnvoyee
        ? "Groupe relié. Un message de confirmation vient d'y être posté."
        : "Groupe relié, mais le message de confirmation n'est pas parti. Vérifie le groupe.",
    );
    setEnregistrement(false);
  }, [choisi, router]);

  const etat = erreur ? "erreur" : chargement ? "verification" : actuel ? "connecte" : "attente";
  const libelle = actuel
    ? (actuel.nom ?? "Groupe de contrôle relié")
    : chargement
      ? "Vérification du réglage"
      : "Aucun groupe de contrôle";
  const detail = actuel
    ? actuel.source === "interface"
      ? "Les messages à valider arrivent dans ce groupe."
      : "Réglé par variable d'environnement. Choisis un groupe ci-dessous pour reprendre la main."
    : chargement
      ? "Un instant."
      : "Tant qu'aucun groupe n'est choisi, rien ne t'est proposé et rien n'est envoyé.";

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>Groupe de contrôle</h1>
          <p>
            C&apos;est le groupe WhatsApp où l&apos;assistant te soumet chaque message avant de
            l&apos;envoyer. Crée-le depuis ton téléphone, puis choisis-le ici.
          </p>
        </header>

        <div className="bloc-etat" data-etat={etat} aria-live="polite">
          <span className="bloc-etat__indicateur" aria-hidden="true" />
          <div className="bloc-etat__texte">
            <p className="bloc-etat__libelle">{libelle}</p>
            <p className="bloc-etat__detail">{detail}</p>
          </div>
        </div>

        {erreur && <p role="alert" className="alerte">{erreur}</p>}
        {succes && <p role="status" className="confirmation">{succes}</p>}

        {groupes && groupes.length > 0 && (
          <div className="liste-groupes" role="radiogroup" aria-label="Groupes disponibles">
            {groupes.map((groupe) => {
              const estActuel = groupe.jid === actuel?.jid;
              return (
                <button
                  key={groupe.jid}
                  type="button"
                  role="radio"
                  aria-checked={groupe.jid === choisi}
                  className="groupe"
                  data-choisi={groupe.jid === choisi ? "" : undefined}
                  data-actuel={estActuel ? "" : undefined}
                  onClick={() => setChoisi(groupe.jid === choisi ? null : groupe.jid)}
                >
                  <span className="groupe__nom">{groupe.nom}</span>
                  <span className="groupe__detail">
                    {estActuel && "Groupe actuel · "}
                    {groupe.participants !== null && `${groupe.participants} participants`}
                    {groupe.annoncesSeulement && " · annonces seulement"}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {groupes && groupes.length === 0 && (
          <p className="vide">
            Aucun groupe trouvé sur ce compte. Crée un groupe WhatsApp depuis ton téléphone — tu peux
            y être seul — puis reviens rafraîchir cette page.
          </p>
        )}

        {choisi && (
          <button type="button" className="bouton-principal" onClick={() => void relier()} disabled={enregistrement}>
            {enregistrement ? "Liaison en cours…" : "Relier ce groupe"}
          </button>
        )}

        <button type="button" className="bouton-secondaire" onClick={() => void charger()} disabled={chargement}>
          Rafraîchir la liste
        </button>

        <Link href="/" className="lien-discret">
          Retour
        </Link>
      </div>
    </main>
  );
}
