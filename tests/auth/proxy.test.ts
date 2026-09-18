import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const getSessionCookie = vi.fn();
vi.mock("better-auth/cookies", () => ({ getSessionCookie }));

function requete(chemin: string): NextRequest {
  return new NextRequest(new URL(chemin, "https://wha.example.com"));
}

describe("proxy d'authentification", () => {
  it("laisse passer les routes publiques sans session", async () => {
    getSessionCookie.mockReturnValue(null);
    const { proxy } = await import("@/proxy");
    for (const chemin of ["/login", "/api/auth/sign-in", "/api/health", "/api/webhook/gowa"]) {
      expect(proxy(requete(chemin)).status).toBe(200);
    }
  });

  it("redirige vers /login quand le cookie de session est absent", async () => {
    getSessionCookie.mockReturnValue(null);
    const { proxy } = await import("@/proxy");
    const response = proxy(requete("/connexion"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://wha.example.com/login");
  });

  it("laisse passer quand le cookie de session est présent", async () => {
    getSessionCookie.mockReturnValue("jeton");
    const { proxy } = await import("@/proxy");
    expect(proxy(requete("/connexion")).status).toBe(200);
  });
});
