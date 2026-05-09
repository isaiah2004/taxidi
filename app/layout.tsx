import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { cn } from "@/lib/utils";

// In dev / test deploys we run with DISABLE_AUTH=true and intentionally omit
// Clerk keys; ClerkProvider would otherwise throw "Missing publishableKey"
// during server render. Skipping the provider in that mode lets us boot the
// app on a fresh Cloud Run revision without a Clerk app provisioned.
const DISABLE_AUTH = process.env.DISABLE_AUTH === "true";

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Taxidi — Plan trips together",
  description:
    "Collaborative trip planning with shared chat, an AI agent, and per-member variants the owner merges into a single plan.",
};

import { TooltipProvider } from "@/components/ui/tooltip";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", inter.variable)}
    >
      <body className="min-h-full flex flex-col">
        {DISABLE_AUTH ? (
          <TooltipProvider>{children}</TooltipProvider>
        ) : (
          <ClerkProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </ClerkProvider>
        )}
      </body>
    </html>
  );
}
