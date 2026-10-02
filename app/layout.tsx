import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

/**
 * The CRM's two faces (Nick, 2026-10-02: the tablet gets the CRM look).
 *
 * Geist for body text, Sora for headings, counts, order numbers and the
 * wordmark - the things somebody reads across a room. Same pair as
 * prs-crm src/app/layout.tsx.
 *
 * Geist is self-hosted (app/fonts, OFL - licence beside it) rather than
 * loaded from next/font/google: Next 14.2's Google font list predates it,
 * and the `geist` npm package would mean a package change in a clone whose
 * node_modules the lanes share. Both are subset and served from our own
 * origin by next/font, so a cheap tablet on restaurant wifi never waits on
 * a third-party font host.
 *
 * --font-brand is kept as an alias of --font-heading (globals.css) so the
 * mark and every existing rule keep working.
 */
const sans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
});

const heading = Sora({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-heading",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Premium Orders",
  description: "Live order alerts for Premium restaurant partners",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Premium",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#f6f7fa",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${heading.variable}`}>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
