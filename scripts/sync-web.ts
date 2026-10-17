// Copies the web viewer packages from a checkout of the private service
// repository into sdks/web/packages. The private repository stays the source
// of truth while the engine API changes; see sdks/web/README.md.
//
//   node scripts/sync-web.ts <private checkout> [--ref <rev>] [--engine-ref <rev>] [--ui-ref <rev>] [--dry-run]
//
// Files come from `git archive` of the given revisions, so untracked and
// ignored files in the checkout (build output, local state, credentials) are
// never read. Each package's README.md, tsconfig.json and LICENSE belong to
// this repository and are never written. package.json is copied with its
// publish fields set for npm. Nothing else is rewritten.
//
// sdks/web/sync.json records the hash of every file the last sync wrote. The
// sync stops without writing anything when it would overwrite or delete a
// file that was changed here since then, or overwrite a file that only exists
// here.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageSpec {
  name: string;
  directory: string;
  source: string;
}

interface SyncRecord {
  version: 1;
  packages: Record<string, { commit: string }>;
  files: Record<string, string>;
}

const packages: PackageSpec[] = [
  { name: "@medalbot/viewer-engine", directory: "viewer-engine", source: "src/packages/viewer-engine" },
  { name: "@medalbot/viewer-ui", directory: "viewer-ui", source: "src/packages/viewer-ui" },
];

// Owned by this repository: never copied, never deleted.
const ownedFiles = new Set(["README.md", "tsconfig.json", "LICENSE"]);

// A path that must never reach the public repository.
const forbiddenPath = /(^|\/)(\.runtime|\.data|\.env[^/]*|node_modules|dist)(\/|$)|\.(pem|key|p12)$/;

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(repository, "sdks", "web");
const recordPath = join(webRoot, "sync.json");

function usage(): never {
  throw new Error(
    "Usage: node scripts/sync-web.ts <private checkout> [--ref <rev>] [--engine-ref <rev>] [--ui-ref <rev>] [--dry-run]",
  );
}

function parseArguments(argv: string[]) {
  const [checkout, ...rest] = argv;

  if (checkout === undefined || checkout.startsWith("--")) {
    usage();
  }

  const options = { checkout: resolve(checkout), ref: "HEAD", engineRef: "", uiRef: "", dryRun: false };

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];

    if (flag === "--dry-run") {
      options.dryRun = true;

      continue;
    }

    if (value === undefined) {
      usage();
    }

    if (flag === "--ref") {
      options.ref = value;
    } else if (flag === "--engine-ref") {
      options.engineRef = value;
    } else if (flag === "--ui-ref") {
      options.uiRef = value;
    } else {
      usage();
    }

    index += 1;
  }

  return options;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function walk(directory: string): Promise<string[]> {
  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

// The files of one package at one revision, keyed by path inside the package.
async function exportPackage(checkout: string, ref: string, source: string): Promise<Map<string, Buffer>> {
  const scratch = await mkdtemp(join(tmpdir(), "sync-web-"));

  try {
    const archive = join(scratch, "package.tar");
    git(checkout, ["archive", "--format=tar", "-o", archive, ref, "--", source]);
    const tree = join(scratch, "tree");
    await mkdir(tree);
    execFileSync("tar", ["-xf", archive, "-C", tree]);
    const root = join(tree, source);
    const files = new Map<string, Buffer>();

    for (const path of await walk(root)) {
      if (forbiddenPath.test(path)) {
        throw new Error(`Refusing to copy ${source}/${path}: it is local state, build output or a credential`);
      }

      if (ownedFiles.has(path)) {
        continue;
      }

      files.set(path, await readFile(join(root, path)));
    }

    if (!files.has("package.json")) {
      throw new Error(`${source} has no package.json at ${ref}`);
    }

    return files;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Sets the fields npm needs to publish and replaces workspace references with
// the version this sync writes. Every other field is kept as it is.
function publishManifest(
  bytes: Buffer,
  spec: PackageSpec,
  versions: Map<string, string>,
): Buffer {
  const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;

  if (manifest.name !== spec.name) {
    throw new Error(`${spec.source}/package.json is named ${String(manifest.name)}, expected ${spec.name}`);
  }

  delete manifest.private;
  manifest.license = "MIT";
  manifest.repository = {
    type: "git",
    url: "https://github.com/Flo4604/render-sdks.git",
    directory: `sdks/web/packages/${spec.directory}`,
  };
  manifest.homepage = "https://github.com/Flo4604/render-sdks/tree/main/sdks/web";
  manifest.publishConfig = { access: "public" };

  const files = Array.isArray(manifest.files) ? (manifest.files as string[]) : [];

  if (!files.includes("LICENSE")) {
    manifest.files = [...files, "LICENSE"];
  }

  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = manifest[field] as Record<string, string> | undefined;

    if (dependencies === undefined) {
      continue;
    }

    for (const [name, range] of Object.entries(dependencies)) {
      if (!range.startsWith("workspace:")) {
        continue;
      }

      const version = versions.get(name);

      if (version === undefined) {
        throw new Error(`${spec.name} depends on ${name} through the workspace, and the sync does not copy it`);
      }

      dependencies[name] = `^${version}`;
    }
  }

  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function readRecord(): Promise<SyncRecord> {
  if (!existsSync(recordPath)) {
    return { version: 1, packages: {}, files: {} };
  }

  return JSON.parse(await readFile(recordPath, "utf8")) as SyncRecord;
}

// Files in the destination as git sees them: tracked or untracked, without
// ignored build output.
function destinationFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }

  return git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "."])
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(directory, path)));
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const refs = new Map([
    ["viewer-engine", options.engineRef || options.ref],
    ["viewer-ui", options.uiRef || options.ref],
  ]);
  const record = await readRecord();
  const exported = new Map<string, Map<string, Buffer>>();
  const commits = new Map<string, string>();
  const versions = new Map<string, string>();

  for (const spec of packages) {
    const ref = refs.get(spec.directory) ?? options.ref;
    commits.set(spec.directory, git(options.checkout, ["rev-parse", "--verify", `${ref}^{commit}`]).trim());
    const files = await exportPackage(options.checkout, ref, spec.source);
    const manifest = JSON.parse((files.get("package.json") ?? Buffer.from("{}")).toString("utf8")) as {
      version?: string;
    };
    versions.set(spec.name, manifest.version ?? "0.0.0");
    exported.set(spec.directory, files);
  }

  const writes = new Map<string, Buffer>();
  const deletions: string[] = [];
  const conflicts: string[] = [];
  const nextFiles: Record<string, string> = {};

  for (const spec of packages) {
    const files = exported.get(spec.directory) ?? new Map<string, Buffer>();
    files.set("package.json", publishManifest(files.get("package.json") ?? Buffer.alloc(0), spec, versions));
    const destination = join(webRoot, "packages", spec.directory);
    const prefix = `packages/${spec.directory}/`;
    const present = new Set(destinationFiles(destination).filter((path) => !ownedFiles.has(path)));

    for (const [path, bytes] of files) {
      const key = prefix + path;
      const hash = sha256(bytes);
      nextFiles[key] = hash;

      if (!present.has(path)) {
        writes.set(key, bytes);

        continue;
      }

      const current = sha256(await readFile(join(destination, path)));

      if (current === hash) {
        continue;
      }

      const synced = record.files[key];

      if (synced === undefined) {
        conflicts.push(`${key} exists only in render-sdks and the sync would overwrite it`);
      } else if (current !== synced) {
        conflicts.push(`${key} was changed in render-sdks since the last sync`);
      } else {
        writes.set(key, bytes);
      }
    }

    for (const path of present) {
      const key = prefix + path;

      if (files.has(path)) {
        continue;
      }

      const synced = record.files[key];

      if (synced === undefined) {
        continue;
      }

      const current = sha256(await readFile(join(destination, path)));

      if (current !== synced) {
        conflicts.push(`${key} was changed in render-sdks since the last sync, and the source no longer has it`);
      } else {
        deletions.push(key);
      }
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Nothing was written. Move these changes to the private repository first, or remove them here:\n  ${conflicts.join("\n  ")}`,
    );
  }

  for (const key of writes.keys()) {
    console.log(`write  ${key}`);
  }

  for (const key of deletions) {
    console.log(`delete ${key}`);
  }

  if (options.dryRun) {
    console.log(`dry run: ${writes.size} writes, ${deletions.length} deletions`);

    return;
  }

  for (const [key, bytes] of writes) {
    const target = join(webRoot, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  for (const key of deletions) {
    await rm(join(webRoot, key));
  }

  const next: SyncRecord = {
    version: 1,
    packages: Object.fromEntries([...commits].map(([directory, commit]) => [directory, { commit }])),
    files: Object.fromEntries(Object.entries(nextFiles).sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(recordPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`synced ${writes.size} writes, ${deletions.length} deletions; record in sdks/web/sync.json`);
}

await main();
