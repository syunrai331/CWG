import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { LevelDB } = require("leveldb-zlib");
const nbt = require("prismarine-nbt");

function toJson(value) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? `${item}n` : item),
    2,
  );
}

function parseRoots(buffer) {
  const roots = [];
  let offset = 0;
  while (offset < buffer.length) {
    const parsed = nbt.protos.little.parsePacketBuffer("nbt", buffer, offset);
    roots.push(parsed.data);
    const size = parsed.metadata.size;
    if (!Number.isInteger(size) || size <= 0) {
      throw new Error(`Invalid root size ${size} at offset ${offset}`);
    }
    offset += size;
  }
  return roots;
}

async function scan(worldPath) {
  const levelDat = fs.readFileSync(path.join(worldPath, "level.dat"));
  const payloadLength = levelDat.readUInt32LE(4);
  const parsedLevel = nbt.parseUncompressed(levelDat.subarray(8, 8 + payloadLength), "little");
  const simpleLevel = nbt.simplify(parsedLevel);
  if (process.argv.includes("--level")) {
    console.log("LEVEL_DAT");
    console.log(toJson(simpleLevel));
  } else {
    console.log("WORLD", {
      LevelName: simpleLevel.LevelName,
      GameType: simpleLevel.GameType,
      cheatsEnabled: simpleLevel.cheatsEnabled,
      commandsEnabled: simpleLevel.commandsEnabled,
      hasBeenLoadedInCreative: simpleLevel.hasBeenLoadedInCreative,
      commandblocksenabled: simpleLevel.commandblocksenabled,
    });
  }

  const db = new LevelDB(path.join(worldPath, "db"), { createIfMissing: false });
  await db.open();
  let keys = 0;
  let blockEntityRecords = 0;
  const hits = [];
  const commandBlocks = [];
  const keySummary = [];
  const structures = [];
  try {
    const iterator = db.getIterator({ keyAsBuffer: true, valueAsBuffer: true });
    for await (const [key, value] of iterator) {
      keys += 1;
      if (process.argv.includes("--keys")) {
        keySummary.push({
          hex: key.toString("hex"),
          ascii: key.toString("utf8").replaceAll("\u0000", "\\0"),
          keyLength: key.length,
          valueLength: value.length,
        });
      }
      if (key.toString("utf8").startsWith("structuretemplate_") && process.argv.includes("--structures")) {
        const parsed = nbt.parseUncompressed(value, "little");
        structures.push({ key: key.toString("utf8"), value: nbt.simplify(parsed) });
      }
      if (key.length >= 9 && key[key.length - 1] === 0x31) {
        blockEntityRecords += 1;
        let roots;
        try {
          roots = parseRoots(value);
        } catch (error) {
          hits.push({ key: key.toString("hex"), parseError: String(error) });
          continue;
        }
        for (const root of roots) {
          const simple = nbt.simplify(root);
          if (simple.id === "CommandBlock") {
            commandBlocks.push({
              key: key.toString("hex"),
              x: simple.x,
              y: simple.y,
              z: simple.z,
              command: simple.Command,
            });
          }
          const serialized = toJson(simple);
          if (/command|Command|gamemode|x"\s*:\s*100000/.test(serialized)) {
            hits.push({ key: key.toString("hex"), value: simple });
          }
        }
      }
    }
  } finally {
    await db.close();
  }
  console.log("SUMMARY", { keys, blockEntityRecords, hits: hits.length });
  if (process.argv.includes("--structures")) {
    console.log(toJson(structures));
  } else if (process.argv.includes("--keys")) {
    console.log(toJson(keySummary));
  } else if (process.argv.includes("--commands")) {
    const chunkArg = process.argv.find((item) => item.startsWith("--chunk="));
    const chunkKey = chunkArg?.slice("--chunk=".length);
    const shownCommands = process.argv.includes("--aligned")
      ? commandBlocks.filter((item) => item.y === 100 && item.x % 16 === 0 && item.z % 16 === 0)
      : chunkKey
        ? commandBlocks.filter((item) => item.key === chunkKey)
        : commandBlocks;
    console.log(toJson(shownCommands));
  } else if (hits.length) {
    console.log(toJson(hits));
  }
}

const worldPath = process.argv[2];
if (!worldPath) throw new Error("Usage: node tools/scan-world.mjs <world-path>");
await scan(path.resolve(worldPath));
