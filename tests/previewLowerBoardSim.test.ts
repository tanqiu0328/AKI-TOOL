import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreviewLowerBoardSimHarness,
  previewLowerBoardSimConfig
} from "../src/previewLowerBoardSim.ts";
import type { LowerBoardSimFrameEvent, LowerBoardSimStatusEvent } from "../src/types.ts";
import { defineLowerBoardSimAdapterContract } from "./lowerBoardSimAdapterContract.ts";

defineLowerBoardSimAdapterContract(() => {
  const harness = createPreviewLowerBoardSimHarness({ autoInput: false });

  return {
    adapter: harness.adapter,
    initialConfig: previewLowerBoardSimConfig,
    receive: harness.receive,
    advanceBy: harness.advanceBy,
    flush: harness.flush
  };
});

async function runDeterministicPreview() {
  const harness = createPreviewLowerBoardSimHarness({ autoInput: false });
  const frames: LowerBoardSimFrameEvent[] = [];
  const statuses: LowerBoardSimStatusEvent[] = [];
  harness.adapter.onFrame((event) => frames.push(event));
  harness.adapter.onStatus((event) => statuses.push(event));

  await harness.adapter.start({
    ...previewLowerBoardSimConfig,
    responseDelayMs: 10,
    dropRatePercent: 40,
    badChecksumRatePercent: 40
  });
  await harness.emitNextCommand();
  await harness.emitNextCommand();
  await harness.emitNextCommand();
  await harness.adapter.stop();

  return {
    frames: frames.map((event) => ({
      direction: event.direction,
      frameType: event.frameType,
      hex: event.hex,
      message: event.message,
      command: event.command,
      statusFrame: event.statusFrame,
      timestamp: event.timestamp
    })),
    statuses: statuses.map((event) => ({
      status: event.status,
      running: event.running,
      message: event.message,
      stats: event.stats,
      timestamp: event.timestamp
    }))
  };
}

test("浏览器预览使用确定性输入、时钟和随机序列", async () => {
  const first = await runDeterministicPreview();
  const second = await runDeterministicPreview();

  assert.deepEqual(first, second);
  assert.ok(first.frames.some((event) => event.frameType === "command"));
  assert.ok(first.frames.some((event) => event.frameType === "status"));
  assert.ok(first.frames.some((event) => event.message.includes("丢包注入")));
  assert.ok(first.frames.some((event) => event.message.includes("坏校验")));
});
