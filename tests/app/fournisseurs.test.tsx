// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const push = vi.fn();
const routerStub = { push };
vi.mock("next/navigation", () => ({
  useRouter: () => routerStub,
}));

const fetchMock = vi.fn();

function fournisseur(id: string, name: string, kind: string) {
  return { id, name, kind, baseUrl: null, enabled: true, cleMasquee: "sk-…42", lastError: null };
}

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function reglages(roles: Record<string, { providerId: string; model: string }[]>) {
  return {
    reglages: {
      fournisseurs: [fournisseur("p1", "Kimi", "KIMI"), fournisseur("p2", "Jev", "TYPESAFE")],
      roles,
    },
  };
}

/** Le corps JSON du dernier appel PUT, tel qu'il partirait vers l'API. */
function dernierPut(): { roles?: Record<string, unknown> } {
  const puts = fetchMock.mock.calls.filter((appel) => (appel[1] as RequestInit)?.method === "PUT");
  return JSON.parse(String((puts.at(-1)![1] as RequestInit).body));
}

async function monter() {
  const { default: Fournisseurs } = await import("@/app/fournisseurs/page");
  render(<Fournisseurs />);
  await screen.findByText("Qui fait quoi");
}

describe("page fournisseurs — rôles affichés", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    push.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("n'offre que les rôles que le moteur appelle vraiment", async () => {
    // « Profiler » et « Résumer » étaient réglables alors que rien ne les
    // appelle : le réglage se faisait, s'enregistrait, et ne changeait rien.
    fetchMock.mockResolvedValue(reponseJson(reglages({ classify: [], compose: [], summarize: [] })));
    await monter();

    expect(screen.getByText("Classer")).toBeTruthy();
    expect(screen.getByText("Rédiger")).toBeTruthy();
    // « Résumer » est revenu le jour où le résumé glissant a été écrit : le rôle
    // est appelé par la tâche de fond (src/redacteur/resume.ts).
    expect(screen.getByText("Résumer")).toBeTruthy();
    expect(screen.queryByText("Profiler")).toBeNull();
  });

  it("garde en base les affectations des rôles retirés", async () => {
    // La page envoie la carte entière des rôles : cacher un rôle sans y penser
    // aurait effacé son affectation au premier enregistrement.
    fetchMock.mockResolvedValue(
      reponseJson(
        reglages({
          classify: [{ providerId: "p2", model: "jev-latest" }],
          profile: [{ providerId: "p1", model: "kimi-k3" }],
        }),
      ),
    );
    await monter();

    await userEvent.click(screen.getByRole("button", { name: "Enregistrer les affectations" }));

    expect(dernierPut().roles).toEqual({
      classify: [{ providerId: "p2", model: "jev-latest" }],
      profile: [{ providerId: "p1", model: "kimi-k3" }],
    });
  });

  it("signale une affectation dormante et sait l'oublier", async () => {
    // Un réglage caché et impossible à effacer serait pire que l'afficher.
    fetchMock.mockResolvedValue(
      reponseJson(
        reglages({
          classify: [{ providerId: "p2", model: "jev-latest" }],
          profile: [{ providerId: "p1", model: "kimi-k3" }],
        }),
      ),
    );
    await monter();

    expect(screen.getByText(/Profiler/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Oublier ces affectations/ }));
    await userEvent.click(screen.getByRole("button", { name: "Enregistrer les affectations" }));

    expect(dernierPut().roles).toEqual({
      classify: [{ providerId: "p2", model: "jev-latest" }],
    });
  });

  it("ne dit rien quand aucun rôle dormant n'est affecté", async () => {
    fetchMock.mockResolvedValue(
      reponseJson(reglages({ classify: [{ providerId: "p2", model: "jev-latest" }] })),
    );
    await monter();

    expect(screen.queryByText(/Oublier ces affectations/)).toBeNull();
  });
});

describe("page fournisseurs — Jev", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    push.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("propose Jev dans les types de fournisseur", async () => {
    // Le classifieur sait l'appeler depuis le 2026-10-16, mais le formulaire ne
    // permettait pas de l'ajouter : la fonction était inaccessible.
    fetchMock.mockResolvedValue(reponseJson(reglages({ classify: [], compose: [], summarize: [] })));
    await monter();

    expect(screen.getByRole("option", { name: /Jev \(TypeSafe\)/ })).toBeTruthy();
  });

  it("refuse Jev sur un rôle qu'il ne sait pas tenir", async () => {
    // Jev ne génère pas de texte : l'affecter à « Rédiger » donnerait un
    // réglage d'apparence valide qui échouerait au premier message.
    fetchMock.mockResolvedValue(
      reponseJson(reglages({ compose: [{ providerId: "p2", model: "jev-latest" }] })),
    );
    await monter();

    expect(screen.getByRole("alert").textContent).toMatch(/ne sait pas tenir ce rôle/);
    // Aucun modèle n'est proposé pour ce rôle : seul le choix du fournisseur
    // reste, et « Jev » n'y figure que comme nom de fournisseur.
    const options = screen.getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((option) => option.value)).not.toContain("jev-latest");
  });

  it("propose Jev comme modèle sur le classement", async () => {
    fetchMock.mockResolvedValue(
      reponseJson(reglages({ classify: [{ providerId: "p2", model: "jev-latest" }] })),
    );
    await monter();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("option", { name: /Jev — recommandé/ })).toBeTruthy();
  });
});
