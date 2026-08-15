import type { Metadata } from "next";
import { WorldGenerator } from "./components/WorldGenerator";

export const metadata: Metadata = {
  title: "Minecraft Bedrock World Generator",
  description: "Generate a minimal Minecraft Bedrock .mcworld locally in your browser.",
};

export default function Home() {
  return <WorldGenerator />;
}
