import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAzaharProvider } from "../src/provider.ts";
import type { ControllerContext, ToolArguments } from "../src/contracts.ts";
import { call } from "./driver-fixture.ts";

// Compile the real bridge with a simulated 4 ms HID consumer. No emulator,
// display, ROM or Baseware service is started; the driver is exercised directly.
const compiler = Bun.which("clang++");
const nativeTest = compiler && process.platform !== "win32" ? test : test.skip;
type Sample = { atMs: number; owned: number; buttons: number; touch: number };
async function until(check: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("Native bridge condition timed out");
    await Bun.sleep(2);
  }
}

nativeTest("native pad timing, caller cancellation, handback and disconnect preserve device semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ludens-azahar-native-"));
  const root = join(import.meta.dir, "..");
  const includes = join(directory, "include");
  let provider: Awaited<ReturnType<typeof createAzaharProvider>> | undefined;
  let processHandle: ReturnType<typeof Bun.spawn> | undefined;
  let reader: Promise<void> | undefined;
  let nativeError: Promise<string> | undefined;
  try {
    await mkdir(join(includes, "core/frontend"), { recursive: true });
    await copyFile(join(root, "native/rsa_bridge.h"), join(includes, "core/frontend/rsa_bridge.h"));
    const executable = join(directory, "azahar-pad");
    const build = Bun.spawn([compiler!, "-std=c++17", "-pthread", "-I", includes,
      join(import.meta.dir, "fixtures/azahar-pad.cpp"), join(root, "native/rsa_bridge.cpp"), "-o", executable],
      { stdout: "pipe", stderr: "pipe" });
    const buildError = await new Response(build.stderr).text();
    expect(await build.exited, buildError).toBe(0);
    const reservation = createServer();
    await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    const native = Bun.spawn([executable, String(port)], { stdout: "pipe", stderr: "pipe" });
    processHandle = native;
    nativeError = new Response(native.stderr).text();
    const samples: Sample[] = [];
    let ready = false;
    reader = (async () => {
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of native.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (line.ready) ready = true; else samples.push(line);
        }
      }
    })();
    await until(() => ready);
    provider = await createAzaharProvider({ port, clock: { id: "native-test", now: () => performance.now() } });
    const tool = (id: string) => provider!.capabilities.controllers.find(controller => controller.tool.name === id)!;
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const control = new AbortController();
    let epoch = "native-timeline";
    const context = (signal = new AbortController().signal): ControllerContext => ({ epoch, signal,
      controlSignal: control.signal, record: (type, data) => events.push({ type, data }) });
    const command = (id: string, args: ToolArguments, signal?: AbortSignal) => call(tool(id), args, context(signal));
    await tool("pad.play").acquire!(epoch);

    const begin = samples.length;
    const played = await command("pad.play", { inputs: [
      { atMs: 0, durationMs: 500, state: { LEFT: 1 } },
      { atMs: 0, durationMs: 300, state: { B: 1 } },
    ], wait: true });
    expect(JSON.parse(played.stdout)).toMatchObject({ status: "completed" });
    await until(() => samples.slice(begin).some(s => s.buttons === 256) && samples.at(-1)?.buttons === 0);
    const sampled = samples.slice(begin);
    const transitions = sampled.slice(sampled.findIndex(s => s.buttons === 258));
    expect(transitions.map(s => s.buttons)).toEqual([258, 256, 0]);
    expect(transitions[1].atMs - transitions[0].atMs).toBeGreaterThanOrEqual(300);
    expect(transitions[1].atMs - transitions[0].atMs).toBeLessThan(450);
    expect(transitions[2].atMs - transitions[0].atMs).toBeGreaterThanOrEqual(500);
    expect(transitions[2].atMs - transitions[0].atMs).toBeLessThan(650);

    const caller = new AbortController();
    const submitted = JSON.parse((await command("pad.play", { inputs: [
      { atMs: 0, durationMs: 5000, state: { LEFT: 1, B: 1 } },
    ] }, caller.signal)).stdout);
    expect(submitted.status).toBe("running");
    caller.abort(); // The submitter ends; the ownership lifetime remains active.
    await until(() => samples.at(-1)?.buttons === 258);
    const abort = new AbortController();
    const waiting = command("pad.wait", { actionId: submitted.actionId }, abort.signal).catch(error => error);
    await Bun.sleep(20);
    abort.abort();
    expect(await waiting).toBeInstanceOf(Error);
    expect(JSON.parse((await command("pad.status", { actionId: submitted.actionId })).stdout).status).toBe("running");
    expect(samples.at(-1)?.buttons).toBe(258);
    await command("touch.down", { x: 20, y: 30 });
    await until(() => samples.at(-1)?.touch === 1);
    await tool("pad.play").release!(epoch);
    await until(() => samples.at(-1)?.owned === 0 && samples.at(-1)?.buttons === 0 && samples.at(-1)?.touch === 0);
    const actionEvents = events.filter(event => event.data.actionId === submitted.actionId);
    expect(actionEvents.map(event => event.type)).toEqual(["action_start", "action_end"]);
    expect(actionEvents[1].data).toMatchObject({ status: "interrupted", exitCode: 130 });
    await expect(command("pad.state", {})).rejects.toThrow("STALE_EPOCH");

    epoch = "native-owner-disconnect";
    await tool("pad.play").acquire!(epoch);
    const disconnected = JSON.parse((await command("pad.play", { inputs: [
      { atMs: 0, durationMs: 5000, state: { A: 1 } },
    ] })).stdout);
    await command("touch.down", { x: 1, y: 1 });
    await until(() => samples.at(-1)?.buttons === 1 && samples.at(-1)?.touch === 1);
    provider.close();
    await until(() => samples.at(-1)?.owned === 0 && samples.at(-1)?.buttons === 0 && samples.at(-1)?.touch === 0);
    await until(() => events.some(event => event.type === "action_end" && event.data.actionId === disconnected.actionId));
    provider = await createAzaharProvider({ port, clock: { id: "reconnected", now: () => performance.now() } });
    epoch = "after-reconnect";
    await tool("pad.play").acquire!(epoch);
    expect(JSON.parse((await command("pad.state", {})).stdout)).toMatchObject({ actionId: null });
    expect(Object.values(JSON.parse((await command("pad.state", {})).stdout).state).every(value => value === 0)).toBe(true);
    await tool("pad.play").release!(epoch);
  } finally {
    provider?.close();
    processHandle?.kill();
    await processHandle?.exited;
    await reader;
    if (nativeError) expect(await nativeError).toBe("");
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
