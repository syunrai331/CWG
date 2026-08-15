import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
import {
  assertWorldState,
  parseLevelDat,
  snapshotWorldState,
  writeLevelDat,
} from "../app/lib/bedrock-nbt";
import {
  MAX_SIGNED_64,
  MIN_SIGNED_64,
  generateWorldFromTemplate,
  parseSeed,
  randomSigned64Seed,
  type TemplateManifest,
  validateTemplate,
} from "../app/lib/world-generator";

const require = createRequire(import.meta.url);
const { LevelDB } = require("leveldb-zlib");
const nbt = require("prismarine-nbt");

const root = path.resolve(import.meta.dirname, "..");
const templatePath = path.join(root, "public", "template.mcworld");
const manifestPath = path.join(root, "public", "template-manifest.json");

async function loadTemplate() {
  const [templateBuffer, manifestBuffer] = await Promise.all([
    readFile(templatePath),
    readFile(manifestPath),
  ]);
  return {
    bytes: new Uint8Array(templateBuffer),
    manifest: JSON.parse(manifestBuffer.toString("utf8")) as TemplateManifest,
  };
}

test("template ZIP and level.dat match the fixed Survival contract", async () => {
  const { bytes, manifest } = await loadTemplate();
  const files = unzipSync(bytes);
  assert.deepEqual(
    Object.keys(files).filter((name) => !name.includes("/")).sort(),
    ["level.dat", "level.dat_old", "levelname.txt"],
  );
  await validateTemplate(files, manifest);

  const state = assertWorldState(parseLevelDat(files["level.dat"]));
  assert.equal(state.worldName, "MCWorld MVP Template");
  assert.equal(state.difficulty, 2);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.placement.strategy, "end-bootstrap-structure");
  assert.equal(manifest.placement.command, "gamemode c @p");
  assert.equal(manifest.placement.button, "minecraft:stone_button");
  assert.deepEqual(manifest.placement.playerOffset, { x: 2, y: 0, z: 0 });
  assert.equal(Object.keys(files).some((name) => name.startsWith("behavior_packs/")), false);

  const roundTrip = writeLevelDat(parseLevelDat(files["level.dat"]));
  assert.deepEqual(snapshotWorldState(parseLevelDat(roundTrip)), state);
});

test("generator preserves signed 64-bit seeds and rewrites requested settings", async () => {
  const { bytes, manifest } = await loadTemplate();
  const result = await generateWorldFromTemplate(bytes, manifest, {
    worldName: "MVP 実機テスト",
    seed: MIN_SIGNED_64,
    difficulty: 3,
  });
  const files = unzipSync(result.archive);
  const state = assertWorldState(parseLevelDat(files["level.dat"]), {
    worldName: "MVP 実機テスト",
    seed: MIN_SIGNED_64,
    difficulty: 3,
  });
  assert.equal(state.seed, -9223372036854775808n);
  assert.equal(new TextDecoder().decode(files["levelname.txt"]), "MVP 実機テスト");
  assert.equal(result.fileName, "MVP 実機テスト.mcworld");

  const oldState = snapshotWorldState(parseLevelDat(files["level.dat_old"]));
  assert.equal(oldState.worldName, state.worldName);
  assert.equal(oldState.seed, state.seed);
  assert.equal(oldState.difficulty, state.difficulty);
});

test("seed parsing never routes through Number", () => {
  assert.equal(parseSeed(MIN_SIGNED_64.toString()), MIN_SIGNED_64);
  assert.equal(parseSeed(MAX_SIGNED_64.toString()), MAX_SIGNED_64);
  assert.throws(() => parseSeed("9223372036854775808"), /between/);
  assert.throws(() => parseSeed("1.5"), /signed 64-bit/);
  for (let index = 0; index < 128; index += 1) {
    const seed = randomSigned64Seed();
    assert.ok(seed >= MIN_SIGNED_64 && seed <= MAX_SIGNED_64);
  }
});

test("template uses an End bootstrap and contains no generated Overworld chunk", async () => {
  const { bytes, manifest } = await loadTemplate();
  const files = unzipSync(bytes);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mcworld-mvp-"));
  const dbPath = path.join(temporaryRoot, "db");
  await mkdir(dbPath, { recursive: true });

  for (const [filePath, contents] of Object.entries(files)) {
    if (!filePath.startsWith("db/")) continue;
    await writeFile(path.join(temporaryRoot, ...filePath.split("/")), contents);
    const expected = manifest.dbFiles[filePath];
    assert.ok(expected, `manifest entry for ${filePath}`);
    assert.equal(contents.byteLength, expected.size);
    assert.equal(createHash("sha256").update(contents).digest("hex"), expected.sha256);
  }

  const db = new LevelDB(dbPath, { createIfMissing: false });
  const commandBlocks: Array<Record<string, unknown>> = [];
  const chunks = new Set<string>();
  let spawnStructure: Record<string, unknown> | undefined;
  let tickingAreaCount = 0;
  await db.open();
  try {
    const iterator = db.getIterator({ keyAsBuffer: true, valueAsBuffer: true });
    for await (const [key, value] of iterator) {
      const tagOffset = key.length >= 13 ? 12 : 8;
      if (
        (key.length === 9 || key.length === 10 || key.length === 13 || key.length === 14) &&
        key[tagOffset] >= 0x2b &&
        key[tagOffset] <= 0x41
      ) {
        const dimension = key.length >= 13 ? key.readInt32LE(8) : 0;
        chunks.add(`${dimension}:${key.readInt32LE(0)},${key.readInt32LE(4)}`);
      }
      const textKey = key.toString("utf8");
      if (textKey.startsWith("tickingarea_")) tickingAreaCount += 1;
      if (textKey === "structuretemplate_mvp:creative_switch") {
        spawnStructure = nbt.simplify(nbt.parseUncompressed(value, "little")) as Record<string, unknown>;
      }
      if (key.length !== 13 || key.readInt32LE(8) !== 2 || key[12] !== 0x31) continue;
      let offset = 0;
      while (offset < value.length) {
        const parsed = nbt.protos.little.parsePacketBuffer("nbt", value, offset);
        const simple = nbt.simplify(parsed.data) as Record<string, unknown>;
        if (simple.id === "CommandBlock") commandBlocks.push(simple);
        offset += parsed.metadata.size;
      }
    }
  } finally {
    await db.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  assert.deepEqual([...chunks], ["2:32,32"]);
  assert.equal(chunks.has("0:6250,6250"), false);
  assert.equal(chunks.has("2:6250,6250"), false);
  assert.equal(tickingAreaCount, 1);
  commandBlocks.sort((left, right) => Number(left.x) - Number(right.x));
  assert.deepEqual(
    commandBlocks.map((block) => ({
      x: block.x,
      y: block.y,
      z: block.z,
      command: block.Command,
      auto: block.auto,
    })),
    [
      {
        x: 512,
        y: 250,
        z: 512,
        command: "execute as @a at @s if block ~2 ~ ~ air if block ~2 ~1 ~ air run structure load mvp:creative_switch ~2 ~ ~",
        auto: 1,
      },
      { x: 513, y: 250, z: 512, command: "tickingarea remove mvp_bootstrap", auto: 1 },
      { x: 514, y: 250, z: 512, command: "fill 512 250 512 514 250 512 air", auto: 1 },
    ],
  );

  assert.ok(spawnStructure);
  const structure = spawnStructure as {
    size: number[];
    structure: {
      palette: { default: {
        block_palette: Array<{ name: string; states: Record<string, number> }>;
        block_position_data: Record<string, { block_entity_data: Record<string, unknown> }>;
      } };
    };
  };
  assert.deepEqual(structure.size, [1, 2, 1]);
  assert.equal(structure.structure.palette.default.block_palette[0].name, "minecraft:command_block");
  assert.equal(structure.structure.palette.default.block_palette[1].name, "minecraft:stone_button");
  assert.equal(structure.structure.palette.default.block_palette[1].states.facing_direction, 1);
  const placedCommand = structure.structure.palette.default.block_position_data["0"].block_entity_data;
  assert.equal(placedCommand.Command, "gamemode c @p");
  assert.equal(placedCommand.auto, 0);
  assert.equal(placedCommand.id, "CommandBlock");
  assert.notEqual(placedCommand.x, 100000);
  assert.notEqual(placedCommand.z, 100000);
});
