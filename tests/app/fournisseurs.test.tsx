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

  it("offre les quatre rôles, qui sont tous appelés", async () => {
    // « Profiler » et « Résumer » ont été absents de cette page le temps qu'ils
    // ne servent à rien : un réglage sans effet est pire qu'un réglage absent.
    // Ils sont revenus avec le code qui les appelle.
    fetchMock.mockResolvedValue(reponseJson(reglages({ classify: [], compose: [] })));
    await monter();

    for (const titre of ["Classer", "Rédiger", "Résumer", "Profiler"]) {
      expect(screen.getByText(titre), titre).toBeTruthy();
    }
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
