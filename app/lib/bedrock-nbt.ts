export const enum NbtType {
  End = 0,
  Byte = 1,
  Short = 2,
  Int = 3,
  Long = 4,
  Float = 5,
  Double = 6,
  ByteArray = 7,
  String = 8,
  List = 9,
  Compound = 10,
  IntArray = 11,
  LongArray = 12,
}

export type NbtCompound = Record<string, NbtTag>;

export type NbtTag = {
  type: NbtType;
  value:
    | number
    | bigint
    | string
    | Uint8Array
    | Int32Array
    | bigint[]
    | NbtCompound
    | NbtList;
};

export type NbtList = {
  elementType: NbtType;
  items: NbtTag[];
};

export type LevelDatDocument = {
  version: number;
  rootName: string;
  root: NbtTag;
};

export type DifficultyValue = 0 | 1 | 2 | 3;

export type WorldSettings = {
  worldName: string;
  seed: bigint;
  difficulty: DifficultyValue;
};

export type WorldStateSnapshot = {
  worldName: string;
  seed: bigint;
  difficulty: number;
  gameType: number;
  cheatsEnabled: number;
  commandsEnabled: number;
  hasBeenLoadedInCreative: number;
  commandBlocksEnabled: number;
};

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();
const MAX_COLLECTION_LENGTH = 16_777_216;

class NbtReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  offset = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining() {
    return this.bytes.byteLength - this.offset;
  }

  private need(length: number) {
    if (length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new Error("NBT data ended unexpectedly.");
    }
  }

  readUint8() {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  readInt8() {
    this.need(1);
    return this.view.getInt8(this.offset++);
  }

  readUint16() {
    this.need(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readInt16() {
    this.need(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  readInt32() {
    this.need(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readBigInt64() {
    this.need(8);
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readFloat32() {
    this.need(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFloat64() {
    this.need(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  readBytes(length: number) {
    this.need(length);
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readString() {
    return textDecoder.decode(this.readBytes(this.readUint16()));
  }

  readLength(label: string) {
    const length = this.readInt32();
    if (length < 0 || length > MAX_COLLECTION_LENGTH) {
      throw new Error(`Invalid ${label} length: ${length}.`);
    }
    return length;
  }

  readPayload(type: NbtType): NbtTag {
    switch (type) {
      case NbtType.Byte:
        return { type, value: this.readInt8() };
      case NbtType.Short:
        return { type, value: this.readInt16() };
      case NbtType.Int:
        return { type, value: this.readInt32() };
      case NbtType.Long:
        return { type, value: this.readBigInt64() };
      case NbtType.Float:
        return { type, value: this.readFloat32() };
      case NbtType.Double:
        return { type, value: this.readFloat64() };
      case NbtType.ByteArray: {
        const length = this.readLength("byte array");
        return { type, value: this.readBytes(length) };
      }
      case NbtType.String:
        return { type, value: this.readString() };
      case NbtType.List: {
        const elementType = this.readUint8() as NbtType;
        const length = this.readLength("list");
        if (elementType === NbtType.End && length !== 0) {
          throw new Error("A non-empty NBT list cannot use TAG_End.");
        }
        const items = Array.from({ length }, () => this.readPayload(elementType));
        return { type, value: { elementType, items } satisfies NbtList };
      }
      case NbtType.Compound: {
        const compound: NbtCompound = {};
        while (true) {
          const childType = this.readUint8() as NbtType;
          if (childType === NbtType.End) break;
          if (childType < NbtType.Byte || childType > NbtType.LongArray) {
            throw new Error(`Unknown NBT tag type: ${childType}.`);
          }
          const name = this.readString();
          compound[name] = this.readPayload(childType);
        }
        return { type, value: compound };
      }
      case NbtType.IntArray: {
        const length = this.readLength("int array");
        const values = new Int32Array(length);
        for (let index = 0; index < length; index += 1) values[index] = this.readInt32();
        return { type, value: values };
      }
      case NbtType.LongArray: {
        const length = this.readLength("long array");
        const values = Array.from({ length }, () => this.readBigInt64());
        return { type, value: values };
      }
      default:
        throw new Error(`Unsupported NBT tag type: ${type}.`);
    }
  }

  readRoot() {
    const type = this.readUint8() as NbtType;
    if (type !== NbtType.Compound) throw new Error("level.dat root must be a compound tag.");
    const name = this.readString();
    return { name, tag: this.readPayload(type) };
  }
}

class NbtWriter {
  private bytes = new Uint8Array(4096);
  private view = new DataView(this.bytes.buffer);
  private offset = 0;

  private ensure(length: number) {
    if (this.offset + length <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < this.offset + length) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  writeUint8(value: number) {
    this.ensure(1);
    this.view.setUint8(this.offset++, value);
  }

  writeInt8(value: number) {
    this.ensure(1);
    this.view.setInt8(this.offset++, value);
  }

  writeUint16(value: number) {
    this.ensure(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
  }

  writeInt16(value: number) {
    this.ensure(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
  }

  writeInt32(value: number) {
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  writeBigInt64(value: bigint) {
    this.ensure(8);
    this.view.setBigInt64(this.offset, value, true);
    this.offset += 8;
  }

  writeFloat32(value: number) {
    this.ensure(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
  }

  writeFloat64(value: number) {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
  }

  writeBytes(value: Uint8Array) {
    this.ensure(value.byteLength);
    this.bytes.set(value, this.offset);
    this.offset += value.byteLength;
  }

  writeString(value: string) {
    const encoded = textEncoder.encode(value);
    if (encoded.byteLength > 0xffff) throw new Error("NBT string is too long.");
    this.writeUint16(encoded.byteLength);
    this.writeBytes(encoded);
  }

  writePayload(tag: NbtTag) {
    switch (tag.type) {
      case NbtType.Byte:
        this.writeInt8(tag.value as number);
        break;
      case NbtType.Short:
        this.writeInt16(tag.value as number);
        break;
      case NbtType.Int:
        this.writeInt32(tag.value as number);
        break;
      case NbtType.Long:
        this.writeBigInt64(tag.value as bigint);
        break;
      case NbtType.Float:
        this.writeFloat32(tag.value as number);
        break;
      case NbtType.Double:
        this.writeFloat64(tag.value as number);
        break;
      case NbtType.ByteArray: {
        const value = tag.value as Uint8Array;
        this.writeInt32(value.byteLength);
        this.writeBytes(value);
        break;
      }
      case NbtType.String:
        this.writeString(tag.value as string);
        break;
      case NbtType.List: {
        const list = tag.value as NbtList;
        this.writeUint8(list.elementType);
        this.writeInt32(list.items.length);
        for (const item of list.items) {
          if (item.type !== list.elementType) throw new Error("NBT list contains a mismatched tag type.");
          this.writePayload(item);
        }
        break;
      }
      case NbtType.Compound:
        for (const [name, child] of Object.entries(tag.value as NbtCompound)) {
          this.writeUint8(child.type);
          this.writeString(name);
          this.writePayload(child);
        }
        this.writeUint8(NbtType.End);
        break;
      case NbtType.IntArray: {
        const values = tag.value as Int32Array;
        this.writeInt32(values.length);
        for (const value of values) this.writeInt32(value);
        break;
      }
      case NbtType.LongArray: {
        const values = tag.value as bigint[];
        this.writeInt32(values.length);
        for (const value of values) this.writeBigInt64(value);
        break;
      }
      default:
        throw new Error(`Unsupported NBT tag type: ${tag.type}.`);
    }
  }

  writeRoot(name: string, tag: NbtTag) {
    this.writeUint8(tag.type);
    this.writeString(name);
    this.writePayload(tag);
    return this.bytes.slice(0, this.offset);
  }
}

function asCompound(tag: NbtTag, label: string): NbtCompound {
  if (tag.type !== NbtType.Compound) throw new Error(`${label} must be an NBT compound.`);
  return tag.value as NbtCompound;
}

function requireTag(compound: NbtCompound, name: string, type: NbtType) {
  const tag = compound[name];
  if (!tag || tag.type !== type) throw new Error(`Template is missing ${name} with the expected NBT type.`);
  return tag;
}

function setNumber(compound: NbtCompound, name: string, type: NbtType, value: number) {
  requireTag(compound, name, type).value = value;
}

export function parseLevelDat(bytes: Uint8Array): LevelDatDocument {
  if (bytes.byteLength < 11) throw new Error("level.dat is too short.");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = header.getUint32(0, true);
  const payloadLength = header.getUint32(4, true);
  if (payloadLength !== bytes.byteLength - 8) throw new Error("level.dat has an invalid Bedrock header length.");

  const reader = new NbtReader(bytes.subarray(8));
  const { name, tag } = reader.readRoot();
  if (reader.remaining !== 0) throw new Error("level.dat contains unexpected trailing bytes.");
  return { version, rootName: name, root: tag };
}

export function writeLevelDat(document: LevelDatDocument) {
  const payload = new NbtWriter().writeRoot(document.rootName, document.root);
  const bytes = new Uint8Array(payload.byteLength + 8);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, document.version, true);
  header.setUint32(4, payload.byteLength, true);
  bytes.set(payload, 8);
  return bytes;
}

export function applyWorldSettings(bytes: Uint8Array, settings: WorldSettings) {
  const document = parseLevelDat(bytes);
  const root = asCompound(document.root, "level.dat root");

  requireTag(root, "LevelName", NbtType.String).value = settings.worldName;
  requireTag(root, "RandomSeed", NbtType.Long).value = settings.seed;
  setNumber(root, "Difficulty", NbtType.Int, settings.difficulty);
  setNumber(root, "GameType", NbtType.Int, 0);
  setNumber(root, "ForceGameType", NbtType.Byte, 0);
  setNumber(root, "IsHardcore", NbtType.Byte, 0);
  setNumber(root, "cheatsEnabled", NbtType.Byte, 0);
  setNumber(root, "commandsEnabled", NbtType.Byte, 0);
  setNumber(root, "hasBeenLoadedInCreative", NbtType.Byte, 0);
  setNumber(root, "commandblocksenabled", NbtType.Byte, 1);
  setNumber(root, "educationFeaturesEnabled", NbtType.Byte, 0);
  setNumber(root, "immutableWorld", NbtType.Byte, 0);
  setNumber(root, "isCreatedInEditor", NbtType.Byte, 0);
  setNumber(root, "isExportedFromEditor", NbtType.Byte, 0);

  const experiments = asCompound(requireTag(root, "experiments", NbtType.Compound), "experiments");
  setNumber(experiments, "experiments_ever_used", NbtType.Byte, 0);
  setNumber(experiments, "saved_with_toggled_experiments", NbtType.Byte, 0);

  const abilities = asCompound(requireTag(root, "abilities", NbtType.Compound), "abilities");
  setNumber(abilities, "flying", NbtType.Byte, 0);
  setNumber(abilities, "instabuild", NbtType.Byte, 0);
  setNumber(abilities, "invulnerable", NbtType.Byte, 0);
  setNumber(abilities, "mayfly", NbtType.Byte, 0);

  const output = writeLevelDat(document);
  assertWorldState(parseLevelDat(output), settings);
  return output;
}

export function snapshotWorldState(document: LevelDatDocument): WorldStateSnapshot {
  const root = asCompound(document.root, "level.dat root");
  return {
    worldName: requireTag(root, "LevelName", NbtType.String).value as string,
    seed: requireTag(root, "RandomSeed", NbtType.Long).value as bigint,
    difficulty: requireTag(root, "Difficulty", NbtType.Int).value as number,
    gameType: requireTag(root, "GameType", NbtType.Int).value as number,
    cheatsEnabled: requireTag(root, "cheatsEnabled", NbtType.Byte).value as number,
    commandsEnabled: requireTag(root, "commandsEnabled", NbtType.Byte).value as number,
    hasBeenLoadedInCreative: requireTag(root, "hasBeenLoadedInCreative", NbtType.Byte).value as number,
    commandBlocksEnabled: requireTag(root, "commandblocksenabled", NbtType.Byte).value as number,
  };
}

export function assertWorldState(document: LevelDatDocument, settings?: WorldSettings) {
  const state = snapshotWorldState(document);
  if (state.gameType !== 0) throw new Error("Generated world is not Survival.");
  if (state.cheatsEnabled !== 0 || state.commandsEnabled !== 0) {
    throw new Error("Generated world does not have cheats disabled.");
  }
  if (state.hasBeenLoadedInCreative !== 0) throw new Error("Creative history flag is set.");
  if (state.commandBlocksEnabled !== 1) throw new Error("Command blocks are disabled.");
  if (settings) {
    if (state.worldName !== settings.worldName) throw new Error("World name did not round-trip.");
    if (state.seed !== settings.seed) throw new Error("Seed did not round-trip as signed 64-bit data.");
    if (state.difficulty !== settings.difficulty) throw new Error("Difficulty did not round-trip.");
  }
  return state;
}
