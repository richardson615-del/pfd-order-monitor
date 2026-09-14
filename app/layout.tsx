import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";

/**
 * The brand face, and only the brand face.
 *
 * Body text stays on the system stack: it is already installed, it renders
 * instantly on a cheap tablet over a restaurant's wifi, and nobody reads an
 * order faster because of a typeface. This is loaded for the wordmark, the
 * headings, the waiting count and the order numbers - the things somebody
 * reads across a room.
 *
 * Plus Jakarta Sans of the three candidates: its P has the closed, circular
 * bowl the mark needs at 512px, and its m stays open at 40px where Outfit's
 * closes up.
 */
const brand = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-brand",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Premium Orders",
  description: "Live order alerts for Premium restaurant partners",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Premium",
  },
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0d10",
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
    <html lang="en" className={brand.variable}>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
