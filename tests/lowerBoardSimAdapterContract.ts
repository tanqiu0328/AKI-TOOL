import assert from "node:assert/strict";
import test from "node:test";
import type {
  AkiApi,
  LowerBoardSimConfig,
  LowerBoardSimFrameEvent,
  LowerBoardSimStatusEvent
} from "../src/types.ts";

export type LowerBoardSimAdapter = AkiApi["lowerBoardSim"];

export type LowerBoardSimAdapterFixture = {
  adapter: LowerBoardSimAdapter;
  initialConfig: LowerBoardSimConfig;
  receive: (data: Uint8Array) => void;
  advanceBy: (milliseconds: number) => void;
  flush: () => Promise<void>;
};

export function defineLowerBoardSimAdapterContract(createFixture: () => LowerBoardSimAdapterFixture) {
  test("下板模拟适配器契约统一配置持久化与串口列表", async () => {
    const fixture = createFixture();
    const initial = await fixture.adapter.getConfig();
    const ports = await fixture.adapter.listPorts();
    const nextConfig = { ...initial.config, busVoltageV: 321 };
    const saved = await fixture.adapter.saveConfig(nextConfig);
    const reloaded = await fixture.adapter.getConfig();

    assert.deepEqual(initial.config, fixture.initialConfig);
    assert.ok(initial.configPath.length > 0);
    assert.ok(ports.some((port) => port.path === fixture.initialConfig.port));
    assert.deepEqual(saved.config, nextConfig);
    assert.deepEqual(reloaded.config, nextConfig);
  });

  test("下板模拟适配器契约统一生命周期状态与统计事件", async () => {
    const fixture = createFixture();
    const statuses: LowerBoardSimStatusEvent[] = [];
    const unsubscribe = fixture.adapter.onStatus((event) => statuses.push(event));
    const started = await fixture.adapter.start(fixture.initialConfig);
    const updated = await fixture.adapter.updateConfig({ ...fixture.initialConfig, boardTemperatureC: 42 });
    const reset = await fixture.adapter.resetStats();
    const stopped = await fixture.adapter.stop();

    assert.deepEqual(
      [started.status, updated.status, reset.status, stopped.status],
      ["open", "open", "open", "closed"]
    );
    assert.equal(updated.config.boardTemperatureC, 42);
    assert.equal(reset.stats.commandFrames, 0);
    assert.ok(statuses.some((event) => event.status === "open"));
    assert.equal(statuses.at(-1)?.status, "closed");

    const eventCount = statuses.length;
    unsubscribe();
    await fixture.adapter.stop();
    assert.equal(statuses.length, eventCount);
  });

  test("下板模拟适配器契约统一命令帧与状态帧事件", async () => {
    const fixture = createFixture();
    const frames: LowerBoardSimFrameEvent[] = [];
    const unsubscribe = fixture.adapter.onFrame((event) => frames.push(event));

    await fixture.adapter.start(fixture.initialConfig);
    fixture.receive(Uint8Array.from([0x5a, 0xa5, 0x02, 0x01, 0x05, 0xdc, 0x00, 0x00, 0x25]));
    fixture.advanceBy(fixture.initialConfig.responseDelayMs);
    await fixture.flush();

    assert.deepEqual(
      frames.map((event) => [event.direction, event.frameType]),
      [
        ["rx", "command"],
        ["tx", "status"]
      ]
    );
    assert.equal(frames[1]?.statusFrame?.deviceType, fixture.initialConfig.deviceType);
    unsubscribe();
  });
}
