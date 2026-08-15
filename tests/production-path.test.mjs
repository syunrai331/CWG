import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const pathRoot = path.join(root, "outputs", "achievement-26.44-production-path");
const reportRoot = path.join(root, "outputs", "achievement-26.44-production-reports");

const noLogicalDifference = (comparison) => (
  comparison.level["level.dat"].length === 0 &&
  comparison.level["level.dat_old"].length === 0 &&
  comparison.levelDb.added.length === 0 &&
  comparison.levelDb.removed.length === 0 &&
  comparison.levelDb.changed.length === 0
);

test("isolates F0-F5 and proves the production generator changes only name, difficulty, and seed", async () => {
  const matrix = JSON.parse(await readFile(path.join(pathRoot, "path-matrix.json"), "utf8"));
  const report = JSON.parse(await readFile(path.join(reportRoot, "complete-diff.json"), "utf8"));
  const variants = Object.fromEntries(matrix.variants.map((variant) => [variant.id, variant]));

  assert.deepEqual(Object.keys(variants), ["F0", "F1", "F2", "F3", "F4", "F5"]);
  for (const variant of matrix.variants) await stat(path.join(pathRoot, variant.fileName));
  await stat(path.join(pathRoot, "P-fixed-control.mcworld"));
  await stat(path.join(pathRoot, "P-fixed-generator.mcworld"));

  assert.equal(variants.F3.sha256, variants.F4.sha256);
  assert.equal(variants.F4.sha256, variants.F5.sha256);
  assert.equal(noLogicalDifference(report.sequentialProductionPath.F3toF4), true);
  assert.equal(noLogicalDifference(report.sequentialProductionPath.F4toF5), true);
  assert.equal(noLogicalDifference(report.fixedControlVsGenerator), true);

  assert.deepEqual(
    report.sequentialProductionPath.F0toF1.level["level.dat"].map((entry) => entry.path),
    ["$.LevelName"],
  );
  assert.deepEqual(
    report.sequentialProductionPath.F1toF2.level["level.dat"].map((entry) => entry.path),
    ["$.Difficulty"],
  );
  assert.deepEqual(
    report.sequentialProductionPath.F2toF3.level["level.dat"].map((entry) => entry.path),
    ["$.RandomSeed"],
  );

  const eVsPPaths = report.eVsPreFixP.level["level.dat"].map((entry) => entry.path);
  assert.ok(eVsPPaths.includes("$.abilities.op"));
  assert.ok(eVsPPaths.includes("$.abilities.teleport"));
  assert.ok(eVsPPaths.includes("$.playerPermissionsLevel"));
  for (const pathName of [
    "$.isFromLockedTemplate",
    "$.isFromWorldTemplate",
    "$.isSingleUseWorld",
    "$.isWorldTemplateOptionLocked",
    "$.cheatsEnabled",
    "$.commandsEnabled",
    "$.hasBeenLoadedInCreative",
    "$.commandblocksenabled",
  ]) {
    assert.equal(eVsPPaths.includes(pathName), false, `${pathName} must be identical in E and P`);
  }
  assert.deepEqual(
    report.eVsPreFixP.levelDb.changed.map((entry) => entry.before.keyText),
    ["WorldClocks"],
  );

  const auditPath = path.join(reportRoot, "audits", "fixedGenerator.json");
  const generatedAudit = JSON.parse(await readFile(auditPath, "utf8"));
  assert.equal(Object.keys(generatedAudit.archive.jsonMetadata).length, 0);
  assert.equal(
    generatedAudit.archive.files.some((entry) => (
      entry.filePath.startsWith("behavior_packs/") || entry.filePath === "world_behavior_packs.json"
    )),
    false,
  );
  assert.equal(generatedAudit.levelDb.categories["saved-structure"], 1);
  assert.equal(generatedAudit.levelDb.categories["ticking-area"], 1);
  assert.equal(generatedAudit.levelDb.categories.chunk, 8);
});
