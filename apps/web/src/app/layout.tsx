import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import PostHogProvider from "./PostHogProvider";
import { Toaster } from "@/components/ui/sonner";
import localFont from "next/font/local";
import { Space_Mono, IBM_Plex_Mono } from 'next/font/google'
import "./globals.css";
import '../styles/tokens.css'

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

const fontUi = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-ui',
})

const fontData = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-data',
})

export const metadata: Metadata = {
  title: "anvx",
  description: "Token Economy Intelligence",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${fontUi.variable} ${fontData.variable}`}>
        <body
          className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        >
          <PostHogProvider>{children}</PostHogProvider>
          {/* Mounted at the root so toasts work in (dashboard), (onboarding),
              and (marketing) without mounting one Toaster per layout. Style
              overrides match the retro-Mac tokens (parchment background,
              Space Mono UI font, accent border). */}
          <Toaster
            position="top-right"
            richColors
            closeButton
            toastOptions={{
              style: {
                fontFamily: 'var(--font-ui)',
                fontSize: '12px',
                background: 'var(--anvx-win, #f5f3ed)',
                color: 'var(--anvx-text, #1a1a1a)',
                border: '1px solid var(--anvx-bdr, #8e8a7e)',
                borderRadius: '2px',
              },
            }}
          />
        </body>
      </html>
    </ClerkProvider>
  );
}
