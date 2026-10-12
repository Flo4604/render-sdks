#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [language, ...flags] = process.argv.slice(2);
if (
  !["typescript", "python", "go", "csharp"].includes(language) ||
  flags.some((flag) => flag !== "--publish")
)
  throw new Error(
    "Usage: node scripts/release.mjs <typescript|python|go|csharp> [--publish]",
  );
const publish = flags.includes("--publish");
const source = join(root, "sdks", language);
const repository = "Flo4604/render-sdks";
function run(command, args, cwd = source, capture = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}
let version;
if (language === "typescript")
  version = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  ).version;
else if (language === "python")
  version = (await readFile(join(source, "pyproject.toml"), "utf8")).match(
    /^version = "([^"]+)"$/m,
  )?.[1];
else if (language === "csharp")
  version = (
    await readFile(join(source, "src/Medalbot.Render.csproj"), "utf8")
  ).match(/<Version>([^<]+)<\/Version>/)?.[1];
else version = (await readFile(join(source, "VERSION"), "utf8")).trim();
if (!/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Package version must be stable semver");
const tag = `${language === "go" ? "sdks/go" : language}/v${version}`;
const assets = join(root, "artifacts", language, version);
if (publish && run("git", ["status", "--porcelain"], root, true).trim())
  throw new Error("Commit source changes before publishing");
await rm(assets, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
if (language === "typescript") {
  run("npm", ["ci"]);
  run("npm", ["test"]);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", assets]);
  const members = run(
    "tar",
    ["-tzf", join(assets, `medalbot-render-${version}.tgz`)],
    root,
    true,
  )
    .trim()
    .split("\n");
  const allowed = new Set([
    "package/package.json",
    "package/README.md",
    "package/LICENSE",
    ...["client.js", "client.d.ts", "protocol.js", "protocol.d.ts"].map(
      (name) => `package/dist/src/${name}`,
    ),
  ]);
  if (members.some((name) => !allowed.has(name)))
    throw new Error("Unexpected npm package member");
} else if (language === "python") {
  run("uv", ["run", "--locked", "--extra", "dev", "pytest"]);
  run("uv", ["build", "--wheel", "--out-dir", assets]);
  const members = run(
    "unzip",
    ["-Z1", join(assets, `medalbot_render-${version}-py3-none-any.whl`)],
    root,
    true,
  )
    .trim()
    .split("\n");
  if (
    members.some(
      (name) =>
        !/^medalbot_render\/(__init__\.py|client\.py|models\.py|py\.typed)$/.test(
          name,
        ) &&
        !/^medalbot_render-[^/]+\.dist-info\/(METADATA|WHEEL|RECORD|licenses\/LICENSE)$/.test(
          name,
        ),
    )
  )
    throw new Error("Unexpected Python wheel member");
} else if (language === "csharp") {
  run("dotnet", [
    "run",
    "--project",
    "tests/Medalbot.Render.Tests.csproj",
    "-c",
    "Release",
  ]);
  run("dotnet", [
    "pack",
    "src/Medalbot.Render.csproj",
    "-c",
    "Release",
    "--output",
    assets,
  ]);
  const members = run(
    "unzip",
    ["-Z1", join(assets, `Medalbot.Render.${version}.nupkg`)],
    root,
    true,
  )
    .trim()
    .split("\n");
  const allowed = new Set([
    "_rels/.rels",
    "Medalbot.Render.nuspec",
    "lib/net8.0/Medalbot.Render.dll",
    "README.md",
    "[Content_Types].xml",
  ]);
  if (
    members.some(
      (name) =>
        !allowed.has(name) &&
        !/^package\/services\/metadata\/core-properties\/[a-f0-9]+\.psmdcp$/.test(
          name,
        ),
    )
  )
    throw new Error("Unexpected NuGet package member");
} else run("go", ["test", "-race", "./..."]);
await rm(join(assets, ".gitignore"), { force: true });
const files = (await readdir(assets)).sort();
if (files.length) {
  const sums = await Promise.all(
    files.map(
      async (name) =>
        `${createHash("sha256")
          .update(await readFile(join(assets, name)))
          .digest("hex")}  ${name}`,
    ),
  );
  await writeFile(join(assets, "SHA256SUMS"), sums.join("\n") + "\n");
  files.push("SHA256SUMS");
}
console.log(`Verified ${language} ${version}: ${assets}`);
if (!publish) process.exit(0);
if (run("git", ["status", "--porcelain"], root, true).trim())
  throw new Error("Build changed tracked files; commit before publishing");
const existing = run(
  "git",
  ["ls-remote", "--tags", "origin", `refs/tags/${tag}`],
  root,
  true,
);
if (existing.trim()) throw new Error(`Release tag ${tag} already exists`);
run("git", ["tag", "-m", `${language} SDK ${version}`, tag], root);
run("git", ["push", "--atomic", "origin", "HEAD:main", tag], root);
run(
  "gh",
  [
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--verify-tag",
    "--title",
    `${language} SDK ${version}`,
    "--notes",
    `Source and installation instructions: https://github.com/${repository}/tree/${tag}/sdks/${language}`,
    ...files.map((name) => join(assets, name)),
  ],
  root,
);
console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
