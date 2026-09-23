"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Statut = { isConnected: boolean; isLoggedIn: boolean; jid?: string };
type Etat = {
  groupeDeControle: { pret: boolean; nom: string | null };
  persona: { pret: boolean; faitsPartageables: number };
  redaction: { pret: boolean; fournisseurs: number };
  classement: { pret: boolean; fournisseurs: number };
  contacts: { pret: boolean; actifs: number; total: number };
  escaladesOuvertes: number;
  pauseGlobale: boolean;
  envois: { enAttente: number; prochainA: string | null; echecs: number };
};

const MESSAGE_RESEAU = "Connexion réseau impossible. Réessaie dans un instant.";

export default function Accueil() {
  const router = useRouter();
  const [statut, setStatut] = useState<Statut | null>(null);
  const [etat, setEtat] = useState<Etat | null>(null);
  const [etatIllisible, setEtatIllisible] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);

  const verifier = useCallback(async () => {
    setChargement(true);
    let liaison: Response;
    try {
      liaison = await fetch("/api/whatsapp/status");
    } catch {
      setErreur(MESSAGE_RESEAU);
      setChargement(false);
      return;
    }
    if (liaison.status === 401) {
      router.push("/login");
      return;
    }
    if (!liaison.ok) {
      setErreur("WhatsApp ne répond pas. Vérifie le service et réessaie.");
      setChargement(false);
      return;
    }
    setErreur(null);
    setStatut(await liaison.json());

    // Un échec de lecture ne doit pas ressembler à « rien n'est configuré » :
    // les deux mènent à des décisions opposées.
    try {
      const reponse = await fetch("/api/etat");
      if (reponse.ok) {
        setEtat(((await reponse.json()) as { etat: Etat }).etat);
        setEtatIllisible(false);
      } else {
        setEtat(null);
        setEtatIllisible(true);
      }
    } catch {
      setEtat(null);
      setEtatIllisible(true);
    }
    setChargement(false);
  }, [router]);

  useEffect(() => {
    void verifier();
  }, [verifier]);

  const relie = statut?.isLoggedIn === true;

  const etapes = etat
    ? [
        {
          cle: "groupe",
          titre: etat.groupeDeControle.nom ?? "Groupe de contrôle",
          pret: etat.groupeDeControle.pret,
          detail: etat.groupeDeControle.pret
            ? "Les messages à valider y sont soumis."
            : "Sans lui, rien ne t'est proposé et rien n'est envoyé.",
          lien: "/reglages",
        },
        {
          cle: "persona",
          titre: "Ta fiche",
          pret: etat.persona.pret,
          detail: etat.persona.pret
            ? `${etat.persona.faitsPartageables} fait${etat.persona.faitsPartageables > 1 ? "s" : ""} que le rédacteur peut citer.`
            : "Le rédacteur n'a rien à dire de toi : il posera la question au lieu de répondre.",
          lien: "/persona",
        },
        {
          cle: "ia",
          titre: "Fournisseurs d'IA",
          pret: etat.redaction.pret,
          detail: etat.redaction.pret
            ? etat.classement.pret
              ? "Rédaction et classement couverts."
              : "Rédaction couverte, mais aucun classement : tout sera traité comme incertain."
            : "Tu recevras des alertes sans proposition.",
          lien: "/fournisseurs",
        },
        {
          cle: "contacts",
          titre: "Contacts",
          pret: etat.contacts.pret,
          detail: etat.contacts.pret
            ? `${etat.contacts.actifs} actif${etat.contacts.actifs > 1 ? "s" : ""} sur ${etat.contacts.total}.`
            : `${etat.contacts.total} connu${etat.contacts.total > 1 ? "s" : ""}, aucun activé. C'est le seul endroit qui peut le faire.`,
          lien: "/contacts",
        },
      ]
    : [];

  const restantes = etapes.filter((etape) => !etape.pret).length;

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>Poste de contrôle</h1>
          <p>
            {relie && etat
              ? restantes === 0
                ? "Tout est en place. L'assistant te soumet chaque message avant de l'envoyer."
                : `${restantes} chose${restantes > 1 ? "s" : ""} à régler avant que l'assistant ne propose quoi que ce soit.`
              : "Cet assistant répond à ta place sur WhatsApp, après ton accord message par message."}
          </p>
        </header>

        <div
          className="bloc-etat"
          data-etat={erreur ? "erreur" : chargement ? "verification" : relie ? "connecte" : "attente"}
          aria-live="polite"
        >
          <span className="bloc-etat__indicateur" aria-hidden="true" />
          <div className="bloc-etat__texte">
            <p className="bloc-etat__libelle">
              {erreur
                ? "Liaison indisponible"
                : chargement
                  ? "Vérification"
                  : relie
                    ? "Appareil relié"
                    : "Aucun appareil relié"}
            </p>
            <p className="bloc-etat__detail">
              {erreur
                ? "Vérifie que le service WhatsApp tourne, puis réessaie."
                : chargement
                  ? "Un instant."
                  : relie
                    ? statut?.jid ?? "Connecté."
                    : "Lance l'appairage pour connecter un téléphone."}
            </p>
          </div>
        </div>

        {erreur && <p role="alert" className="alerte">{erreur}</p>}

        {!relie && !chargement && !erreur && (
          <Link href="/connexion" className="bouton-principal">Lancer l&apos;appairage</Link>
        )}

        {relie && etat && etat.envois.enAttente > 0 && (
          <p role="status" className="confirmation">
            {etat.envois.enAttente} réponse{etat.envois.enAttente > 1 ? "s" : ""} automatique
            {etat.envois.enAttente > 1 ? "s" : ""} en attente
            {etat.envois.prochainA && ` — la prochaine vers ${new Date(etat.envois.prochainA)
              .toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`}
            . Le délai est volontaire : une réponse instantanée se remarquerait.
          </p>
        )}

        {relie && etat && etat.envois.echecs > 0 && (
          <p role="alert" className="alerte">
            {etat.envois.echecs} réponse{etat.envois.echecs > 1 ? "s" : ""} automatique
            {etat.envois.echecs > 1 ? "s n'ont" : " n'a"} pas pu partir après plusieurs tentatives.
            Regarde le journal.
          </p>
        )}

        {relie && etat?.pauseGlobale && (
          <p role="status" className="alerte">
            Pause globale active : rien ne sera envoyé tant que tu n&apos;auras pas fait /go dans le
            groupe de contrôle.
          </p>
        )}

        {relie && etatIllisible && (
          <p role="alert" className="alerte">
            L&apos;état des réglages n&apos;a pas pu être lu. Ce qui suit peut être incomplet.
          </p>
        )}

        {relie && etat && (
          <div className="liste-groupes">
            {etapes.map((etape) => (
              <Link key={etape.cle} href={etape.lien} className="groupe" data-choisi={etape.pret ? "" : undefined}>
                <span className="groupe__nom">{etape.titre}</span>
                <span className="groupe__detail">{etape.detail}</span>
              </Link>
            ))}
            <Link href="/journal" className="groupe">
              <span className="groupe__nom">Journal</span>
              <span className="groupe__detail">
                {etat.escaladesOuvertes > 0
                  ? `${etat.escaladesOuvertes} message${etat.escaladesOuvertes > 1 ? "s" : ""} en attente de ta réponse.`
                  : "Ce que l'assistant a décidé, et pourquoi."}
              </span>
            </Link>
          </div>
        )}

        {relie && (
          <Link href="/connexion" className="lien-discret">Revoir l&apos;appairage</Link>
        )}
      </div>
    </main>
  );
}
