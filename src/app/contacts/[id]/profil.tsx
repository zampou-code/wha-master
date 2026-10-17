"use client";
import { useState } from "react";

export type Proposition = { valeur: string | number; preuve: string };
export type Profil = {
  ton: string | null;
  rythme: string | null;
  sujets: string[];
  propositions: Record<string, Proposition>;
  analyseA: string | null;
};

const LIBELLE: Record<string, string> = {
  styleLength: "Longueur des réponses",
  styleEmoji: "Emoji",
  styleFormality: "Tutoiement ou vouvoiement",
  styleInitiative: "Initiative",
  minDelaySec: "Délai minimum avant réponse",
  maxDelaySec: "Délai maximum avant réponse",
};

function lisible(cle: string, valeur: string | number): string {
  if (cle === "minDelaySec" || cle === "maxDelaySec") {
    const secondes = Number(valeur);
    return secondes < 90 ? `${secondes} s` : `${Math.round(secondes / 60)} min`;
  }
  return String(valeur);
}

/**
 * Ce que l'historique dit du contact, et ce qu'on en propose.
 *
 * Chaque proposition est affichée avec sa preuve chiffrée : c'est la différence
 * entre un réglage qu'on accepte et un réglage qu'on subit. Rien ne s'applique
 * tout seul — le bouton remplit le formulaire, et c'est l'enregistrement
 * habituel qui décide.
 */
export default function ProfilDeduit({
  contactId,
  profil,
  surAnalyse,
  surApplication,
}: {
  contactId: string;
  profil: Profil | null;
  surAnalyse: (profil: Profil) => void;
  surApplication: (propositions: Record<string, Proposition>) => void;
}) {
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [applique, setApplique] = useState(false);

  const analyser = async () => {
    setEnvoi(true);
    setErreur(null);
    try {
      const reponse = await fetch(`/api/contacts/${contactId}/profil`, { method: "POST" });
      const recu = (await reponse.json().catch(() => null)) as
        | { profil?: Profil; erreur?: string }
        | null;
      if (!reponse.ok || !recu?.profil) {
        setErreur(recu?.erreur ?? "Analyse impossible.");
        return;
      }
      setApplique(false);
      surAnalyse(recu.profil);
    } catch {
      setErreur("Connexion réseau impossible. Réessaie dans un instant.");
    } finally {
      setEnvoi(false);
    }
  };

  const entrees = Object.entries(profil?.propositions ?? {});

  return (
    <section className="section">
      <h2>Déduit de l&apos;historique</h2>
      <p className="section__aide">
        L&apos;analyse lit la conversation et propose des réglages, chacun avec ce qui le
        justifie. Rien n&apos;est appliqué sans toi.
      </p>

      {erreur && <p role="alert" className="alerte">{erreur}</p>}

      {profil && (profil.ton || profil.rythme || profil.sujets.length > 0) && (
        <div className="bloc-etat" data-etat="connecte">
          <span className="bloc-etat__indicateur" aria-hidden="true" />
          <div className="bloc-etat__texte">
            {profil.ton && <p className="bloc-etat__libelle">{profil.ton}</p>}
            {profil.rythme && <p className="bloc-etat__detail">{profil.rythme}</p>}
            {profil.sujets.length > 0 && (
              <p className="bloc-etat__detail">Sujets : {profil.sujets.join(", ")}</p>
            )}
          </div>
        </div>
      )}

      {entrees.length > 0 && (
        <>
          <div className="liste-groupes">
            {entrees.map(([cle, proposition]) => (
              <div key={cle} className="groupe">
                <span className="groupe__nom">
                  {LIBELLE[cle] ?? cle} : {lisible(cle, proposition.valeur)}
                </span>
                <span className="groupe__detail">{proposition.preuve}</span>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="bouton-secondaire"
            disabled={envoi || applique}
            onClick={() => {
              surApplication(profil!.propositions);
              setApplique(true);
            }}
          >
            {applique
              ? "Reporté dans le formulaire — il reste à enregistrer"
              : "Reporter ces réglages dans le formulaire"}
          </button>
        </>
      )}

      {profil === null && (
        <p className="section__aide">
          Aucune analyse pour l&apos;instant. Importe l&apos;historique d&apos;abord : sans
          conversation à lire, il n&apos;y a rien à déduire.
        </p>
      )}

      <button type="button" className="bouton-secondaire" disabled={envoi} onClick={() => void analyser()}>
        {envoi ? "Analyse en cours…" : profil ? "Analyser à nouveau" : "Analyser l'historique"}
      </button>
    </section>
  );
}
