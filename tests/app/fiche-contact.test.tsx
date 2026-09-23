// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
// Référence stable, comme le vrai useRouter() de Next.js.
const routerStub = { push };
vi.mock("next/navigation", () => ({
  useRouter: () => routerStub,
  useParams: () => ({ id: "c1" }),
}));

const fetchMock = vi.fn();

const POLITIQUE = {
  guardEngagement: true,
  guardFacts: true,
  guardEmotional: true,
  guardMoney: true,
  guardIntimate: true,
  guardThirdParty: true,
  intimateOverride: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: "Africa/Abidjan",
  maxAutoStreak: 6,
  minDelaySec: 45,
  maxDelaySec: 600,
  styleLength: "moyen",
  styleEmoji: "parfois",
  styleFormality: "tutoiement",
  styleLanguage: "fr",
  styleInitiative: "rare",
};

function contact(mode: "OFF" | "DRAFT" | "AUTO") {
  return {
    id: "c1",
    jid: "225@s.whatsapp.net",
    nom: "Sarah",
    alias: "Sarah",
    pushName: "Sarah",
    mode,
    isAdult: false,
    messages: 3,
    escaladesOuvertes: 0,
    politique: POLITIQUE,
  };
}

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fiche contact — changements non enregistrés", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    push.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("prévient quand un réglage a changé sans être enregistré", async () => {
    // Le bouton est tout en bas, sous quatre sections : changer le mode en haut
    // puis quitter la page était le geste le plus naturel, et le réglage était
    // perdu sans un mot. C'est exactement ce qui s'est produit en usage réel.
    fetchMock.mockResolvedValue(reponseJson({ contact: contact("DRAFT") }));
    const { default: FicheContact } = await import("@/app/contacts/[id]/page");
    render(<FicheContact />);

    await screen.findByText("Sarah");
    expect(screen.queryByText(/Modifications non enregistrées/i)).toBeNull();
    expect((screen.getByRole("button", { name: /Rien à enregistrer/i }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: /Automatique/i }));

    expect(screen.getByText(/Modifications non enregistrées/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("cesse de prévenir une fois le réglage enregistré", async () => {
    fetchMock.mockResolvedValueOnce(reponseJson({ contact: contact("DRAFT") }));
    const { default: FicheContact } = await import("@/app/contacts/[id]/page");
    render(<FicheContact />);
    await screen.findByText("Sarah");

    await userEvent.click(screen.getByRole("radio", { name: /Automatique/i }));
    // La réponse renvoie le contact tel qu'il est désormais en base.
    fetchMock.mockResolvedValueOnce(reponseJson({ contact: contact("AUTO") }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText(/Réglages enregistrés/i)).toBeTruthy();
    expect(screen.queryByText(/Modifications non enregistrées/i)).toBeNull();
  });

  it("continue de prévenir quand l'enregistrement est refusé", async () => {
    // Le pire cas : croire son réglage appliqué alors qu'il a été refusé.
    fetchMock.mockResolvedValueOnce(reponseJson({ contact: contact("DRAFT") }));
    const { default: FicheContact } = await import("@/app/contacts/[id]/page");
    render(<FicheContact />);
    await screen.findByText("Sarah");

    await userEvent.click(screen.getByRole("radio", { name: /Automatique/i }));
    fetchMock.mockResolvedValueOnce(reponseJson({ erreur: "Contact introuvable." }, 400));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer" }));

    expect(await screen.findByText("Contact introuvable.")).toBeTruthy();
    expect(screen.getByText(/Modifications non enregistrées/i)).toBeTruthy();
  });
});
