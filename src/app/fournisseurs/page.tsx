"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  modelesPour,
  modeleRecommande,
  POURQUOI_RECOMMANDE,
  type RoleModele,
} from "@/fournisseurs/modeles";

type Kind = "ANTHROPIC" | "OPENAI" | "GOOGLE" | "KIMI" | "OPENAI_COMPATIBLE" | "OLLAMA";
type Fournisseur = {
  id: string;
  name: string;
  kind: Kind;
  baseUrl: string | null;
  enabled: boolean;
  cleMasquee: string | null;
  lastError: string | null;
};
type EntreeRole = { providerId: string; model: string };
type Reglages = { fournisseurs: Fournisseur[]; roles: Record<string, EntreeRole[]> };

type TypeFournisseur = {
  valeur: Kind;
  libelle: string;
  adresseRequise: boolean;
  // Pré-remplie quand elle est connue : une adresse à retaper de mémoire est
  // une faute d'inattention qui ne se voit qu'au premier appel raté.
  adresseParDefaut?: string;
  modeleExemple: string;
};

const KINDS: TypeFournisseur[] = [
  { valeur: "ANTHROPIC", libelle: "Anthropic", adresseRequise: false, modeleExemple: "claude-sonnet-5" },
  { valeur: "OPENAI", libelle: "OpenAI", adresseRequise: false, modeleExemple: "gpt-5" },
  { valeur: "GOOGLE", libelle: "Google", adresseRequise: false, modeleExemple: "gemini-2.5-pro" },
  {
    valeur: "KIMI",
    libelle: "Kimi (Moonshot)",
    adresseRequise: false,
    adresseParDefaut: "https://api.moonshot.ai/v1",
    modeleExemple: "kimi-k2-0905-preview",
  },
  {
    valeur: "OPENAI_COMPATIBLE",
    libelle: "Compatible OpenAI (OpenRouter, autre…)",
    adresseRequise: true,
    modeleExemple: "openai/gpt-4o-mini",
  },
  { valeur: "OLLAMA", libelle: "Ollama (local)", adresseRequise: true, modeleExemple: "llama3.1" },
];

const ROLES: { cle: string; titre: string; detail: string }[] = [
  { cle: "classify", titre: "Classer", detail: "Repère le risque dans les messages reçus." },
  { cle: "compose", titre: "Rédiger", detail: "Écrit les réponses qui te sont soumises." },
  { cle: "profile", titre: "Profiler", detail: "Déduit des réglages depuis l'historique." },
  { cle: "summarize", titre: "Résumer", detail: "Condense les longues conversations." },
];

const MESSAGE_RESEAU = "Connexion réseau impossible. Réessaie dans un instant.";

/**
 * Choix du modèle : une liste quand on connaît les modèles du fournisseur, la
 * saisie libre sinon — et toujours en secours, parce que ces listes périment.
 */
function ChoixModele({
  kind,
  role,
  valeur,
  onChange,
}: {
  kind?: Kind;
  role: string;
  valeur: string;
  onChange: (model: string) => void;
}) {
  const connus = kind ? modelesPour(kind) : [];
  const recommande = kind ? modeleRecommande(kind, role as RoleModele) : null;
  const dansLaListe = connus.some((modele) => modele.id === valeur);
  // « Autre » reste sélectionné tant qu'on y a mis quelque chose, pour ne pas
  // renvoyer l'utilisateur dans la liste à chaque frappe.
  const [libre, setLibre] = useState(valeur !== "" && !dansLaListe);

  const choisi = connus.find((modele) => modele.id === valeur);

  if (connus.length === 0 || libre) {
    return (
      <label className="champ">
        <span>
          Modèle
          {connus.length > 0 && (
            <button type="button" className="lien-inline" onClick={() => setLibre(false)}>
              revenir à la liste
            </button>
          )}
        </span>
        <input
          type="text"
          value={valeur}
          onChange={(e) => onChange(e.target.value)}
          placeholder="identifiant exact du modèle"
        />
        {connus.length === 0 && (
          <span className="champ__aide">
            Je ne connais pas les modèles de ce fournisseur : copie l&apos;identifiant depuis sa
            documentation.
          </span>
        )}
      </label>
    );
  }

  return (
    <label className="champ">
      <span>Modèle</span>
      <select
        value={dansLaListe ? valeur : ""}
        onChange={(e) => {
          if (e.target.value === "__autre__") {
            setLibre(true);
            onChange("");
            return;
          }
          onChange(e.target.value);
        }}
      >
        <option value="" disabled>Choisis un modèle</option>
        {connus.map((modele) => (
          <option key={modele.id} value={modele.id}>
            {modele.libelle}
            {modele.id === recommande ? " — recommandé" : ""}
          </option>
        ))}
        <option value="__autre__">Autre (saisir l&apos;identifiant)</option>
      </select>
      <span className="champ__aide">
        {choisi
          ? choisi.note
          : recommande
            ? `Recommandé ici : ${connus.find((m) => m.id === recommande)?.libelle ?? recommande} — ${POURQUOI_RECOMMANDE[role as RoleModele]}.`
            : ""}
      </span>
    </label>
  );
}

export default function Fournisseurs() {
  const router = useRouter();
  const [reglages, setReglages] = useState<Reglages | null>(null);
  const [nom, setNom] = useState("");
  const [kind, setKind] = useState<Kind>("ANTHROPIC");
  const [adresse, setAdresse] = useState("");
  const [cle, setCle] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [succes, setSucces] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);
  const [envoi, setEnvoi] = useState(false);

  const charger = useCallback(async () => {
    setChargement(true);
    let reponse: Response;
    try {
      reponse = await fetch("/api/fournisseurs");
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
      setErreur("Impossible de lire les fournisseurs.");
      setChargement(false);
      return;
    }
    setReglages(((await reponse.json()) as { reglages: Reglages }).reglages);
    setChargement(false);
  }, [router]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const envoyer = useCallback(
    async (methode: string, corps: unknown, messageSucces: string) => {
      setEnvoi(true);
      setErreur(null);
      setSucces(null);
      let reponse: Response;
      try {
        reponse = await fetch("/api/fournisseurs", {
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
        | { reglages?: Reglages; erreur?: string }
        | null;
      if (!reponse.ok || !recu?.reglages) {
        setErreur(recu?.erreur ?? "Opération refusée.");
        setEnvoi(false);
        return false;
      }
      setReglages(recu.reglages);
      setSucces(messageSucces);
      setEnvoi(false);
      return true;
    },
    [router],
  );

  if (chargement || !reglages) {
    return (
      <main className="ecran">
        <div className="colonne">
          {erreur ? <p role="alert" className="alerte">{erreur}</p> : <p className="vide">Un instant.</p>}
          <Link href="/" className="lien-discret">Retour</Link>
        </div>
      </main>
    );
  }

  const typeChoisi = KINDS.find((k) => k.valeur === kind);
  const composeConfigure = (reglages.roles.compose ?? []).length > 0;
  const classifyConfigure = (reglages.roles.classify ?? []).length > 0;

  const changerRole = (role: string, index: number, partiel: Partial<EntreeRole>) => {
    const entrees = [...(reglages.roles[role] ?? [])];
    entrees[index] = { ...entrees[index], ...partiel };
    setReglages({ ...reglages, roles: { ...reglages.roles, [role]: entrees } });
  };
  const ajouterEntree = (role: string) => {
    // Pré-rempli avec le modèle conseillé : le cas courant ne demande alors
    // aucun choix, et ce qui s'affiche est déjà un réglage valide.
    const premier = reglages.fournisseurs[0];
    const conseille = premier ? modeleRecommande(premier.kind, role as RoleModele) : null;
    const entrees = [...(reglages.roles[role] ?? []), { providerId: premier?.id ?? "", model: conseille ?? "" }];
    setReglages({ ...reglages, roles: { ...reglages.roles, [role]: entrees } });
  };
  const retirerEntree = (role: string, index: number) => {
    const entrees = (reglages.roles[role] ?? []).filter((_, i) => i !== index);
    setReglages({ ...reglages, roles: { ...reglages.roles, [role]: entrees } });
  };

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>Fournisseurs d&apos;IA</h1>
          <p>
            Tes clés sont chiffrées avant d&apos;être stockées et ne ressortent jamais d&apos;ici.
            Plusieurs fournisseurs par rôle : le suivant prend le relais si le premier ne répond pas.
          </p>
        </header>

        {erreur && <p role="alert" className="alerte">{erreur}</p>}
        {succes && <p role="status" className="confirmation">{succes}</p>}

        <div className="bloc-etat" data-etat={composeConfigure ? "connecte" : "attente"}>
          <span className="bloc-etat__indicateur" aria-hidden="true" />
          <div className="bloc-etat__texte">
            <p className="bloc-etat__libelle">
              {composeConfigure ? "Rédaction opérationnelle" : "Aucun rédacteur"}
            </p>
            <p className="bloc-etat__detail">
              {composeConfigure
                ? classifyConfigure
                  ? "Les deux rôles indispensables sont couverts."
                  : "Le classement n'a aucun fournisseur : tout message sera traité comme incertain, donc escaladé."
                : "Tu recevras des alertes sans proposition tant qu'aucun fournisseur ne rédige."}
            </p>
          </div>
        </div>

        <section className="section">
          <h2>Fournisseurs enregistrés</h2>
          {reglages.fournisseurs.length === 0 && (
            <p className="vide">Aucun fournisseur pour l&apos;instant.</p>
          )}
          {reglages.fournisseurs.length > 0 && (
            <div className="liste-groupes">
              {reglages.fournisseurs.map((fournisseur) => (
                <div key={fournisseur.id} className="fait">
                  <button
                    type="button"
                    className="fait__bascule"
                    aria-pressed={fournisseur.enabled}
                    disabled={envoi}
                    onClick={() =>
                      void envoyer(
                        "PUT",
                        { ...fournisseur, apiKey: null, enabled: !fournisseur.enabled },
                        fournisseur.enabled
                          ? `${fournisseur.name} est désactivé.`
                          : `${fournisseur.name} est activé.`,
                      )
                    }
                  >
                    <span className="groupe__nom">{fournisseur.name}</span>
                    <span className="groupe__detail">
                      {fournisseur.enabled ? "actif" : "désactivé"}
                      {fournisseur.cleMasquee ? ` · clé ${fournisseur.cleMasquee}` : " · aucune clé"}
                      {fournisseur.lastError ? " · dernière erreur enregistrée" : ""}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="fait__retirer"
                    aria-label={`Supprimer ${fournisseur.name}`}
                    disabled={envoi}
                    onClick={() =>
                      void envoyer("DELETE", { id: fournisseur.id }, `${fournisseur.name} supprimé.`)
                    }
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="section">
          <h2>Ajouter un fournisseur</h2>
          <label className="champ">
            <span>Nom</span>
            <input type="text" value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Anthropic principal" />
          </label>
          <label className="champ">
            <span>Type</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k.valeur} value={k.valeur}>{k.libelle}</option>
              ))}
            </select>
          </label>
          {(typeChoisi?.adresseRequise || typeChoisi?.adresseParDefaut) && (
            <label className="champ">
              <span>
                Adresse de base
                {typeChoisi?.adresseParDefaut && " — laisse vide pour l'adresse habituelle"}
              </span>
              <input
                type="url"
                value={adresse}
                onChange={(e) => setAdresse(e.target.value)}
                placeholder={typeChoisi?.adresseParDefaut ?? "https://openrouter.ai/api/v1"}
              />
            </label>
          )}
          <label className="champ">
            <span>Clé d&apos;API</span>
            <input
              type="password"
              value={cle}
              onChange={(e) => setCle(e.target.value)}
              autoComplete="off"
              placeholder="sk-…"
            />
          </label>
          <button
            type="button"
            className="bouton-secondaire"
            disabled={envoi || nom.trim() === ""}
            onClick={async () => {
              const ajoute = await envoyer(
                "PUT",
                { name: nom, kind, baseUrl: adresse || null, apiKey: cle || null, enabled: true },
                "Fournisseur enregistré.",
              );
              if (ajoute) {
                setNom("");
                setAdresse("");
                setCle("");
              }
            }}
          >
            Enregistrer ce fournisseur
          </button>
        </section>

        <section className="section">
          <h2>Qui fait quoi</h2>
          <p className="section__aide">
            L&apos;ordre compte : le premier est essayé, puis le suivant s&apos;il échoue.
          </p>
          {ROLES.map((role) => (
            <div key={role.cle} className="role">
              <p className="role__titre">{role.titre}</p>
              <p className="role__detail">{role.detail}</p>
              {(reglages.roles[role.cle] ?? []).map((entree, index) => (
                <div key={`${role.cle}-${index}`} className="paire">
                  <label className="champ">
                    <span>Fournisseur</span>
                    <select
                      value={entree.providerId}
                      onChange={(e) => changerRole(role.cle, index, { providerId: e.target.value })}
                    >
                      {reglages.fournisseurs.map((fournisseur) => (
                        <option key={fournisseur.id} value={fournisseur.id}>{fournisseur.name}</option>
                      ))}
                    </select>
                  </label>
                  <ChoixModele
                    kind={reglages.fournisseurs.find((f) => f.id === entree.providerId)?.kind}
                    role={role.cle}
                    valeur={entree.model}
                    onChange={(model) => changerRole(role.cle, index, { model })}
                  />
                  <button
                    type="button"
                    className="fait__retirer"
                    aria-label={`Retirer cette entrée du rôle ${role.titre}`}
                    onClick={() => retirerEntree(role.cle, index)}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="bouton-secondaire"
                disabled={reglages.fournisseurs.length === 0}
                onClick={() => ajouterEntree(role.cle)}
              >
                Ajouter un fournisseur à ce rôle
              </button>
            </div>
          ))}
          <button
            type="button"
            className="bouton-principal"
            disabled={envoi}
            onClick={() => void envoyer("PUT", { roles: reglages.roles }, "Affectations enregistrées.")}
          >
            {envoi ? "Enregistrement…" : "Enregistrer les affectations"}
          </button>
        </section>

        <Link href="/" className="lien-discret">
          Retour
        </Link>
      </div>
    </main>
  );
}
