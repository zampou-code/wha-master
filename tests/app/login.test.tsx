// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const email = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  signIn: { email },
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("page de connexion", () => {
  beforeEach(() => {
    email.mockReset();
    push.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("réactive le bouton et affiche un message réseau distinct quand signIn.email rejette", async () => {
    email.mockRejectedValueOnce(new Error("échec réseau"));
    const utilisateur = userEvent.setup();

    const { default: Connexion } = await import("@/app/login/page");
    render(<Connexion />);

    await utilisateur.type(screen.getByLabelText("Adresse e-mail"), "proprietaire@example.com");
    await utilisateur.type(screen.getByLabelText("Mot de passe"), "motdepassetressolide");

    const bouton = screen.getByRole("button", { name: /se connecter/i }) as HTMLButtonElement;
    await utilisateur.click(bouton);

    await waitFor(() => {
      expect(bouton.disabled).toBe(false);
    });

    const alerte = screen.getByRole("alert");
    expect(alerte.textContent).toBe("Problème de connexion réseau. Réessayez.");
    expect(push).not.toHaveBeenCalled();
  });

  it("affiche un message distinct quand les identifiants sont refusés", async () => {
    email.mockResolvedValueOnce({ error: { message: "invalid" } });
    const utilisateur = userEvent.setup();

    const { default: Connexion } = await import("@/app/login/page");
    render(<Connexion />);

    await utilisateur.type(screen.getByLabelText("Adresse e-mail"), "proprietaire@example.com");
    await utilisateur.type(screen.getByLabelText("Mot de passe"), "mauvais-mot-de-passe");

    const bouton = screen.getByRole("button", { name: /se connecter/i }) as HTMLButtonElement;
    await utilisateur.click(bouton);

    await waitFor(() => {
      expect(bouton.disabled).toBe(false);
    });

    const alerte = screen.getByRole("alert");
    expect(alerte.textContent).toBe("Identifiants incorrects.");
  });
});
