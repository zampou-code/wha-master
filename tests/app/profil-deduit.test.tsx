// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProfilDeduit, { type Profil } from "@/app/contacts/[id]/profil";

const fetchMock = vi.fn();
const surAnalyse = vi.fn();
const surApplication = vi.fn();

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PROFIL: Profil = {
  ton: "taquine, directe",
  rythme: "surtout le soir",
  sujets: ["travail", "rendez-vous"],
  propositions: {
    styleLength: { valeur: "court", preuve: "Tes messages font 30 caractères en médiane sur 40 messages." },
    minDelaySec: { valeur: 300, preuve: "Tu réponds en 10 min en médiane (20 réponses mesurées)." },
  },
  analyseA: "2026-10-17T12:00:00.000Z",
};

function monter(profil: Profil | null) {
  render(
    <ProfilDeduit
      contactId="c1"
      profil={profil}
      surAnalyse={surAnalyse}
      surApplication={surApplication}
    />,
  );
}

describe("profil déduit d'un contact", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    surAnalyse.mockReset();
    surApplication.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("montre chaque proposition avec ce qui la justifie", async () => {
    // C'est toute la différence entre un réglage qu'on accepte et un réglage
    // qu'on subit : la preuve est affichée à côté de la valeur.
    monter(PROFIL);

    expect(screen.getByText(/Longueur des réponses : court/)).toBeTruthy();
    expect(screen.getByText(/30 caractères en médiane sur 40 messages/)).toBeTruthy();
    // Les secondes sont rendues lisibles : « 300 s » ne se compare à rien.
    expect(screen.getByText(/Délai minimum avant réponse : 5 min/)).toBeTruthy();
  });

  it("reporte les propositions dans le formulaire sans les enregistrer", async () => {
    // Appliquer directement en base contournerait l'enregistrement explicite,
    // et donc la bannière qui prévient d'un réglage non enregistré.
    monter(PROFIL);

    await userEvent.click(screen.getByRole("button", { name: /Reporter ces réglages/ }));

    expect(surApplication).toHaveBeenCalledWith(PROFIL.propositions);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/il reste à enregistrer/)).toBeTruthy();
  });

  it("lance l'analyse et remonte le profil obtenu", async () => {
    monter(null);
    fetchMock.mockResolvedValueOnce(reponseJson({ profil: PROFIL }));

    await userEvent.click(screen.getByRole("button", { name: "Analyser l'historique" }));

    expect(fetchMock.mock.calls[0][0]).toBe("/api/contacts/c1/profil");
    expect(surAnalyse).toHaveBeenCalledWith(PROFIL);
  });

  it("dit d'importer l'historique quand il n'y a rien à lire", async () => {
    monter(null);
    fetchMock.mockResolvedValueOnce(
      reponseJson({ erreur: "Ce fil est vide. Importe l'historique de la conversation avant de l'analyser." }, 400),
    );

    await userEvent.click(screen.getByRole("button", { name: "Analyser l'historique" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Ce fil est vide. Importe l'historique de la conversation avant de l'analyser.",
    );
  });

  it("n'affiche aucun bouton d'application sans proposition", async () => {
    monter({ ...PROFIL, propositions: {} });

    expect(screen.queryByRole("button", { name: /Reporter ces réglages/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Analyser à nouveau/ })).toBeTruthy();
  });
});
