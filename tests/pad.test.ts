import { expect, test } from "bun:test";
import { createPadPlayer } from "../src/pad.ts";
import type { Bridge } from "../src/bridge.ts";
import type { ControllerContext } from "../src/contracts.ts";

function fixture() {
  const pending = Promise.withResolvers<string[]>();
  const requests: { op: string; args: (string | number)[]; id?: string }[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const bridge = { request: (op: string, args: (string | number)[] = [], id?: string) => {
    requests.push({ op, args, id });
    if (op === "APPLY") return pending.promise;
    if (op === "STOP") pending.resolve(["interrupted", "1", "1"]);
    return Promise.resolve([]);
  } } as unknown as Bridge;
  const player = createPadPlayer({ bridge, clock: { id: "pad-fixture", now: () => performance.now() },
    encode: () => "encoded", decode: ([elapsedMs, polls]) => ({ elapsedMs: Number(elapsedMs), polls: Number(polls) }) });
  const caller = new AbortController(), control = new AbortController();
  const context: ControllerContext = { epoch: "owner", signal: caller.signal, controlSignal: control.signal,
    record: (type, data) => events.push({ type, data }) };
  return { player, pending, requests, events, caller, control, context };
}

test("ownership cancellation stops an asynchronous pad job after its submitting caller ends", async () => {
  const f = fixture();
  const submitted = JSON.parse((await f.player.execute("play", { inputs: [] }, f.context)).stdout);
  f.caller.abort();
  expect(f.requests.map(r => r.op)).toEqual(["APPLY"]);
  expect(() => f.player.reset()).toThrow("BUSY");
  await expect(f.player.execute("play", { inputs: [] }, { ...f.context, signal: new AbortController().signal })).rejects.toThrow("BUSY");
  f.control.abort();
  await f.player.settle();
  expect(f.requests[1]).toMatchObject({ op: "STOP", args: ["owner", submitted.actionId] });
  expect(f.events.map(e => e.type)).toEqual(["action_start", "action_end"]);
  expect(f.events[1].data).toMatchObject({ actionId: submitted.actionId, status: "interrupted", exitCode: 130 });
  f.player.reset();
  await expect(f.player.execute("status", { actionId: submitted.actionId }, {
    ...f.context, signal: new AbortController().signal,
  })).rejects.toThrow("Unknown action");
});

test("failed native replies remain queryable and cannot be read from another ownership epoch", async () => {
  const f = fixture();
  const submitted = JSON.parse((await f.player.execute("play", { inputs: [] }, f.context)).stdout);
  f.pending.reject(new Error("native bridge disconnected"));
  await f.player.settle();
  const wait = await f.player.execute("wait", { actionId: submitted.actionId }, f.context);
  expect(wait).toMatchObject({ status: "failed", exitCode: 1 });
  expect(wait.stderr).toContain("native bridge disconnected");
  expect(f.events[1].data).toMatchObject({ status: "failed" });
  await expect(f.player.execute("status", { actionId: submitted.actionId }, { ...f.context, epoch: "other" })).rejects.toThrow("Unknown action");
});

test("invalid native completion outcomes surface as failures and do not leave pad input busy", async () => {
  const f = fixture();
  const submitted = JSON.parse((await f.player.execute("play", { inputs: [] }, f.context)).stdout);
  f.pending.resolve(["unexpected"]);
  await f.player.settle();
  const waited = await f.player.execute("wait", { actionId: submitted.actionId }, f.context);
  expect(waited.status).toBe("failed");
  expect(waited.stderr).toContain("Unexpected action outcome");
  f.player.reset();
});
