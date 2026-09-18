"use client";
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";

type Statut = { isConnected: boolean; isLoggedIn: boolean; jid?: string };

export default function Appairage() {
  const [statut, setStatut] = useState<Statut | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const rafraichirStatut = useCallback(async () => {
    const reponse = await fetch("/api/whatsapp/status");
    if (!reponse.ok) {
      setErreur("WhatsApp est injoignable.");
      return;
    }
    setErreur(null);
    setStatut(await reponse.json());
  }, []);

  const demanderQr = useCallback(async () => {
    const reponse = await fetch("/api/whatsapp/qr");
    if (!reponse.ok) {
      setErreur("Impossible d'obtenir le QR code.");
      return;
    }
    const { code } = (await reponse.json()) as { code: string };
    setQr(await QRCode.toDataURL(code, { width: 320, margin: 1 }));
  }, []);

  useEffect(() => {
    void rafraichirStatut();
    const intervalle = setInterval(rafraichirStatut, 3000);
    return () => clearInterval(intervalle);
  }, [rafraichirStatut]);

  useEffect(() => {
    if (statut && !statut.isLoggedIn) void demanderQr();
    if (statut?.isLoggedIn) setQr(null);
  }, [statut, demanderQr]);

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
