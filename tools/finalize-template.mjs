import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { strToU8, zipSync } from "fflate";

const require = createRequire(import.meta.url);
const { LevelDB } = require("leveldb-zlib");
const nbt = require("prismarine-nbt");

const COMMAND = "gamemode c @p";
const STRUCTURE_ID = "mvp:creative_switch";
const BOOTSTRAP = Object.freeze({
  dimension: 2,
  x: 512,
  y: 250,
  z: 512,
  chunkX: 32,
  chunkZ: 32,
  commandBlocks: 3,
});
const BOOTSTRAP_COMMANDS = new Map([
  [512, `execute as @a at @s if block ~2 ~ ~ air if block ~2 ~1 ~ air run structure load ${STRUCTURE_ID} ~2 ~ ~`],
  [513, "tickingarea remove mvp_bootstrap"],
  [514, "fill 512 250 512 514 250 512 air"],
]);

function setTag(compound, name, expectedType, value) {
  const tag = compound[name];
  if (!tag || tag.type !== expectedType) {
    throw new Error(`${name} must be an existing ${expectedType} tag`);
  }
  tag.value = value;
}

function patchLevelDat(filePath, worldName) {
  const bytes = fs.readFileSync(filePath);
  const version = bytes.readUInt32LE(0);
  const payloadLength = bytes.readUInt32LE(4);
  if (payloadLength !== bytes.length - 8) throw new Error(`Invalid level.dat payload length in ${filePath}`);

  const root = nbt.parseUncompressed(bytes.subarray(8), "little");
  const compound = root.value;
  setTag(compound, "LevelName", "string", worldName);
  setTag(compound, "BiomeOverride", "string", "minecraft:");
  setTag(compound, "GameType", "int", 0);
  setTag(compound, "ForceGameType", "byte", 0);
  setTag(compound, "Difficulty", "int", 2);
  setTag(compound, "IsHardcore", "byte", 0);
  setTag(compound, "cheatsEnabled", "byte", 0);
  setTag(compound, "commandsEnabled", "byte", 0);
  setTag(compound, "hasBeenLoadedInCreative", "byte", 0);
  setTag(compound, "commandblocksenabled", "byte", 1);
  setTag(compound, "educationFeaturesEnabled", "byte", 0);
  setTag(compound, "immutableWorld", "byte", 0);
  setTag(compound, "isCreatedInEditor", "byte", 0);
  setTag(compound, "isExportedFromEditor", "byte", 0);

  const experiments = compound.experiments?.value;
  if (experiments) {
    setTag(experiments, "experiments_ever_used", "byte", 0);
    setTag(experiments, "saved_with_toggled_experiments", "byte", 0);
  }
  const abilities = compound.abilities?.value;
  if (abilities) {
    for (const ability of ["flying", "instabuild", "invulnerable", "mayfly"]) {
      setTag(abilities, ability, "byte", 0);
    }
  }

  const payload = nbt.writeUncompressed(root, "little");
  const header = Buffer.alloc(8);
  header.writeUInt32LE(version, 0);
  header.writeUInt32LE(payload.length, 4);
  fs.writeFileSync(filePath, Buffer.concat([header, payload]));
}

function parseRoots(buffer) {
  const roots = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsed = nbt.protos.little.parsePacketBuffer("nbt", buffer, offset);
    roots.push(parsed.data);
    offset += parsed.metadata.size;
  }
  return roots;
}

function chunkIdentity(key) {
  if (key.length !== 9 && key.length !== 10 && key.length !== 13 && key.length !== 14) return undefined;
  const tagOffset = key.length >= 13 ? 12 : 8;
  const tag = key[tagOffset];
  if (tag < 0x2b || tag > 0x41) return undefined;
  return {
    x: key.readInt32LE(0),
    z: key.readInt32LE(4),
    dimension: key.length >= 13 ? key.readInt32LE(8) : 0,
  };
}

function patchCommandBlock(compound, command, name) {
  setTag(compound, "Command", "string", command);
  setTag(compound, "CustomName", "string", name);
  setTag(compound, "LastOutput", "string", "");
  setTag(compound, "SuccessCount", "int", 0);
  setTag(compound, "conditionMet", "byte", 0);
  setTag(compound, "powered", "byte", 0);
}

async function patchWorldDb(worldPath) {
  const db = new LevelDB(path.join(worldPath, "db"), { createIfMissing: false });
  await db.open();
  const chunks = new Set();
  let bootstrapCommands = 0;
  let structureFound = false;
  let tickingAreaFound = false;

  try {
    const iterator = db.getIterator({ keyAsBuffer: true, valueAsBuffer: true });
    for await (const [key, value] of iterator) {
      const chunk = chunkIdentity(key);
      if (chunk) chunks.add(`${chunk.dimension}:${chunk.x},${chunk.z}`);

      const textKey = key.toString("utf8");
      if (textKey.startsWith("tickingarea_")) tickingAreaFound = true;

      if (textKey === `structuretemplate_${STRUCTURE_ID}`) {
        const root = nbt.parseUncompressed(value, "little");
        const simple = nbt.simplify(root);
        const palette = simple.structure?.palette?.default?.block_palette;
        const blockData = simple.structure?.palette?.default?.block_position_data?.["0"]?.block_entity_data;
        if (!Array.isArray(palette) || palette[0]?.name !== "minecraft:command_block") {
          throw new Error("Spawn structure is missing its command block");
        }
        if (palette[1]?.name !== "minecraft:stone_button" || palette[1]?.states?.facing_direction !== 1) {
          throw new Error("Spawn structure is missing its top-mounted stone button");
        }
        if (!blockData) throw new Error("Spawn structure is missing command block data");

        const compound = root.value.structure.value.palette.value.default.value
          .block_position_data.value["0"].value.block_entity_data.value;
        patchCommandBlock(compound, COMMAND, "Creative switch");
        setTag(compound, "auto", "byte", 0);
        await db.put(key, nbt.writeUncompressed(root, "little"), { sync: true });
        structureFound = true;
        continue;
      }

      if (key.length !== 13 || key.readInt32LE(8) !== BOOTSTRAP.dimension || key[12] !== 0x31) continue;
      const roots = parseRoots(value);
      let changed = false;
      for (const root of roots) {
        const simple = nbt.simplify(root);
        const command = simple.y === BOOTSTRAP.y && simple.z === BOOTSTRAP.z
          ? BOOTSTRAP_COMMANDS.get(simple.x)
          : undefined;
        if (simple.id !== "CommandBlock" || !command) continue;
        patchCommandBlock(root.value, command, "Spawn bootstrap");
        setTag(root.value, "auto", "byte", 1);
        bootstrapCommands += 1;
        changed = true;
      }
      if (changed) {
        await db.put(key, Buffer.concat(roots.map((root) => nbt.writeUncompressed(root, "little"))), { sync: true });
      }
    }
  } finally {
    await db.close();
  }

  const expectedChunk = `${BOOTSTRAP.dimension}:${BOOTSTRAP.chunkX},${BOOTSTRAP.chunkZ}`;
  if (chunks.size !== 1 || !chunks.has(expectedChunk)) {
    throw new Error(`Template must contain only End bootstrap chunk ${expectedChunk}; found ${[...chunks].join(" ")}`);
  }
  if (chunks.has("0:6250,6250") || chunks.has("2:6250,6250")) throw new Error("Legacy far chunk still exists");
  if (bootstrapCommands !== BOOTSTRAP.commandBlocks) {
    throw new Error(`Expected ${BOOTSTRAP.commandBlocks} bootstrap commands, found ${bootstrapCommands}`);
  }
  if (!structureFound) throw new Error("Spawn command block structure is missing");
  if (!tickingAreaFound) throw new Error("Bootstrap ticking area is missing");
}

function collectFiles(rootPath, currentPath = rootPath, files = {}) {
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      collectFiles(rootPath, absolutePath, files);
    } else if (entry.isFile()) {
      const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
      files[relativePath] = new Uint8Array(fs.readFileSync(absolutePath));
    }
  }
  return files;
}

function packWorld(worldPath, outputPath) {
  const files = collectFiles(worldPath);
  for (const requiredPath of ["level.dat", "level.dat_old", "levelname.txt", "db/CURRENT"]) {
    if (!files[requiredPath]) throw new Error(`Missing ${requiredPath}`);
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, zipSync(files, { level: 9 }));
  return files;
}

const worldPath = path.resolve(process.argv[2] ?? "work/bds-template/worlds/MVPSpawnBuilderV2");
const outputPath = path.resolve(process.argv[3] ?? "public/template.mcworld");
const worldName = "MCWorld MVP Template";

await patchWorldDb(worldPath);
patchLevelDat(path.join(worldPath, "level.dat"), worldName);
patchLevelDat(path.join(worldPath, "level.dat_old"), worldName);
fs.writeFileSync(path.join(worldPath, "levelname.txt"), strToU8(worldName));
const packedFiles = packWorld(worldPath, outputPath);
const dbFiles = Object.fromEntries(
  Object.entries(packedFiles)
    .filter(([filePath]) => filePath.startsWith("db/"))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([filePath, bytes]) => [
      filePath,
      { size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") },
    ]),
);
const manifestPath = path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}-manifest.json`);
fs.writeFileSync(
  manifestPath,
  `${JSON.stringify({
    schemaVersion: 2,
    templateBedrockVersion: "1.26.33.2",
    minimumCompatibleVersion: "1.26.30",
    placement: {
      strategy: "end-bootstrap-structure",
      structureId: STRUCTURE_ID,
      command: COMMAND,
      button: "minecraft:stone_button",
      playerOffset: { x: 2, y: 0, z: 0 },
      requiresAir: [{ x: 2, y: 0, z: 0 }, { x: 2, y: 1, z: 0 }],
      bootstrap: BOOTSTRAP,
    },
    dbFiles,
  }, null, 2)}\n`,
);

console.log(JSON.stringify({ worldPath, outputPath, manifestPath, placement: "first-player surface Y + air check" }, null, 2));
