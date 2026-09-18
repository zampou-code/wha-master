import type { ReactNode } from "react";
import { Bricolage_Grotesque } from "next/font/google";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

export const metadata = {
  title: "Harness WhatsApp",
  description: "Poste de contrôle privé de la liaison WhatsApp.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" className={bricolage.variable}>
      <body>{children}</body>
    </html>
  );
}
