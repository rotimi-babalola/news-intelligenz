import type { Metadata } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";
import "../src/admin.css";

export const metadata: Metadata = {
  title: "Klarantwort",
  description:
    "Ask about German parliamentary activity in German or English. Every answer cites the official DIP record.",
};

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${inter.variable} ${spaceGrotesk.variable} ${inter.className}`}
      >
        {children}
      </body>
    </html>
  );
}
