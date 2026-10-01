import type { Metadata } from "next";
import "./globals.css";
import "../src/admin.css";

export const metadata: Metadata = {
  title: "News Intelligenz · Local inspection",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
