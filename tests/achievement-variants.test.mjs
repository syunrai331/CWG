import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(root, "outputs", "achievement-26.44-diagnostics");

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(outputRoot, fileName), "utf8"));
}

test("rebuilds and re-audits the 26.44 diagnostic variants", async () => {
  const matrix = await readJson("variant-matrix.json");
  const levelDbDiff = await readJson("leveldb-diff.json");
  const levelDatDiff = await readJson("level-dat-diff.json");

  assert.match(matrix.warning, /not a native 1\.26\.44 baseline/);
  assert.equal(matrix.baselineAchievementPrerequisites.lastOpenedWithVersion, "1.26.33.2.0");
  assert.equal(matrix.sourceAchievementPrerequisites.lastOpenedWithVersion, "1.26.33.2.0");

  const variants = Object.fromEntries(matrix.variants.map((variant) => [variant.id, variant]));
  assert.deepEqual(Object.keys(variants), ["A", "B", "S", "C", "D", "E", "P"]);
  for (const variant of matrix.variants) {
    await stat(path.join(outputRoot, variant.fileName));
    const audit = await readJson(path.join("audits", `${variant.id}.json`));
    const prerequisites = audit.level["level.dat"].achievementPrerequisites;
    assert.equal(prerequisites.GameType, 0);
    assert.equal(prerequisites.cheatsEnabled, 0);
    assert.equal(prerequisites.commandsEnabled, 0);
    assert.equal(prerequisites.hasBeenLoadedInCreative, 0);
    for (const record of audit.levelDb.keys) {
      assert.notDeepEqual(record.chunk && [record.chunk.dimension, record.chunk.x, record.chunk.z], [0, 6250, 6250]);
      assert.notDeepEqual(record.chunk && [record.chunk.dimension, record.chunk.x, record.chunk.z], [2, 6250, 6250]);
    }
  }

  assert.equal(variants.A.commandblocksenabled, 0);
  assert.equal(variants.B.commandblocksenabled, 1);
  assert.deepEqual(variants.A.levelDbCategories, { "baseline-global": 5 });
  assert.deepEqual(variants.B.levelDbCategories, { "baseline-global": 5 });
  assert.deepEqual(variants.S.levelDbCategories, { "baseline-global": 5, "saved-structure": 1 });
  assert.equal(variants.C.levelDbCategories.chunk, 8);
  assert.equal(variants.C.levelDbCategories["chunk-support"], 5);
  assert.equal(variants.C.levelDbCategories["ticking-area"], undefined);
  assert.equal(variants.C.levelDbCategories["saved-structure"], undefined);
  assert.equal(variants.D.levelDbCategories["ticking-area"], 1);
  assert.equal(variants.D.levelDbCategories["saved-structure"], undefined);
  assert.equal(variants.E.levelDbCategories["ticking-area"], 1);
  assert.equal(variants.E.levelDbCategories["saved-structure"], 1);

  assert.equal(levelDbDiff.B.added.length, 0);
  assert.equal(levelDbDiff.S.added.filter((entry) => entry.category === "saved-structure").length, 1);
  assert.equal(levelDbDiff.D.added.filter((entry) => entry.category === "ticking-area").length, 1);
  assert.equal(levelDatDiff.B.some((entry) => entry.path === "$.commandblocksenabled"), true);
  assert.equal(levelDatDiff.E.some((entry) => entry.path.startsWith("$.abilities")), false);
  assert.equal(levelDatDiff.P.some((entry) => entry.path === "$.abilities.op"), true);
  assert.equal(levelDatDiff.P.some((entry) => entry.path === "$.abilities.teleport"), true);
  assert.equal(levelDatDiff.P.some((entry) => entry.path === "$.playerPermissionsLevel"), true);

  const structureAudit = await readJson(path.join("audits", "S.json"));
  const structureRecord = structureAudit.levelDb.keys.find((entry) => entry.category === "saved-structure");
  const palette = structureRecord.nbt.structure.palette.default;
  assert.equal(palette.block_palette[0].name, "minecraft:command_block");
  assert.equal(palette.block_palette[1].name, "minecraft:stone_button");
  assert.equal(palette.block_position_data["0"].block_entity_data.Command, "gamemode c @p");

  const commandAudit = await readJson(path.join("audits", "C.json"));
  const commands = commandAudit.levelDb.keys
    .flatMap((entry) => entry.blockEntities ?? [])
    .filter((entry) => entry.id === "CommandBlock")
    .map((entry) => entry.Command)
    .sort();
  assert.deepEqual(commands, [
    "execute as @a at @s if block ~2 ~ ~ air if block ~2 ~1 ~ air run structure load mvp:creative_switch ~2 ~ ~",
    "fill 512 250 512 514 250 512 air",
    "tickingarea remove mvp_bootstrap",
  ].sort());

  const tickingAudit = await readJson(path.join("audits", "D.json"));
  const tickingRecord = tickingAudit.levelDb.keys.find((entry) => entry.category === "ticking-area");
  assert.equal(tickingRecord.nbt.Name, "mvp_bootstrap");
  assert.equal(tickingRecord.nbt.Dimension, 2);
});
