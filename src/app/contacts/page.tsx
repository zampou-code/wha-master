"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Contact = {
  id: string;
  nom: string;
  jid: string;
  mode: "OFF" | "DRAFT" | "AUTO";
  isAdult: boolean;
  messages: number;
  escaladesOuvertes: number;
  dernierMessageA: string | null;
};

const LIBELLE_MODE: Record<Contact["mode"], string> = {
  OFF: "désactivé",
  DRAFT: "brouillon",
  AUTO: "automatique",
};

function quand(iso: string | null): string {
  if (!iso) return "aucun message";
  const jours = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (jours <= 0) return "aujourd'hui";
  if (jours === 1) return "hier";
  return `il y a ${jours} jours`;
}

type ResteNonPersonnes = { contacts: number; messages: number; decisions: number };

export default function Contacts() {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [nonPersonnes, setNonPersonnes] = useState<ResteNonPersonnes | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  // Un effacement irréversible ne part pas au premier appui : le bouton
  // demande d'abord de confirmer, et redevient inoffensif si on l'ignore.
  const [confirme, setConfirme] = useState(false);
  const [efface, setEfface] = useState<ResteNonPersonnes | null>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur(null);
    let reponse: Response;
    try {
      reponse = await fetch("/api/contacts");
    } catch {
      setErreur("Connexion réseau impossible. Réessaie dans un instant.");
      setChargement(false);
      return;
    }
    if (reponse.status === 401) {
      router.push("/login");
      return;
    }
    if (!reponse.ok) {
      setErreur("Impossible de lire les contacts.");
      setChargement(false);
      return;
    }
    const recu = (await reponse.json()) as {
      contacts: Contact[];
      nonPersonnes?: ResteNonPersonnes;
    };
    setContacts(recu.contacts);
    setNonPersonnes(recu.nonPersonnes ?? null);
    setChargement(false);
  }, [router]);

  const effacerNonPersonnes = useCallback(async () => {
    setErreur(null);
    setChargement(true);
    let reponse: Response;
    try {
      reponse = await fetch("/api/contacts", { method: "DELETE" });
    } catch {
      setErreur("Connexion réseau impossible. Réessaie dans un instant.");
      setChargement(false);
      return;
    }
    if (reponse.status === 401) {
      router.push("/login");
      return;
    }
    const recu = (await reponse.json().catch(() => null)) as {
      efface?: ResteNonPersonnes;
      contacts?: Contact[];
      nonPersonnes?: ResteNonPersonnes;
      erreur?: string;
    } | null;
    if (!reponse.ok || !recu?.contacts) {
      setErreur(recu?.erreur ?? "Effacement impossible.");
      setChargement(false);
      return;
    }
    setContacts(recu.contacts);
    setNonPersonnes(recu.nonPersonnes ?? null);
    setEfface(recu.efface ?? null);
    setConfirme(false);
    setChargement(false);
  }, [router]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const actifs = contacts?.filter((c) => c.mode !== "OFF") ?? [];

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>Contacts</h1>
          <p>
            C&apos;est le seul endroit où un contact peut être activé. Tant qu&apos;il est
            désactivé, l&apos;assistant lit ses messages sans jamais rien proposer ni envoyer.
          </p>
        </header>

        {!chargement && contacts && (
          <div className="bloc-etat" data-etat={actifs.length > 0 ? "connecte" : "attente"}>
            <span className="bloc-etat__indicateur" aria-hidden="true" />
            <div className="bloc-etat__texte">
              <p className="bloc-etat__libelle">
                {actifs.length === 0
                  ? "Aucun contact actif"
                  : `${actifs.length} contact${actifs.length > 1 ? "s" : ""} actif${actifs.length > 1 ? "s" : ""}`}
              </p>
              <p className="bloc-etat__detail">
                {contacts.length} contact{contacts.length > 1 ? "s" : ""} connu
                {contacts.length > 1 ? "s" : ""} au total.
              </p>
            </div>
          </div>
        )}

        {erreur && <p role="alert" className="alerte">{erreur}</p>}

        {efface && (
          <p role="status" className="section__aide">
            {efface.contacts} entrée{efface.contacts > 1 ? "s" : ""} effacée
            {efface.contacts > 1 ? "s" : ""}, avec {efface.messages} message
            {efface.messages > 1 ? "s" : ""} et {efface.decisions} décision
            {efface.decisions > 1 ? "s" : ""}.
          </p>
        )}

        {nonPersonnes && nonPersonnes.contacts > 0 && (
          <div className="bloc-etat" data-etat="attente">
            <span className="bloc-etat__indicateur" aria-hidden="true" />
            <div className="bloc-etat__texte">
              <p className="bloc-etat__libelle">
                {nonPersonnes.contacts} groupe{nonPersonnes.contacts > 1 ? "s" : ""} ou fil
                {nonPersonnes.contacts > 1 ? "s" : ""} hors conversation en base
              </p>
              <p className="bloc-etat__detail">
                Hérités de l&apos;ingestion d&apos;avant : ils ne s&apos;affichent plus, mais
                occupent encore la base avec {nonPersonnes.messages} message
                {nonPersonnes.messages > 1 ? "s" : ""} et {nonPersonnes.decisions} décision
                {nonPersonnes.decisions > 1 ? "s" : ""}. L&apos;effacement est définitif et sans
                sauvegarde.
              </p>
              <button
                type="button"
                className="bouton-secondaire"
                disabled={chargement}
                onClick={() => {
                  if (!confirme) {
                    setConfirme(true);
                    return;
                  }
                  void effacerNonPersonnes();
                }}
              >
                {confirme ? "Confirmer l'effacement définitif" : "Effacer ces entrées"}
              </button>
            </div>
          </div>
        )}

        {contacts && contacts.length > 0 && (
          <div className="liste-groupes">
            {contacts.map((contact) => (
              <Link key={contact.id} href={`/contacts/${contact.id}`} className="groupe">
                <span className="groupe__nom">{contact.nom}</span>
                <span className="groupe__detail">
                  {LIBELLE_MODE[contact.mode]}
                  {contact.escaladesOuvertes > 0 && ` · ${contact.escaladesOuvertes} en attente`}
                  {` · ${quand(contact.dernierMessageA)}`}
                </span>
              </Link>
            ))}
          </div>
        )}

        {contacts && contacts.length === 0 && (
          <p className="vide">
            Aucun contact pour l&apos;instant. Ils apparaissent tout seuls dès que quelqu&apos;un
            t&apos;écrit sur le numéro relié.
          </p>
        )}

        <button type="button" className="bouton-secondaire" onClick={() => void charger()} disabled={chargement}>
          Rafraîchir
        </button>

        <Link href="/" className="lien-discret">
          Retour
        </Link>
      </div>
    </main>
  );
}
