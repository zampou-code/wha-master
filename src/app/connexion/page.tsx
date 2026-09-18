"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";

type Statut = { isConnected: boolean; isLoggedIn: boolean; jid?: string };

const MESSAGE_RESEAU = "Connexion réseau impossible. Nouvelle tentative automatique.";

export default function Appairage() {
  const router = useRouter();
  const [statut, setStatut] = useState<Statut | null>(null);
  const [qr, setQr] = useState<string | null>(null);
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
    const { code, durationSec } = (await reponse.json()) as { code: string; durationSec: number };
    setErreur(null);
    setCodeExpire(false);
    setQr(await QRCode.toDataURL(code, { width: 320, margin: 1 }));

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
      setQr(null);
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

  return (
    <main>
      <h1>Connexion WhatsApp</h1>
      {erreur && <p role="alert">{erreur}</p>}
      {statut?.isLoggedIn ? (
        <p>Appareil appairé{statut.jid ? ` (${statut.jid})` : ""}. Rien à faire.</p>
      ) : (
        <>
          <p>Ouvre WhatsApp, puis Appareils connectés, puis scanne ce code.</p>
          {codeExpire ? (
            <p>Code expiré, génération d&apos;un nouveau code…</p>
          ) : qr ? (
            <img src={qr} alt="QR code d'appairage WhatsApp" width={320} height={320} />
          ) : (
            <p>Génération du code…</p>
          )}
          <button type="button" onClick={declencherRegeneration}>Régénérer le code</button>
        </>
      )}
    </main>
  );
}
