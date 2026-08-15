import { strToU8, unzipSync, zipSync } from "fflate";
import {
  applyWorldSettings,
  assertAchievementPrerequisites,
  parseLevelDat,
  type DifficultyValue,
  type WorldStateSnapshot,
} from "./bedrock-nbt";

export const MIN_SIGNED_64 = -(1n << 63n);
export const MAX_SIGNED_64 = (1n << 63n) - 1n;

export type TemplateManifest = {
  schemaVersion: 3;
  templateBedrockVersion: string;
  minimumCompatibleVersion: string;
  compatibility: {
    targetBedrockVersion: "1.26.44";
    achievementVerification: "pending-client-verification" | "verified";
    minecraftClientVerified: boolean;
    verifiedClientVersion?: string;
    verifiedVariant?: string;
    verifiedResult?: string;
    verificationDate?: string;
    note: string;
  };
  placement: {
    strategy: "end-bootstrap-structure";
    structureId: "mvp:creative_switch";
    command: "gamemode c @p";
    button: "minecraft:stone_button";
    playerOffset: { x: number; y: number; z: number };
    requiresAir: Array<{ x: number; y: number; z: number }>;
    bootstrap: {
      dimension: 2;
      x: number;
      y: number;
      z: number;
      chunkX: number;
      chunkZ: number;
      commandBlocks: number;
    };
  };
  dbFiles: Record<string, { size: number; sha256: string }>;
};

export type GenerateWorldOptions = {
  worldName: string;
  seed: bigint;
  difficulty: DifficultyValue;
};

export type GeneratedWorld = {
  archive: Uint8Array;
  fileName: string;
  state: WorldStateSnapshot;
};

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array) {
  const input = new Uint8Array(bytes);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

function validateArchivePaths(files: Record<string, Uint8Array>) {
  const paths = Object.keys(files);
  if (paths.length === 0) throw new Error("Template archive is empty.");
  for (const filePath of paths) {
    const segments = filePath.replaceAll("\\", "/").split("/");
    if (filePath.startsWith("/") || segments.includes("..")) {
      throw new Error(`Template contains an unsafe path: ${filePath}`);
    }
  }
}

export function parseSeed(seedText: string) {
  const normalized = seedText.trim();
  if (!normalized) return randomSigned64Seed();
  if (!/^[+-]?\d+$/.test(normalized)) throw new Error("Seed must be a signed 64-bit integer.");
  const seed = BigInt(normalized);
  if (seed < MIN_SIGNED_64 || seed > MAX_SIGNED_64) {
    throw new Error("Seed must be between −9,223,372,036,854,775,808 and 9,223,372,036,854,775,807.");
  }
  return seed;
}

export function randomSigned64Seed() {
  const parts = new Uint32Array(2);
  crypto.getRandomValues(parts);
  const unsigned = (BigInt(parts[0]) << 32n) | BigInt(parts[1]);
  return BigInt.asIntN(64, unsigned);
}

export function safeWorldFileName(worldName: string) {
  const withoutControls = Array.from(worldName.trim(), (character) =>
    character.charCodeAt(0) < 32 ? "_" : character,
  ).join("");
  const cleaned = withoutControls
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return `${cleaned || "Minecraft World"}.mcworld`;
}

export async function validateTemplate(
  files: Record<string, Uint8Array>,
  manifest: TemplateManifest,
) {
  if (manifest.schemaVersion !== 3) throw new Error("Unsupported template manifest version.");
  if (
    manifest.compatibility.targetBedrockVersion !== "1.26.44" ||
    manifest.compatibility.achievementVerification === "verified" &&
      (
        !manifest.compatibility.minecraftClientVerified ||
        manifest.compatibility.verifiedClientVersion !== "1.26.44" ||
        manifest.compatibility.verifiedResult !== "achievement-enabled-in-world-settings"
      )
  ) {
    throw new Error("Template compatibility metadata is inconsistent.");
  }
  if (
    manifest.placement.strategy !== "end-bootstrap-structure" ||
    manifest.placement.structureId !== "mvp:creative_switch" ||
    manifest.placement.command !== "gamemode c @p" ||
    manifest.placement.button !== "minecraft:stone_button" ||
    manifest.placement.playerOffset.x !== 2 ||
    manifest.placement.playerOffset.y !== 0 ||
    manifest.placement.playerOffset.z !== 0 ||
    manifest.placement.bootstrap.dimension !== 2 ||
    manifest.placement.bootstrap.x !== 512 ||
    manifest.placement.bootstrap.y !== 250 ||
    manifest.placement.bootstrap.z !== 512 ||
    manifest.placement.bootstrap.chunkX !== 32 ||
    manifest.placement.bootstrap.chunkZ !== 32 ||
    manifest.placement.bootstrap.commandBlocks !== 3
  ) {
    throw new Error("Template spawn placement does not match the MVP contract.");
  }

  validateArchivePaths(files);
  if (
    Object.keys(files).some(
      (filePath) => filePath.startsWith("behavior_packs/") || filePath === "world_behavior_packs.json",
    )
  ) {
    throw new Error("Template must not contain a behavior pack.");
  }
  for (const requiredPath of ["level.dat", "level.dat_old", "levelname.txt", "db/CURRENT"]) {
    if (!files[requiredPath]) throw new Error(`Template is missing ${requiredPath}.`);
  }
  assertAchievementPrerequisites(parseLevelDat(files["level.dat"]));

  for (const [filePath, expected] of Object.entries(manifest.dbFiles)) {
    const bytes = files[filePath];
    if (!bytes || bytes.byteLength !== expected.size) throw new Error(`Template DB file mismatch: ${filePath}.`);
    if ((await sha256(bytes)) !== expected.sha256) throw new Error(`Template DB integrity check failed: ${filePath}.`);
  }
}

export async function generateWorldFromTemplate(
  templateBytes: Uint8Array,
  manifest: TemplateManifest,
  options: GenerateWorldOptions,
): Promise<GeneratedWorld> {
  const worldName = options.worldName.trim();
  if (!worldName) throw new Error("World Name is required.");
  if (new TextEncoder().encode(worldName).byteLength > 255) throw new Error("World Name is too long.");

  const files = unzipSync(templateBytes);
  await validateTemplate(files, manifest);

  files["level.dat"] = applyWorldSettings(files["level.dat"], { ...options, worldName });
  files["level.dat_old"] = applyWorldSettings(files["level.dat_old"], { ...options, worldName });
  files["levelname.txt"] = strToU8(worldName);

  const state = assertAchievementPrerequisites(parseLevelDat(files["level.dat"]), { ...options, worldName });
  return {
    archive: zipSync(files, { level: 9 }),
    fileName: safeWorldFileName(worldName),
    state,
  };
}

let templatePromise: Promise<{ bytes: Uint8Array; manifest: TemplateManifest }> | undefined;

function publicAssetUrl(fileName: string) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return `${basePath}/${fileName}`;
}

export function loadBundledTemplate() {
  templatePromise ??= Promise.all([
    fetch(publicAssetUrl("template.mcworld")).then(async (response) => {
      if (!response.ok) throw new Error("Could not load the bundled world template.");
      return new Uint8Array(await response.arrayBuffer());
    }),
    fetch(publicAssetUrl("template-manifest.json")).then(async (response) => {
      if (!response.ok) throw new Error("Could not load the template manifest.");
      return (await response.json()) as TemplateManifest;
    }),
  ]).then(([bytes, manifest]) => ({ bytes, manifest }));
  return templatePromise;
}

export function saveGeneratedWorld(world: GeneratedWorld) {
  const blob = new Blob([new Uint8Array(world.archive)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = world.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
