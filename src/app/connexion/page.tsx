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
  const [sourceQr, setSourceQr] = useState<string | null>(null);
  const [codeExpire, setCodeExpire] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  // Garde par ref, pas par effet secondaire dans un updater de useState : React
  // peut invoquer un updater plusieurs fois (Strict Mode en dev) sans que ce soit
  // observable, ce qui interdit d'y placer un appel réseau. Cette ref, elle,
  // reflète fidèlement « une demande de QR a déjà été faite pour ce cycle
  // non-apparié » et survit sans problème à un double montage Strict Mode.
  const demandeEnCoursRef = useRef(false);
  const minuteurExpirationRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // L'image du QR arrive en octets, pas en URL : on la matérialise en URL
  // d'objet. Elle doit être révoquée à chaque remplacement et au démontage,
  // sinon chaque régénération fuit un blob dans la mémoire de l'onglet.
  const urlObjetRef = useRef<string | null>(null);

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

  const remplacerImage = useCallback((blob: Blob) => {
    if (urlObjetRef.current !== null) URL.revokeObjectURL(urlObjetRef.current);
    const url = URL.createObjectURL(blob);
    urlObjetRef.current = url;
    setSourceQr(url);
  }, []);

  const demanderQr = useCallback(async () => {
    let reponse: Response;
    try {
      // Un seul appel : cette route relaie les octets ET annonce la durée de
      // validité en en-tête. Un second appel annulerait la session d'appairage
      // que celui-ci vient d'ouvrir côté GOWA.
      reponse = await fetch(`${URL_IMAGE_QR}?v=${Date.now()}`);
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

    const duree = Number(reponse.headers.get("X-QR-Duration"));
    const dureeSec = Number.isFinite(duree) && duree > 0 ? duree : 20;
    remplacerImage(await reponse.blob());
    setErreur(null);
    setCodeExpire(false);

    // Un code d'appairage WhatsApp vit environ 20 à 30 secondes. Sans ce
    // minuteur, un opérateur qui va chercher son téléphone et revient après ce
    // délai scanne un code mort sans le moindre indice qu'il doit en redemander
    // un — voir la revue de branche, point 4.
    annulerMinuteurExpiration();
    minuteurExpirationRef.current = setTimeout(() => {
      // On signale l'expiration sans régénérer automatiquement. Chaque appel à
      // /app/login consomme une tentative d'association côté WhatsApp, qui
      // applique une limitation anti-abus (« Impossible de connecter de
      // nouveaux appareils pour le moment »). Une boucle de rafraîchissement
      // automatique sur un point d'accès limité maintient le compte bloqué au
      // lieu de l'en sortir. La régénération reste possible, d'un geste
      // explicite : l'opérateur est devant l'écran, téléphone en main.
      setCodeExpire(true);
    }, dureeSec * 1000);
  }, [router, annulerMinuteurExpiration, remplacerImage]);

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
      setSourceQr(null);
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
    return () => {
      annulerMinuteurExpiration();
      if (urlObjetRef.current !== null) URL.revokeObjectURL(urlObjetRef.current);
    };
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
                <p className="cadre-qr__message">Code expiré. Appuie sur Régénérer le code.</p>
              ) : sourceQr ? (
                <img
                  src={sourceQr}
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
