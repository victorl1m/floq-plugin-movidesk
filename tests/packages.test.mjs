// Builds every package and validates it with the Floq runtime's own parser (vendored in vendor/floq/). No network, no real credentials.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { buildAll } from "../scripts/build.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let tmp, built, floq;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "floq-plugins-test-"));
  ({ built } = await buildAll(join(tmp, "dist")));
  // The vendored parsers are TypeScript with .js import specifiers: bundle them once into a temp ESM file.
  const entry = join(tmp, "floq-entry.ts");
  writeFileSync(entry, `export { parsePackage, compareVersions, sha256Hex } from ${JSON.stringify(join(ROOT, "vendor/floq/package.ts"))};\nexport { parseCatalog, packageUrlAllowed } from ${JSON.stringify(join(ROOT, "vendor/floq/catalog.ts"))};\n`);
  const out = join(tmp, "floq.mjs");
  await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  floq = await import(pathToFileURL(out).href);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

const entryOf = () => JSON.parse(readFileSync(join(tmp, "dist", "catalog-entry.json"), "utf8"));
const bytesOf = () => built[0].bytes;
const parse = (id, over = {}) => floq.parsePackage(over.bytes ?? bytesOf(id), { id, version: entryOf().version, sha256: entryOf().sha256, ...over.expected }, { builtinIds: over.builtinIds ?? [] });


test("the package passes the Floq package parser and the catalog entry matches it", () => {
  const e = entryOf(), pkg = parse(e.id);
  assert.equal(pkg.manifest.id, e.id); assert.equal(pkg.sha256, built[0].sha256); assert.equal(e.sha256, pkg.sha256);
  assert.ok(pkg.size < 5 * 1024 * 1024);
  assert.equal(e.package, `https://github.com/victorl1m/floq-plugin-${e.id}/releases/download/v${e.version}/${e.id}-${e.version}.floqpkg.json`);
});

test("the committed catalog-entry.json is what the build produces", () => {
  assert.equal(readFileSync(join(ROOT, "catalog-entry.json"), "utf8"), readFileSync(join(tmp, "dist", "catalog-entry.json"), "utf8"));
});

test("the build is reproducible", async () => {
  const second = await buildAll(join(tmp, "dist2"));
  assert.equal(second.built[0].sha256, built[0].sha256);
});

test("tampering is refused: changed bytes, wrong id or version, built-in id clash", () => {
  const id = entryOf().id;
  assert.throws(() => parse(id, { bytes: Buffer.concat([bytesOf(), Buffer.from(" ")]) }), /sha256/);
  assert.throws(() => parse(id, { expected: { id: "other" } }), /id does not match/);
  assert.throws(() => parse(id, { expected: { version: "9.9.9" } }), /version does not match/);
  assert.throws(() => parse(id, { builtinIds: [id] }), /built-in/);
});

test("the runtime bundle is standalone: imports alone and exposes start()", async () => {
  const id = entryOf().id, pkg = parse(id);
  const file = join(tmp, "standalone.mjs"); writeFileSync(file, pkg.runtime);
  assert.equal(typeof (await import(pathToFileURL(file).href)).default.start, "function");
  assert.doesNotMatch(pkg.runtime, /\bfrom\s+["'](?!node:)/);
});

/** A fake PluginContext: records registrations, serves settings/secrets from memory, fetches through a mock (never the network). */
function fakeCtx({ secrets = {}, settings = {}, fetchImpl }) {
  const registered = { taskSources: [] };
  const calls = [];
  const ctx = {
    httpError: (status, code, message) => Object.assign(new Error(message), { status, code }),
    secrets: { get: async (_u, name) => secrets[name] },
    settings: { get: async () => settings },
    taskSources: { register: (s) => registered.taskSources.push(s) },
    fetch: async (url, init) => { calls.push(url); return fetchImpl(url, init); },
    log: { info() {}, warn() {}, error() {} },
  };
  return { ctx, registered, calls };
}
const response = (status, body) => ({ status, ok: status < 400, headers: { "content-type": "application/json" }, bytes: Buffer.from(JSON.stringify(body)), text: () => JSON.stringify(body), json: () => body });

async function loadRuntime(id) {
  const file = join(tmp, `${id}.runtime.mjs`);
  writeFileSync(file, parse(id).runtime);
  return (await import(pathToFileURL(file).href + "?" + Math.random())).default;
}


test("movidesk (built package, mocked fetch): lists tickets with the vault token and maps them", async () => {
  const def = await loadRuntime("movidesk");
  const f = fakeCtx({ secrets: { MOVIDESK_TOKEN: "tok_123" }, fetchImpl: async () => response(200, [{ id: "42", subject: "Printer", baseStatus: "InAttendance", status: "Em atendimento", lastUpdate: "2026-01-02T10:00:00Z", createdDate: "2026-01-01T10:00:00Z" }]) });
  def.start(f.ctx);
  const [{ id, provider }] = f.registered.taskSources;
  assert.equal(id, "tickets");
  const page = await provider.list("u1", {});
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].externalId, "42");
  assert.equal(page.items[0].statusCategory, "doing");
  assert.equal(new URL(f.calls[0]).hostname, "api.movidesk.com");
  assert.equal(new URL(f.calls[0]).searchParams.get("token"), "tok_123");
});

test("movidesk (built package): a missing token is a 409 not_configured and nothing is fetched", async () => {
  const def = await loadRuntime("movidesk");
  const f = fakeCtx({ fetchImpl: async () => { throw new Error("must not be called"); } });
  def.start(f.ctx);
  await assert.rejects(() => f.registered.taskSources[0].provider.list("u1", {}), (e) => e.status === 409 && e.code === "not_configured");
  assert.equal(f.calls.length, 0);
});
