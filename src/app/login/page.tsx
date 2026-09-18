"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "@/lib/auth-client";

export default function Connexion() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);

  async function soumettre(evenement: React.FormEvent) {
    evenement.preventDefault();
    setEnCours(true);
    setErreur(null);
    try {
      const { error } = await signIn.email({ email, password: motDePasse });
      if (error) {
        setErreur("Identifiants incorrects.");
        return;
      }
      router.push("/connexion");
    } catch {
      setErreur("Problème de connexion réseau. Réessayez.");
    } finally {
      setEnCours(false);
    }
  }

  return (
    <main>
      <h1>Connexion</h1>
      <form onSubmit={soumettre}>
        <label htmlFor="email">Adresse e-mail</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="mdp">Mot de passe</label>
        <input id="mdp" type="password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} required />
        {erreur && <p role="alert">{erreur}</p>}
        <button type="submit" disabled={enCours}>{enCours ? "Connexion…" : "Se connecter"}</button>
      </form>
    </main>
  );
}
