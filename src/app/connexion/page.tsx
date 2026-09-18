"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";

type Statut = { isConnected: boolean; isLoggedIn: boolean; jid?: string };

export default function Appairage() {
  const router = useRouter();
  const [statut, setStatut] = useState<Statut | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const rafraichirStatut = useCallback(async () => {
    const reponse = await fetch("/api/whatsapp/status");
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
    const reponse = await fetch("/api/whatsapp/qr");
    if (reponse.status === 401) {
      router.push("/login");
      return;
    }
    if (!reponse.ok) {
      setErreur("Impossible d'obtenir le QR code.");
      return;
    }
    const { code } = (await reponse.json()) as { code: string };
    setQr(await QRCode.toDataURL(code, { width: 320, margin: 1 }));
  }, [router]);

  useEffect(() => {
    void rafraichirStatut();
    const intervalle = setInterval(rafraichirStatut, 3000);
    return () => clearInterval(intervalle);
  }, [rafraichirStatut]);

  // Ne dépend que du booléen (pas de l'objet `statut`, qui change de référence à
  // chaque sondage) : ne redemande un QR que lors d'une transition réelle vers
  // l'état non apparié, jamais à chaque cycle de sondage (3 s).
  useEffect(() => {
    if (statut?.isLoggedIn) {
      setQr(null);
      return;
    }
    if (!statut) return;
    setQr((qrActuel) => {
      if (qrActuel === null) void demanderQr();
      return qrActuel;
    });
  }, [statut?.isLoggedIn, demanderQr]);

  return (
    <main>
      <h1>Connexion WhatsApp</h1>
      {erreur && <p role="alert">{erreur}</p>}
      {statut?.isLoggedIn ? (
        <p>Appareil appairé{statut.jid ? ` (${statut.jid})` : ""}. Rien à faire.</p>
      ) : (
        <>
          <p>Ouvre WhatsApp, puis Appareils connectés, puis scanne ce code.</p>
          {qr ? <img src={qr} alt="QR code d'appairage WhatsApp" width={320} height={320} /> : <p>Génération du code…</p>}
          <button type="button" onClick={demanderQr}>Régénérer le code</button>
        </>
      )}
    </main>
  );
}
