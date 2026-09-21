"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Decision = {
  id: string;
  quand: string;
  issue: "AUTO_SENT" | "DRAFTED" | "ESCALATED" | "IGNORED" | "EXPIRED";
  risques: string[];
  regle: string;
  coutUsd: number | null;
  contact: { id: string; nom: string };
  message: string | null;
  escalade: { statut: string; resolution: string | null } | null;
};

const LIBELLE_ISSUE: Record<Decision["issue"], string> = {
  AUTO_SENT: "envoyé seul",
  DRAFTED: "soumis à toi",
  ESCALATED: "escaladé",
  IGNORED: "ignoré",
  EXPIRED: "expiré",
};

const LIBELLE_RISQUE: Record<string, string> = {
  ENGAGEMENT: "engagement",
  FACT: "question sur toi",
  EMOTIONAL: "émotionnel",
  MONEY: "argent",
  INTIMATE: "intime",
  THIRD_PARTY: "tierce personne",
  LOW_CONFIDENCE: "incertain",
  NON_TEXT: "non textuel",
};

function quand(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const heures = Math.floor(minutes / 60);
  if (heures < 24) return `il y a ${heures} h`;
  return `il y a ${Math.floor(heures / 24)} j`;
}

export default function Journal() {
  const router = useRouter();
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [chargement, setChargement] = useState(true);

  const charger = useCallback(async () => {
    setChargement(true);
    setErreur(null);
    let reponse: Response;
    try {
      reponse = await fetch("/api/journal");
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
      setErreur("Impossible de lire le journal.");
      setChargement(false);
      return;
    }
    setDecisions(((await reponse.json()) as { decisions: Decision[] }).decisions);
    setChargement(false);
  }, [router]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const cout = (decisions ?? []).reduce((total, d) => total + (d.coutUsd ?? 0), 0);

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>Journal</h1>
          <p>
            Chaque message reçu produit une décision, même quand elle consiste à ne rien faire.
            Voici les cinquante dernières.
          </p>
        </header>

        {erreur && <p role="alert" className="alerte">{erreur}</p>}

        {decisions && decisions.length > 0 && (
          <>
            <p className="section__aide">
              Coût cumulé sur ces décisions : {cout > 0 ? `${cout.toFixed(4)} $` : "aucun appel payant"}.
            </p>
            <div className="liste-groupes">
              {decisions.map((decision) => (
                <div key={decision.id} className="groupe" data-actuel={decision.escalade?.statut === "OPEN" ? "" : undefined}>
                  <span className="groupe__nom">
                    {decision.contact.nom} — {LIBELLE_ISSUE[decision.issue]}
                  </span>
                  {decision.message && (
                    <span className="groupe__detail journal__message">
                      « {decision.message.length > 120 ? `${decision.message.slice(0, 120)}…` : decision.message} »
                    </span>
                  )}
                  <span className="groupe__detail">
                    {quand(decision.quand)} · {decision.regle}
                    {decision.risques.length > 0 &&
                      ` · ${decision.risques.map((r) => LIBELLE_RISQUE[r] ?? r).join(" + ")}`}
                    {decision.escalade?.statut === "OPEN" && " · en attente de ta réponse"}
                    {decision.escalade?.resolution && ` · ${decision.escalade.resolution}`}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {decisions && decisions.length === 0 && !chargement && (
          <p className="vide">
            Aucune décision pour l&apos;instant. Elles apparaissent dès qu&apos;un message arrive sur
            le numéro relié.
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
