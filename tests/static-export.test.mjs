import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(root, "out");

async function readFiles(directory, extension) {
  const contents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) contents.push(...await readFiles(entryPath, extension));
    if (entry.isFile() && entry.name.endsWith(extension)) contents.push(await readFile(entryPath, "utf8"));
  }
  return contents;
}

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

test("exports a serverless GitHub Pages site under /CWG/", async () => {
  const html = await readFile(path.join(outputRoot, "index.html"), "utf8");
  assert.match(html, /<title>Minecraft Bedrock World Generator<\/title>/);
  assert.match(html, /World Name/);
  assert.match(html, /Seed/);
  assert.match(html, /Generate World/);
  assert.match(html, /href="\/CWG\/_next\/static\//);
  assert.match(html, /src="\/CWG\/_next\/static\//);
  assert.doesNotMatch(html, /(?:href|src)="\/_next\//);
  assert.doesNotMatch(html, /100000|6250/);

  const staticReferences = [...html.matchAll(/(?:href|src)="(\/CWG\/_next\/[^"?#]+)"/g)]
    .map((match) => match[1]);
  assert.ok(staticReferences.length > 0);
  for (const reference of staticReferences) {
    const outputPath = path.join(outputRoot, ...reference.slice("/CWG/".length).split("/"));
    assert.equal((await stat(outputPath)).isFile(), true, `missing exported asset ${reference}`);
  }

  const clientJavaScript = (await readFiles(path.join(outputRoot, "_next"), ".js")).join("\n");
  assert.match(clientJavaScript, /\/CWG\/template\.mcworld/);
  assert.match(clientJavaScript, /\/CWG\/template-manifest\.json/);

  await stat(path.join(outputRoot, ".nojekyll"));
  assert.equal(
    await sha256(path.join(outputRoot, "template.mcworld")),
    await sha256(path.join(root, "public", "template.mcworld")),
  );
  assert.equal(
    await sha256(path.join(outputRoot, "template-manifest.json")),
    await sha256(path.join(root, "public", "template-manifest.json")),
  );
});
