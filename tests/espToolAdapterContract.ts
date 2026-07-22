import assert from "node:assert/strict";
import test from "node:test";
import type {
  EspActionFinishedEvent,
  EspActionOutputEvent,
  EspConfig,
  EspToolAdapter
} from "../shared/espToolContract.d.cts";

export type EspToolAdapterFixture = {
  adapter: EspToolAdapter;
  initialConfig: EspConfig;
  ports: string[];
  completeAction: (id: string) => Promise<void>;
};

export function defineEspToolAdapterContract(createFixture: () => EspToolAdapterFixture) {
  test("ESP 工具适配器契约统一配置持久化与串口列表", async () => {
    const fixture = createFixture();
    const initial = await fixture.adapter.getConfig();
    const ports = await fixture.adapter.listPorts();
    const nextConfig = { ...initial.config, baud: 921600 };
    const saved = await fixture.adapter.saveConfig(nextConfig);
    const reloaded = await fixture.adapter.getConfig();

    assert.deepEqual(initial.config, fixture.initialConfig);
    assert.ok(initial.configPath.length > 0);
    assert.ok(initial.toolDir.length > 0);
    assert.ok(initial.userDataDir.length > 0);
    assert.deepEqual(ports, fixture.ports);
    assert.deepEqual(saved.config, nextConfig);
    assert.ok(saved.configPath.length > 0);
    assert.deepEqual(reloaded.config, nextConfig);
  });

  test("ESP 工具适配器契约统一动作输出与完成事件", async () => {
    const fixture = createFixture();
    const outputEvents: EspActionOutputEvent[] = [];
    const finishedEvents: EspActionFinishedEvent[] = [];
    const offOutput = fixture.adapter.onActionOutput((event) => outputEvents.push(event));
    const offFinished = fixture.adapter.onActionFinished((event) => finishedEvents.push(event));

    const action = await fixture.adapter.runAction("Doctor", fixture.initialConfig);
    await fixture.completeAction(action.id);

    assert.ok(action.id.length > 0);
    assert.ok(outputEvents.length > 0);
    assert.ok(outputEvents.every((event) => event.id === action.id));
    assert.ok(outputEvents.some((event) => event.stream === "stdout" && event.text.length > 0));
    assert.deepEqual(finishedEvents, [{ id: action.id, exitCode: 0, signal: null }]);

    offOutput();
    offFinished();
    const eventCount = outputEvents.length + finishedEvents.length;
    const nextAction = await fixture.adapter.runAction("Build", fixture.initialConfig);
    await fixture.completeAction(nextAction.id);
    assert.equal(outputEvents.length + finishedEvents.length, eventCount);
  });

  test("ESP 工具适配器契约统一动作停止语义", async () => {
    const fixture = createFixture();
    const outputEvents: EspActionOutputEvent[] = [];
    const finishedEvents: EspActionFinishedEvent[] = [];
    fixture.adapter.onActionOutput((event) => outputEvents.push(event));
    fixture.adapter.onActionFinished((event) => finishedEvents.push(event));

    const action = await fixture.adapter.runAction("Monitor", fixture.initialConfig);
    const stopped = await fixture.adapter.stopAction();

    assert.equal(stopped, true);
    assert.ok(outputEvents.some((event) => event.id === action.id && event.stream === "stderr"));
    assert.deepEqual(finishedEvents, [{ id: action.id, exitCode: null, signal: "SIGTERM" }]);
    assert.equal(await fixture.adapter.stopAction(), false);
  });
}
