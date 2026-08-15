"use client";

import { useState, type FormEvent } from "react";
import type { DifficultyValue } from "../lib/bedrock-nbt";
import {
  generateWorldFromTemplate,
  loadBundledTemplate,
  parseSeed,
  randomSigned64Seed,
  saveGeneratedWorld,
} from "../lib/world-generator";

const difficulties: Array<{ label: string; value: DifficultyValue }> = [
  { label: "Peaceful", value: 0 },
  { label: "Easy", value: 1 },
  { label: "Normal", value: 2 },
  { label: "Hard", value: 3 },
];

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "success"; fileName: string }
  | { kind: "error"; message: string };

export function WorldGenerator() {
  const [worldName, setWorldName] = useState("My Survival World");
  const [seedText, setSeedText] = useState("");
  const [difficulty, setDifficulty] = useState<DifficultyValue>(2);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const randomize = () => {
    setSeedText(randomSigned64Seed().toString());
    setStatus({ kind: "idle" });
  };

  const generate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const seed = parseSeed(seedText);
      if (!seedText.trim()) setSeedText(seed.toString());
      setStatus({ kind: "working", message: "Generating world…" });
      const template = await loadBundledTemplate();
      const world = await generateWorldFromTemplate(template.bytes, template.manifest, {
        worldName,
        seed,
        difficulty,
      });
      saveGeneratedWorld(world);
      setStatus({ kind: "success", fileName: world.fileName });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "World generation failed.",
      });
    }
  };

  return (
    <main className="page-shell">
      <section className="generator-card" aria-labelledby="page-title">
        <h1 id="page-title">Minecraft Bedrock World Generator</h1>

        <form onSubmit={generate}>
          <label htmlFor="world-name">World Name</label>
          <input
            id="world-name"
            name="worldName"
            value={worldName}
            onChange={(event) => setWorldName(event.target.value)}
            autoComplete="off"
            maxLength={120}
            required
          />

          <label htmlFor="seed">Seed</label>
          <div className="seed-row">
            <input
              id="seed"
              name="seed"
              value={seedText}
              onChange={(event) => setSeedText(event.target.value)}
              placeholder="Blank = random"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
            />
            <button className="secondary-button" type="button" onClick={randomize}>
              Random
            </button>
          </div>

          <label htmlFor="difficulty">Difficulty</label>
          <select
            id="difficulty"
            name="difficulty"
            value={difficulty}
            onChange={(event) => setDifficulty(Number(event.target.value) as DifficultyValue)}
          >
            {difficulties.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>

          <button className="primary-button" type="submit" disabled={status.kind === "working"}>
            {status.kind === "working" ? "Generating…" : "Generate World"}
          </button>

          {status.kind !== "idle" && (
            <p className={`status status-${status.kind}`} role="status" aria-live="polite">
              {status.kind === "success" ? `${status.fileName} is ready.` : status.message}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}
