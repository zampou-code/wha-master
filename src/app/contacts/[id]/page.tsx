"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

type Mode = "OFF" | "DRAFT" | "AUTO";
type Politique = {
  guardEngagement: boolean;
  guardFacts: boolean;
  guardEmotional: boolean;
  guardMoney: boolean;
  guardIntimate: boolean;
  guardThirdParty: boolean;
  intimateOverride: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  timezone: string;
  maxAutoStreak: number;
  minDelaySec: number;
  maxDelaySec: number;
  styleLength: string;
  styleEmoji: string;
  styleFormality: string;
  styleLanguage: string;
  styleInitiative: string;
};
type Contact = {
  id: string;
  nom: string;
  jid: string;
  alias: string | null;
  pushName: string | null;
  mode: Mode;
  isAdult: boolean;
  messages: number;
  escaladesOuvertes: number;
  politique: Politique;
};

const MODES: { valeur: Mode; titre: string; detail: string }[] = [
  { valeur: "OFF", titre: "Désactivé", detail: "Rien n'est proposé, rien n'est envoyé." },
  { valeur: "DRAFT", titre: "Brouillon", detail: "Chaque réponse t'est soumise avant d'être envoyée." },
  { valeur: "AUTO", titre: "Automatique", detail: "Les messages anodins passent sans te déranger." },
];

const GARDE_FOUS: { cle: keyof Politique; libelle: string }[] = [
  { cle: "guardEngagement", libelle: "Rendez-vous et promesses" },
  { cle: "guardFacts", libelle: "Questions sur toi" },
  { cle: "guardEmotional", libelle: "Moments émotionnels" },
  { cle: "guardMoney", libelle: "Argent" },
  { cle: "guardIntimate", libelle: "Contenu intime" },
  { cle: "guardThirdParty", libelle: "Tierces personnes" },
];

export default function FicheContact() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [contact, setContact] = useState<Contact | null>(null);
  const [mode, setMode] = useState<Mode>("OFF");
  const [alias, setAlias] = useState("");
  const [isAdult, setIsAdult] = useState(false);
  const [politique, setPolitique] = useState<Politique | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [succes, setSucces] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [envoi, setEnvoi] = useState(false);

  const appliquer = useCallback((recu: Contact) => {
    setContact(recu);
    setMode(recu.mode);
    setAlias(recu.alias ?? "");
    setIsAdult(recu.isAdult);
    setPolitique(recu.politique);
  }, []);

  const charger = useCallback(async () => {
    setChargement(true);
    let reponse: Response;
    try {
      reponse = await fetch(`/api/contacts/${params.id}`);
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
      setErreur("Ce contact est introuvable.");
      setChargement(false);
      return;
    }
    appliquer(((await reponse.json()) as { contact: Contact }).contact);
    setChargement(false);
  }, [params.id, router, appliquer]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const enregistrer = useCallback(async () => {
    if (!politique) return;
    setEnvoi(true);
    setErreur(null);
    setSucces(null);
    let reponse: Response;
    try {
      reponse = await fetch(`/api/contacts/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: alias.trim() || null, isAdult, mode, politique }),
      });
    } catch {
      setErreur("Connexion réseau impossible. Réessaie dans un instant.");
      setEnvoi(false);
      return;
    }
    if (reponse.status === 401) {
      router.push("/login");
      return;
    }
    const corps = (await reponse.json().catch(() => null)) as
      | { contact?: Contact; erreur?: string }
      | null;
    if (!reponse.ok || !corps?.contact) {
      // Le formulaire n'est pas réinitialisé : ce que l'utilisateur voit à
      // l'écran reste ce qu'il a demandé, et le message dit ce qui a été refusé.
      setErreur(corps?.erreur ?? "Réglage refusé.");
      setEnvoi(false);
      return;
    }
    appliquer(corps.contact);
    setSucces("Réglages enregistrés.");
    setEnvoi(false);
  }, [alias, isAdult, mode, politique, params.id, router, appliquer]);

  if (chargement || !politique || !contact) {
    return (
      <main className="ecran">
        <div className="colonne">
          {erreur ? <p role="alert" className="alerte">{erreur}</p> : <p className="vide">Un instant.</p>}
          <Link href="/contacts" className="lien-discret">Retour aux contacts</Link>
        </div>
      </main>
    );
  }

  const majPolitique = (partiel: Partial<Politique>) => setPolitique({ ...politique, ...partiel });

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>{contact.nom}</h1>
          <p>
            {contact.jid.split("@")[0]} · {contact.messages} message
            {contact.messages > 1 ? "s" : ""}
            {contact.escaladesOuvertes > 0 && ` · ${contact.escaladesOuvertes} en attente de ta réponse`}
          </p>
        </header>

        {erreur && <p role="alert" className="alerte">{erreur}</p>}
        {succes && <p role="status" className="confirmation">{succes}</p>}

        <section className="section">
          <h2>Mode</h2>
          <div className="liste-groupes" role="radiogroup" aria-label="Mode du contact">
            {MODES.map((option) => (
              <button
                key={option.valeur}
                type="button"
                role="radio"
                aria-checked={mode === option.valeur}
                className="groupe"
                data-choisi={mode === option.valeur ? "" : undefined}
                onClick={() => setMode(option.valeur)}
              >
                <span className="groupe__nom">{option.titre}</span>
                <span className="groupe__detail">{option.detail}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="section">
          <h2>Identité</h2>
          <label className="champ">
            <span>Surnom</span>
            <input
              type="text"
              value={alias}
              onChange={(evenement) => setAlias(evenement.target.value)}
              placeholder={contact.pushName ?? "Sarah"}
            />
          </label>
          <label className="bascule">
            <input type="checkbox" checked={isAdult} onChange={(e) => setIsAdult(e.target.checked)} />
            <span>
              Cette personne est majeure
              <span className="bascule__detail">
                Obligatoire pour débloquer le contenu intime. Jamais déduit automatiquement.
              </span>
            </span>
          </label>
        </section>

        <section className="section">
          <h2>Garde-fous</h2>
          <p className="section__aide">
            Un garde-fou actif fait remonter le message vers toi au lieu d&apos;y répondre seul.
          </p>
          {GARDE_FOUS.map((garde) => (
            <label key={garde.cle} className="bascule">
              <input
                type="checkbox"
                checked={politique[garde.cle] as boolean}
                onChange={(e) => majPolitique({ [garde.cle]: e.target.checked } as Partial<Politique>)}
              />
              <span>{garde.libelle}</span>
            </label>
          ))}
          <label className="bascule">
            <input
              type="checkbox"
              checked={politique.intimateOverride}
              disabled={!isAdult}
              onChange={(e) => majPolitique({ intimateOverride: e.target.checked })}
            />
            <span>
              Autoriser le contenu sexuel explicite
              <span className="bascule__detail">
                {isAdult
                  ? "Le garde-fou « contenu intime » ne fera plus remonter ces messages."
                  : "Marque d'abord cette personne comme majeure."}
              </span>
            </span>
          </label>
        </section>

        <section className="section">
          <h2>Style des réponses</h2>
          <label className="champ">
            <span>Longueur</span>
            <select value={politique.styleLength} onChange={(e) => majPolitique({ styleLength: e.target.value })}>
              <option value="court">Court</option>
              <option value="moyen">Moyen</option>
              <option value="long">Long</option>
            </select>
          </label>
          <label className="champ">
            <span>Emoji</span>
            <select value={politique.styleEmoji} onChange={(e) => majPolitique({ styleEmoji: e.target.value })}>
              <option value="jamais">Jamais</option>
              <option value="parfois">Parfois</option>
              <option value="souvent">Souvent</option>
            </select>
          </label>
          <label className="champ">
            <span>Adresse</span>
            <select
              value={politique.styleFormality}
              onChange={(e) => majPolitique({ styleFormality: e.target.value })}
            >
              <option value="tutoiement">Tutoiement</option>
              <option value="vouvoiement">Vouvoiement</option>
            </select>
          </label>
        </section>

        <section className="section">
          <h2>Heures de silence</h2>
          <p className="section__aide">
            Aucune réponse ne part entre ces deux heures. Laisse vide pour ne jamais les appliquer.
          </p>
          <div className="paire">
            <label className="champ">
              <span>De</span>
              <input
                type="number" min={0} max={23}
                value={politique.quietHoursStart ?? ""}
                onChange={(e) =>
                  majPolitique({ quietHoursStart: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </label>
            <label className="champ">
              <span>À</span>
              <input
                type="number" min={0} max={23}
                value={politique.quietHoursEnd ?? ""}
                onChange={(e) =>
                  majPolitique({ quietHoursEnd: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </label>
          </div>
        </section>

        <button type="button" className="bouton-principal" onClick={() => void enregistrer()} disabled={envoi}>
          {envoi ? "Enregistrement…" : "Enregistrer"}
        </button>

        <Link href="/contacts" className="lien-discret">
          Retour aux contacts
        </Link>
      </div>
    </main>
  );
}
