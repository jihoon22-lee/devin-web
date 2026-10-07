import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { THEME_BOOT } from "@/lib/client/theme";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "devin-web",
  description: "Web UI for Devin CLI",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "devin-web" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#090b11",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is set by THEME_BOOT before paint — React must not warn
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className={`h-full overflow-hidden antialiased ${sans.variable} ${mono.variable}`}>
        {children}
      </body>
    </html>
  );
}
