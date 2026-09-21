"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Fait = { id: string; key: string; value: string; shareable: boolean };
type Persona = {
  styleGuide: Record<string, unknown>;
  hardLimits: string[];
  termesInterdits: string[];
  faits: Fait[];
};

const MESSAGE_RESEAU = "Connexion réseau impossible. Réessaie dans un instant.";

function enLignes(liste: string[]): string {
  return liste.join("\n");
}
function enListe(texte: string): string[] {
  return texte.split("\n");
}

export default function FichePersona() {
  const router = useRouter();
  const [persona, setPersona] = useState<Persona | null>(null);
  const [traits, setTraits] = useState("");
  const [limites, setLimites] = useState("");
  const [interdits, setInterdits] = useState("");
  const [nouvelleCle, setNouvelleCle] = useState("");
  const [nouvelleValeur, setNouvelleValeur] = useState("");
  const [nouveauPartageable, setNouveauPartageable] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [succes, setSucces] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [envoi, setEnvoi] = useState(false);

  const appliquer = useCallback((recu: Persona) => {
    setPersona(recu);
    const traitsBruts = recu.styleGuide.traits;
    setTraits(Array.isArray(traitsBruts) ? enLignes(traitsBruts.map(String)) : "");
    setLimites(enLignes(recu.hardLimits));
    setInterdits(enLignes(recu.termesInterdits));
  }, []);

  const charger = useCallback(async () => {
    setChargement(true);
    let reponse: Response;
    try {
      reponse = await fetch("/api/persona");
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
      setErreur("Impossible de lire ta fiche.");
      setChargement(false);
      return;
    }
    appliquer(((await reponse.json()) as { persona: Persona }).persona);
    setChargement(false);
  }, [router, appliquer]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const envoyer = useCallback(
    async (chemin: string, methode: string, corps: unknown, messageSucces: string) => {
      setEnvoi(true);
      setErreur(null);
      setSucces(null);
      let reponse: Response;
      try {
        reponse = await fetch(chemin, {
          method: methode,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(corps),
        });
      } catch {
        setErreur(MESSAGE_RESEAU);
        setEnvoi(false);
        return false;
      }
      if (reponse.status === 401) {
        router.push("/login");
        return false;
      }
      const recu = (await reponse.json().catch(() => null)) as
        | { persona?: Persona; erreur?: string }
        | null;
      if (!reponse.ok || !recu?.persona) {
        setErreur(recu?.erreur ?? "Enregistrement refusé.");
        setEnvoi(false);
        return false;
      }
      appliquer(recu.persona);
      setSucces(messageSucces);
      setEnvoi(false);
      return true;
    },
    [router, appliquer],
  );

  if (chargement || !persona) {
    return (
      <main className="ecran">
        <div className="colonne">
          {erreur ? <p role="alert" className="alerte">{erreur}</p> : <p className="vide">Un instant.</p>}
          <Link href="/" className="lien-discret">Retour</Link>
        </div>
      </main>
    );
  }

  const partageables = persona.faits.filter((fait) => fait.shareable).length;

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>Ta fiche</h1>
          <p>
            Ce que l&apos;assistant sait de toi et ce qu&apos;il a le droit d&apos;en dire. Un fait
            que tu ne marques pas partageable ne sortira jamais, et un brouillon qui en invente un
            est refusé.
          </p>
        </header>

        {erreur && <p role="alert" className="alerte">{erreur}</p>}
        {succes && <p role="status" className="confirmation">{succes}</p>}

        <div className="bloc-etat" data-etat={partageables > 0 ? "connecte" : "attente"}>
          <span className="bloc-etat__indicateur" aria-hidden="true" />
          <div className="bloc-etat__texte">
            <p className="bloc-etat__libelle">
              {partageables === 0 ? "Aucun fait partageable" : `${partageables} fait${partageables > 1 ? "s" : ""} partageable${partageables > 1 ? "s" : ""}`}
            </p>
            <p className="bloc-etat__detail">
              {partageables === 0
                ? "Le rédacteur n'a rien à dire de toi : il posera la question au lieu de répondre."
                : "Ce sont les seules informations que le rédacteur peut citer."}
            </p>
          </div>
        </div>

        <section className="section">
          <h2>Faits</h2>
          {persona.faits.length > 0 && (
            <div className="liste-groupes">
              {persona.faits.map((fait) => (
                <div key={fait.id} className="fait">
                  <button
                    type="button"
                    className="fait__bascule"
                    aria-pressed={fait.shareable}
                    disabled={envoi}
                    onClick={() =>
                      void envoyer(
                        "/api/persona/faits",
                        "PUT",
                        { ...fait, shareable: !fait.shareable },
                        fait.shareable
                          ? `« ${fait.key} » ne sera plus cité.`
                          : `« ${fait.key} » peut désormais être cité.`,
                      )
                    }
                  >
                    <span className="groupe__nom">
                      {fait.key} : {fait.value}
                    </span>
                    <span className="groupe__detail">
                      {fait.shareable ? "partageable" : "gardé pour toi"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="fait__retirer"
                    aria-label={`Supprimer le fait ${fait.key}`}
                    disabled={envoi}
                    onClick={() =>
                      void envoyer("/api/persona/faits", "DELETE", { id: fait.id }, `« ${fait.key} » supprimé.`)
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="paire">
            <label className="champ">
              <span>Clé</span>
              <input
                type="text"
                value={nouvelleCle}
                onChange={(e) => setNouvelleCle(e.target.value)}
                placeholder="prenom"
              />
            </label>
            <label className="champ">
              <span>Valeur</span>
              <input
                type="text"
                value={nouvelleValeur}
                onChange={(e) => setNouvelleValeur(e.target.value)}
                placeholder="Ibrahim"
              />
            </label>
          </div>
          <label className="bascule">
            <input
              type="checkbox"
              checked={nouveauPartageable}
              onChange={(e) => setNouveauPartageable(e.target.checked)}
            />
            <span>Le rédacteur peut citer ce fait</span>
          </label>
          <button
            type="button"
            className="bouton-secondaire"
            disabled={envoi || nouvelleCle.trim() === "" || nouvelleValeur.trim() === ""}
            onClick={async () => {
              const ajoute = await envoyer(
                "/api/persona/faits",
                "PUT",
                { key: nouvelleCle, value: nouvelleValeur, shareable: nouveauPartageable },
                "Fait ajouté.",
              );
              if (ajoute) {
                setNouvelleCle("");
                setNouvelleValeur("");
              }
            }}
          >
            Ajouter ce fait
          </button>
        </section>

        <section className="section">
          <h2>Ton style</h2>
          <p className="section__aide">Une consigne par ligne. Elles sont données au rédacteur telles quelles.</p>
          <label className="champ">
            <span>Traits</span>
            <textarea
              value={traits}
              onChange={(e) => setTraits(e.target.value)}
              placeholder={"taquin\ndirect\npas de superlatifs"}
            />
          </label>
        </section>

        <section className="section">
          <h2>Limites</h2>
          <p className="section__aide">
            Des consignes en français, une par ligne — elles guident le rédacteur sans le contraindre.
          </p>
          <label className="champ">
            <span>À ne jamais faire</span>
            <textarea
              value={limites}
              onChange={(e) => setLimites(e.target.value)}
              placeholder={"Ne jamais promettre une date\nNe jamais parler d'argent"}
            />
          </label>
        </section>

        <section className="section">
          <h2>Mots interdits</h2>
          <p className="section__aide">
            Ceux-là sont vérifiés dans le texte, mot par mot, accords compris : un brouillon qui en
            contient un n&apos;est jamais envoyé. Un mot par ligne.
          </p>
          <label className="champ">
            <span>Mots bannis</span>
            <textarea
              value={interdits}
              onChange={(e) => setInterdits(e.target.value)}
              placeholder={"rembourse\nvirement\nmon adresse"}
            />
          </label>
        </section>

        <button
          type="button"
          className="bouton-principal"
          disabled={envoi}
          onClick={() =>
            void envoyer(
              "/api/persona",
              "PUT",
              {
                styleGuide: { ...persona.styleGuide, traits: enListe(traits).map((t) => t.trim()).filter(Boolean) },
                hardLimits: enListe(limites),
                termesInterdits: enListe(interdits),
              },
              "Fiche enregistrée.",
            )
          }
        >
          {envoi ? "Enregistrement…" : "Enregistrer style et limites"}
        </button>

        <Link href="/" className="lien-discret">
          Retour
        </Link>
      </div>
    </main>
  );
}
