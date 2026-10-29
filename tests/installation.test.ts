import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const revision = "219d743a1e698101fe1ab8bef43e6563126c3c27";
const cleanEnvironment = () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("RSA_AZAHAR_") || name === "RSA_BRIDGE_PORT") delete env[name];
  return env;
};
async function run(argv: string[], env: Record<string, string | undefined>, cwd: string) {
  const child = Bun.spawn(argv, { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}
async function executable(path: string, source: string) {
  await writeFile(path, source);
  await chmod(path, 0o755);
}
async function registration(env: Record<string, string | undefined>, cwd: string) {
  const entry = join(root, "src/index.ts");
  const result = await run([process.execPath, "-e", `import driver from ${JSON.stringify(entry)}; console.log(JSON.stringify(driver));`], env, cwd);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { id: string; transport: string; defaultPort: number; launchCommand: string[]; launchEnv: Record<string, string> };
}

test("installed registration resolves the actual executable and preserves app overrides for launchd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "azahar-install-"));
  try {
    const app = join(directory, "Custom patched app.app");
    const bin = join(app, "Contents/MacOS");
    await mkdir(bin, { recursive: true });
    const output = join(directory, "launched.json");
    await executable(join(bin, "azahar"), `#!${process.execPath}\nawait Bun.write(process.env.TEST_OUTPUT, JSON.stringify({ args: process.argv.slice(2), port: process.env.RSA_BRIDGE_PORT }));\n`);
    const manifest = await registration({ ...cleanEnvironment(), RSA_AZAHAR_APP: app }, directory);
    expect(manifest).toMatchObject({ id: "azahar", transport: "bridge", defaultPort: 47673 });
    expect(manifest.launchCommand).toEqual([join(bin, "azahar")]);
    expect(isAbsolute(manifest.launchCommand[0])).toBe(true);
    expect(manifest.launchEnv).toEqual({ RSA_AZAHAR_APP: app });
    const game = join(directory, "A game; literal.3ds");
    // Only the resolved manifest reaches the child, as happens under launchd.
    const launched = await run([...manifest.launchCommand, game], {
      ...cleanEnvironment(), ...manifest.launchEnv, RSA_BRIDGE_PORT: "48123", TEST_OUTPUT: output,
    }, directory);
    expect(launched.code, launched.stderr).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ args: [game], port: "48123" });

    const defaultManifest = await registration({ ...cleanEnvironment(), XDG_CACHE_HOME: join(directory, "cache") }, directory);
    expect(defaultManifest.launchEnv.RSA_AZAHAR_APP).toBe(join(directory, "cache/ludens/azahar/2126.2-rsa.3/build/bundle/azahar.app"));
    expect(defaultManifest.launchCommand).toEqual([join(defaultManifest.launchEnv.RSA_AZAHAR_APP!, "Contents/MacOS/azahar")]);
    const overridden = await registration({ ...cleanEnvironment(), RSA_AZAHAR_BUILD: join(directory, "custom build") }, directory);
    expect(overridden.launchEnv.RSA_AZAHAR_APP).toBe(join(directory, "custom build/bundle/azahar.app"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing emulator fails with preparation guidance instead of launching another application", async () => {
  const directory = await mkdtemp(join(tmpdir(), "azahar-missing-"));
  try {
    const result = await run(["/bin/bash", join(root, "scripts/launch.sh")], {
      ...cleanEnvironment(), RSA_AZAHAR_APP: join(directory, "missing.app"),
    }, directory);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("emulator:build");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("build recipe uses independent cache/source/build locations, pinned sources and package-native files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "azahar-build-recipe-"));
  try {
    const bin = join(directory, "bin"), log = join(directory, "commands.jsonl");
    await mkdir(bin);
    await executable(join(bin, "uname"), '#!/bin/sh\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n');
    await executable(join(bin, "git"), `#!${process.execPath}
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
await appendFile(process.env.TEST_LOG, JSON.stringify({ tool: "git", args }) + "\\n");
if (args[0] === "clone") { const dir = args.at(-1); await mkdir(join(dir, ".git"), { recursive: true }); await mkdir(join(dir, "src/core/frontend"), { recursive: true }); }
if (args.includes("rev-parse")) console.log(process.env.TEST_REVISION ?? ${JSON.stringify(revision)});
`);
    await executable(join(bin, "cmake"), `#!${process.execPath}\nimport { appendFile } from "node:fs/promises"; await appendFile(process.env.TEST_LOG, JSON.stringify({ tool: "cmake", args: process.argv.slice(2) }) + "\\n");\n`);
    const cache = join(directory, "user cache");
    const env = { ...cleanEnvironment(), XDG_CACHE_HOME: cache, PATH: `${bin}:/usr/bin:/bin`, TEST_LOG: log };
    const first = await run(["/bin/bash", join(root, "scripts/build.sh")], env, directory);
    expect(first.code, first.stderr).toBe(0);
    const source = join(cache, "ludens/azahar/2126.2-rsa.3/source");
    const build = join(cache, "ludens/azahar/2126.2-rsa.3/build");
    expect(await readFile(join(source, "src/core/frontend/rsa_bridge.cpp"), "utf8")).toBe(await readFile(join(root, "native/rsa_bridge.cpp"), "utf8"));
    const commands = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { tool: string; args: string[] });
    expect(commands[0].args).toEqual(["clone", "--depth", "1", "--branch", "2126.2", "https://github.com/azahar-emu/azahar.git", source]);
    expect(commands.some(c => c.args.includes(join(root, "native/azahar.patch")))).toBe(true);
    expect(commands.find(c => c.tool === "cmake")!.args.slice(0, 4)).toEqual(["-S", source, "-B", build]);
    expect(commands.at(-1)!.args).toEqual(["--build", build, "--target", "bundle", "--parallel", "4"]);

    await writeFile(log, "");
    const customSource = join(directory, "alternate source"), customBuild = join(directory, "alternate build");
    const installedApp = join(directory, "Previously installed.app");
    await mkdir(installedApp);
    await writeFile(join(installedApp, "unchanged"), "existing application");
    const custom = await run(["/bin/bash", join(root, "scripts/build.sh")], {
      ...env, RSA_AZAHAR_SOURCE: customSource, RSA_AZAHAR_BUILD: customBuild, RSA_AZAHAR_APP: installedApp, RSA_BUILD_JOBS: "2",
    }, directory);
    expect(custom.code, custom.stderr).toBe(0);
    expect(custom.stdout).toContain(join(customBuild, "bundle/azahar.app"));
    expect(await readFile(join(installedApp, "unchanged"), "utf8")).toBe("existing application");
    expect(await readFile(log, "utf8")).not.toContain(installedApp);
    expect(await readFile(join(customSource, "src/core/frontend/rsa_bridge.h"), "utf8")).toBe(await readFile(join(root, "native/rsa_bridge.h"), "utf8"));
    await writeFile(log, "");
    const wrong = await run(["/bin/bash", join(root, "scripts/build.sh")], { ...env, TEST_REVISION: "wrong" }, directory);
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain(revision);
    expect(await readFile(log, "utf8")).not.toContain('"tool":"cmake"');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
