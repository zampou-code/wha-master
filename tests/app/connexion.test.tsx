// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const toDataURL = vi.fn().mockResolvedValue("data:image/png;base64,xxx");
vi.mock("qrcode", () => ({
  default: { toDataURL },
}));

const fetchMock = vi.fn();

function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("page d'appairage WhatsApp (/connexion)", () => {
  beforeEach(() => {
    push.mockReset();
    toDataURL.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    // L'ordre compte : démonter d'abord (ce qui coupe l'intervalle de sondage
    // via son nettoyage d'effet) pendant que fetch est encore simulé, sinon un
    // cycle en cours peut retomber sur le vrai fetch une fois le stub retiré.
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ne redemande le QR qu'une seule fois pendant plusieurs cycles de sondage à l'état non apparié", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ isConnected: true, isLoggedIn: false }));
      }
      if (url.includes("/api/whatsapp/qr")) {
        return Promise.resolve(reponseJson({ code: "2@abc", durationSec: 30 }));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    // Laisse le montage initial se dérouler (premier appel status + premier appel QR).
    await vi.advanceTimersByTimeAsync(0);
    // Simule plusieurs cycles de sondage (3 s chacun) : le statut reste non apparié.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);

    const appelsStatut = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/api/whatsapp/status"),
    );
    const appelsQr = fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/whatsapp/qr"));

    expect(appelsStatut.length).toBeGreaterThan(1);
    expect(appelsQr).toHaveLength(1);
  });

  it("redirige vers /login sans afficher le message GOWA quand le statut renvoie 401", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ erreur: "Non authentifié" }, 401));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith("/login");
    });

    expect(screen.queryByText("WhatsApp est injoignable.")).toBeNull();
  });

  it("redirige vers /login sans afficher le message GOWA quand le QR renvoie 401", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/whatsapp/status")) {
        return Promise.resolve(reponseJson({ isConnected: true, isLoggedIn: false }));
      }
      if (url.includes("/api/whatsapp/qr")) {
        return Promise.resolve(reponseJson({ erreur: "Non authentifié" }, 401));
      }
      throw new Error(`URL inattendue: ${url}`);
    });

    const { default: Appairage } = await import("@/app/connexion/page");
    render(<Appairage />);

    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith("/login");
    });

    expect(screen.queryByText("Impossible d'obtenir le QR code.")).toBeNull();
  });
});
