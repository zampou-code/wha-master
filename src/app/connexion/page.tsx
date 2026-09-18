"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Statut = { isConnected: boolean; isLoggedIn: boolean; jid?: string };
type EtatRail = "attente" | "connecte" | "erreur";

const MESSAGE_RESEAU = "Connexion réseau impossible. Nouvelle tentative automatique.";
const URL_IMAGE_QR = "/api/whatsapp/qr/image";

export default function Appairage() {
  const router = useRouter();
  const [statut, setStatut] = useState<Statut | null>(null);
  const [qrPret, setQrPret] = useState(false);
  const [versionQr, setVersionQr] = useState(0);
  const [codeExpire, setCodeExpire] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  // Garde par ref, pas par effet secondaire dans un updater de useState : React
  // peut invoquer un updater plusieurs fois (Strict Mode en dev) sans que ce soit
  // observable, ce qui interdit d'y placer un appel réseau. Cette ref, elle,
  // reflète fidèlement « une demande de QR a déjà été faite pour ce cycle
  // non-apparié » et survit sans problème à un double montage Strict Mode.
  const demandeEnCoursRef = useRef(false);
  const minuteurExpirationRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const annulerMinuteurExpiration = useCallback(() => {
    if (minuteurExpirationRef.current !== null) {
      clearTimeout(minuteurExpirationRef.current);
      minuteurExpirationRef.current = null;
    }
  }, []);

  const rafraichirStatut = useCallback(async () => {
    let reponse: Response;
    try {
      reponse = await fetch("/api/whatsapp/status");
    } catch {
      setErreur(MESSAGE_RESEAU);
      return;
    }
    if (reponse.status === 401) {
      router.push("/login");
      return;
    }
    if (!reponse.ok) {
      setErreur("WhatsApp est injoignable.");
      return;
    }
    setErreur(null);
    setStatut(await reponse.json());
  }, [router]);

  const demanderQr = useCallback(async () => {
    let reponse: Response;
    try {
      reponse = await fetch("/api/whatsapp/qr");
    } catch {
      setErreur(MESSAGE_RESEAU);
      return;
    }
    if (reponse.status === 401) {
      router.push("/login");
      return;
    }
    if (!reponse.ok) {
      setErreur("Impossible d'obtenir le QR code.");
      return;
    }
    const { durationSec } = (await reponse.json()) as { durationSec: number; imageUrl: string };
    setErreur(null);
    setCodeExpire(false);
    // L'image est relayée par une route de même origine (jamais qr_link, qui
    // pointe vers GOWA et n'est pas joignable depuis le navigateur). L'URL de
    // cette route est stable : seul ce paramètre de version change, pour forcer
    // le navigateur à recharger l'image à chaque nouveau code plutôt que de
    // garder affiché celui, expiré, du cycle précédent.
    setVersionQr(Date.now());
    setQrPret(true);

    // Un code d'appairage WhatsApp vit environ 20 à 30 secondes. Sans ce
    // minuteur, un opérateur qui va chercher son téléphone et revient après ce
    // délai scanne un code mort sans le moindre indice qu'il doit en redemander
    // un — voir la revue de branche, point 4.
    annulerMinuteurExpiration();
    minuteurExpirationRef.current = setTimeout(() => {
      setCodeExpire(true);
      void demanderQr();
    }, durationSec * 1000);
  }, [router, annulerMinuteurExpiration]);

  useEffect(() => {
    void rafraichirStatut();
    const intervalle = setInterval(rafraichirStatut, 3000);
    return () => clearInterval(intervalle);
  }, [rafraichirStatut]);

  // Ne dépend que du booléen (pas de l'objet `statut`, qui change de référence à
  // chaque sondage) : ne redemande un QR que lors d'une transition réelle vers
  // l'état non apparié, jamais à chaque cycle de sondage (3 s). La garde réelle
  // contre les demandes en double est `demandeEnCoursRef`, pas ce tableau de
  // dépendances.
  useEffect(() => {
    if (statut?.isLoggedIn) {
      annulerMinuteurExpiration();
      demandeEnCoursRef.current = false;
      setQrPret(false);
      setCodeExpire(false);
      return;
    }
    if (!statut) return;
    if (!demandeEnCoursRef.current) {
      demandeEnCoursRef.current = true;
      void demanderQr();
    }
  }, [statut?.isLoggedIn, demanderQr, annulerMinuteurExpiration]);

  // Nettoyage au démontage : indépendant du cycle ci-dessus, pour ne jamais
  // laisser un minuteur d'expiration tourner sur un composant qui n'existe plus.
  useEffect(() => {
    return () => annulerMinuteurExpiration();
  }, [annulerMinuteurExpiration]);

  function declencherRegeneration() {
    // Gestionnaire synchrone plutôt qu'un onClick async brut : même si
    // demanderQr() ne rejette plus (elle intercepte déjà ses propres erreurs),
    // un onClick async non intercepté est un rejet non géré en puissance à
    // chaque clic — on ne laisse pas cette classe d'erreur passer ici non plus.
    demanderQr().catch(() => setErreur(MESSAGE_RESEAU));
  }

  const etat: EtatRail = erreur ? "erreur" : statut?.isLoggedIn ? "connecte" : "attente";
  const libelle =
    etat === "erreur" ? "Liaison indisponible" : etat === "connecte" ? "Appareil relié" : "En attente du scan";
  const detail =
    etat === "erreur"
      ? "Vérifie la connexion et réessaie."
      : etat === "connecte"
        ? `Rien à faire${statut?.jid ? ` — connecté en tant que ${statut.jid}` : ""}.`
        : "Ouvre WhatsApp, puis Appareils connectés, puis scanne ce code.";

  return (
    <main className="ecran">
      <div className="colonne">
        <header className="entete">
          <h1>Appairage WhatsApp</h1>
        </header>

        <div className="bloc-etat" data-etat={etat} aria-live="polite">
          <span className="bloc-etat__indicateur" aria-hidden="true" />
          <div className="bloc-etat__texte">
            <p className="bloc-etat__libelle">{libelle}</p>
            <p className="bloc-etat__detail">{detail}</p>
          </div>
        </div>

        {erreur && <p role="alert" className="alerte">{erreur}</p>}

        {statut?.isLoggedIn ? (
          <p className="etat-relie">
            Appareil appairé{statut.jid ? ` (${statut.jid})` : ""}. Rien à faire.
          </p>
        ) : (
          <>
            <div className="cadre-qr">
              {codeExpire ? (
                <p className="cadre-qr__message">Code expiré. Nouveau code en préparation.</p>
              ) : qrPret ? (
                <img
                  src={`${URL_IMAGE_QR}?v=${versionQr}`}
                  alt="QR code d'appairage WhatsApp"
                  width={320}
                  height={320}
                  className="cadre-qr__image"
                />
              ) : (
                <p className="cadre-qr__message">Le code se prépare.</p>
              )}
            </div>
            <button type="button" className="bouton-secondaire" onClick={declencherRegeneration}>
              Régénérer le code
            </button>
          </>
        )}
      </div>
    </main>
  );
}
