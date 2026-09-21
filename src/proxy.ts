import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

const CHEMINS_PUBLICS = ["/login", "/api/auth", "/api/health", "/api/webhook", "/api/taches"];

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (CHEMINS_PUBLICS.some((chemin) => pathname.startsWith(chemin))) {
    return NextResponse.next();
  }

  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
