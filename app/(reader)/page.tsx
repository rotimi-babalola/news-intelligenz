import type { Metadata } from "next";
import { Landing } from "./_components/landing";

export const metadata: Metadata = {
  title: "Klarantwort",
  description:
    "Ask about German parliamentary activity in German or English. Every answer cites the official DIP record.",
};

export default function Home() {
  return <Landing />;
}
