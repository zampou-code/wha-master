"use client";
import { useState } from "react";

type Apercu = {
  auteurs: string[];
  messages: number;
  ignorees: number;
  ordreDeduit: boolean;
  du: string | null;
  au: string | null;
};

type Resultat = { inseres: number; deja: number; ignorees: number; du: string | null; au: string | null };

function jour(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(iso),
  );
}

/**
 * Import de l'historique d'une conversation.
 *
 * En deux temps, parce qu'une seule chose doit être décidée et qu'elle ne se
 * devine pas : lequel des deux auteurs du fichier est le contact. Se tromper
 * mettrait tous les messages du mauvais côté, et le rédacteur s'imiterait
 * lui-même en croyant imiter le contact.
 */
export default function ImportHistorique({
  contactId,
  surImport,
}: {
  contactId: string;
  surImport: () => void;
}) {
  const [contenu, setContenu] = useState<string | null>(null);
  const [nomFichier, setNomFichier] = useState<string | null>(null);
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [auteur, setAuteur] = useState<string | null>(null);
  const [resultat, setResultat] = useState<Resultat | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  const envoyer = async (corps: { contenu: string; auteurContact?: string }) => {
    setEnvoi(true);
    setErreur(null);
    try {
      const reponse = await fetch(`/api/contacts/${contactId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      });
      const recu = (await reponse.json().catch(() => null)) as
        | { apercu?: Apercu; resultat?: Resultat; erreur?: string }
        | null;
      if (!reponse.ok) {
        setErreur(recu?.erreur ?? "Import impossible.");
        return null;
      }
      return recu;
    } catch {
      setErreur("Connexion réseau impossible. Réessaie dans un instant.");
      return null;
    } finally {
      setEnvoi(false);
    }
  };

  const choisirFichier = async (fichier: File) => {
    setResultat(null);
    setApercu(null);
    setAuteur(null);
    const texte = await fichier.text();
    setContenu(texte);
    setNomFichier(fichier.name);
    const recu = await envoyer({ contenu: texte });
    if (!recu?.apercu) return;
    setApercu(recu.apercu);
    // Deux auteurs seulement dans une conversation individuelle : le contact
    // est celui qui n'est pas l'utilisateur, mais c'est à lui de le dire — rien
    // dans le fichier ne distingue l'un de l'autre.
    setAuteur(recu.apercu.auteurs[0] ?? null);
  };

  return (
    <section className="section">
      <h2>Importer l&apos;historique</h2>
      <p className="section__aide">
        Depuis WhatsApp : ouvre la discussion, <strong>Exporter la discussion</strong>, puis{" "}
        <strong>sans les médias</strong>. L&apos;assistant ne connaît pour l&apos;instant que les
        messages reçus depuis son branchement — l&apos;import lui donne tout le reste.
      </p>

      <label className="champ">
        <span>Fichier exporté (.txt)</span>
        <input
          type="file"
          accept=".txt,text/plain"
          disabled={envoi}
          onChange={(e) => {
            const fichier = e.target.files?.[0];
            if (fichier) void choisirFichier(fichier);
          }}
        />
      </label>

      {erreur && <p role="alert" className="alerte">{erreur}</p>}

      {apercu && !resultat && (
        <>
          <p className="section__aide">
            {nomFichier} : {apercu.messages} message{apercu.messages > 1 ? "s" : ""} du{" "}
            {jour(apercu.du)} au {jour(apercu.au)}
            {apercu.ignorees > 0 && `, ${apercu.ignorees} ligne${apercu.ignorees > 1 ? "s" : ""} ignorée${apercu.ignorees > 1 ? "s" : ""}`}
            .
          </p>

          {!apercu.ordreDeduit && (
            <p className="section__aide">
              Les dates de ce fichier tiennent toutes dans les douze premiers jours du mois : elles
              sont lues comme jour/mois. Si la conversation paraît décalée après l&apos;import,
              c&apos;est de là que ça vient.
            </p>
          )}

          {apercu.auteurs.length === 0 ? (
            <p className="section__aide">Aucun auteur reconnu dans ce fichier.</p>
          ) : (
            <>
              <p className="section__aide">
                Lequel de ces noms est le contact ? L&apos;autre, c&apos;est toi — se tromper ici
                inverserait toute la conversation.
              </p>
              <div className="liste-groupes" role="radiogroup" aria-label="Auteur du contact">
                {apercu.auteurs.map((nom) => (
                  <button
                    key={nom}
                    type="button"
                    role="radio"
                    aria-checked={auteur === nom}
                    className="groupe"
                    data-choisi={auteur === nom ? "" : undefined}
                    onClick={() => setAuteur(nom)}
                  >
                    <span className="groupe__nom">{nom}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <button
            type="button"
            className="bouton-secondaire"
            disabled={envoi || auteur === null || contenu === null}
            onClick={async () => {
              if (!contenu || !auteur) return;
              const recu = await envoyer({ contenu, auteurContact: auteur });
              if (!recu?.resultat) return;
              setResultat(recu.resultat);
              setApercu(null);
              surImport();
            }}
          >
            {envoi ? "Import en cours…" : `Importer comme conversation avec ${auteur ?? "…"}`}
          </button>
        </>
      )}

      {resultat && (
        <p role="status" className="section__aide">
          {resultat.inseres} message{resultat.inseres > 1 ? "s" : ""} importé
          {resultat.inseres > 1 ? "s" : ""}
          {resultat.deja > 0 && `, ${resultat.deja} déjà présent${resultat.deja > 1 ? "s" : ""}`}. Le
          rédacteur s&apos;en servira pour le contexte ; aucun de ces messages n&apos;est classé ni
          traité.
        </p>
      )}
    </section>
  );
}
