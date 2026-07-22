import assert from "node:assert/strict";
import test from "node:test";
import type {
  CustomFlashFileInspection,
  CustomFlashPlan,
  CustomFlashRequestItem,
  EspActionFinishedEvent,
  EspActionOutputEvent,
  EspConfig,
  EspToolAdapter
} from "../shared/espToolContract.d.cts";

export type EspToolAdapterFixture = {
  adapter: EspToolAdapter;
  initialConfig: EspConfig;
  ports: string[];
  customFlashItems: CustomFlashRequestItem[];
  customFlashInspections: CustomFlashFileInspection[];
  completeAction: (id: string) => Promise<void>;
};

export function defineEspToolAdapterContract(createFixture: () => EspToolAdapterFixture) {
  test("ESP 工具适配器契约仅在显式保存时持久化自定义烧录方案", async () => {
    const fixture = createFixture();
    const plan: CustomFlashPlan = {
      id: "factory-plan",
      name: "出厂烧录",
      items: [
        {
          id: "factory-data",
          name: "出厂数据",
          address: "0x10000",
          defaultEnabled: true,
          fileSource: { kind: "fixed", filePath: "C:\\images\\factory.bin" }
        }
      ]
    };

    await fixture.adapter.saveCustomFlashPlan(plan);
    assert.deepEqual(await fixture.adapter.listCustomFlashPlans(), [plan]);

    const unsavedDraft = { ...plan, name: "尚未保存的名称" };
    assert.deepEqual(await fixture.adapter.listCustomFlashPlans(), [plan]);

    await fixture.adapter.saveCustomFlashPlan(unsavedDraft);
    assert.deepEqual(await fixture.adapter.listCustomFlashPlans(), [unsavedDraft]);

    const copiedPlan = { ...unsavedDraft, id: "factory-plan-copy", name: "出厂烧录副本" };
    await fixture.adapter.saveCustomFlashPlan(copiedPlan);
    assert.deepEqual(await fixture.adapter.listCustomFlashPlans(), [unsavedDraft, copiedPlan]);

    await fixture.adapter.deleteCustomFlashPlan(plan.id);
    assert.deepEqual(await fixture.adapter.listCustomFlashPlans(), [copiedPlan]);
  });

  test("ESP 工具适配器契约隔离方案默认值与本次执行选择", async () => {
    const fixture = createFixture();
    const plan: CustomFlashPlan = {
      id: "mixed-source-plan",
      name: "混合来源方案",
      items: [
        {
          id: "fixed-item",
          name: "固定文件",
          address: "0x10000",
          defaultEnabled: true,
          fileSource: { kind: "fixed", filePath: "C:\\images\\fixed.bin" }
        },
        {
          id: "prompt-item",
          name: "每次选择文件",
          address: "0x12000",
          defaultEnabled: false,
          fileSource: { kind: "prompt" }
        }
      ]
    };
    await fixture.adapter.saveCustomFlashPlan(plan);

    const outputEvents: EspActionOutputEvent[] = [];
    fixture.adapter.onActionOutput((event) => outputEvents.push(event));
    const action = await fixture.adapter.runCustomFlash({
      config: fixture.initialConfig,
      items: [
        {
          name: plan.items[0].name,
          filePath: plan.items[0].fileSource.kind === "fixed" ? plan.items[0].fileSource.filePath : "",
          address: plan.items[0].address,
          enabled: false,
          expectedFileSize: 4096
        },
        {
          name: plan.items[1].name,
          filePath: "C:\\runtime\\chosen.bin",
          address: plan.items[1].address,
          enabled: true,
          expectedFileSize: 4096
        }
      ]
    });
    await fixture.completeAction(action.id);

    assert.ok(outputEvents.some((event) => event.text.includes("每次选择文件")));
    assert.ok(outputEvents.every((event) => !event.text.includes("固定文件")));
    assert.deepEqual(await fixture.adapter.listCustomFlashPlans(), [plan]);
  });

  test("ESP 工具适配器契约拒绝保存使用相对路径的固定文件来源", async () => {
    const fixture = createFixture();
    const plan: CustomFlashPlan = {
      id: "relative-source-plan",
      name: "无效方案",
      items: [
        {
          id: "relative-item",
          name: "相对路径文件",
          address: "0x10000",
          defaultEnabled: true,
          fileSource: { kind: "fixed", filePath: "images\\factory.bin" }
        }
      ]
    };

    await assert.rejects(fixture.adapter.saveCustomFlashPlan(plan), /绝对路径/);
  });

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

  test("ESP 工具适配器契约统一多项自定义烧录的一次提交", async () => {
    const fixture = createFixture();
    const outputEvents: EspActionOutputEvent[] = [];
    const finishedEvents: EspActionFinishedEvent[] = [];
    fixture.adapter.onActionOutput((event) => outputEvents.push(event));
    fixture.adapter.onActionFinished((event) => finishedEvents.push(event));

    const inspections = await Promise.all(
      fixture.customFlashItems.map((item) => fixture.adapter.inspectCustomFlashFile(item.filePath))
    );
    const action = await fixture.adapter.runCustomFlash({
      config: fixture.initialConfig,
      items: fixture.customFlashItems
    });
    await fixture.completeAction(action.id);

    assert.deepEqual(inspections, fixture.customFlashInspections);
    for (const item of fixture.customFlashItems) {
      assert.ok(outputEvents.some((event) => event.id === action.id && event.text.includes(item.name)));
      assert.ok(outputEvents.some((event) => event.id === action.id && event.text.includes(item.address)));
    }
    assert.deepEqual(finishedEvents, [{ id: action.id, exitCode: 0, signal: null }]);
  });

  test("ESP 工具适配器契约提交编辑后的多个自定义烧录项", async () => {
    const fixture = createFixture();
    const outputEvents: EspActionOutputEvent[] = [];
    fixture.adapter.onActionOutput((event) => outputEvents.push(event));
    const editedItems = fixture.customFlashItems.map((item, index) => ({
      ...item,
      name: `${item.name}-已编辑`,
      address: index === 0 ? "0x20000" : "0x24000"
    }));

    const action = await fixture.adapter.runCustomFlash({ config: fixture.initialConfig, items: editedItems });
    await fixture.completeAction(action.id);

    for (const item of editedItems) {
      assert.ok(outputEvents.some((event) => event.id === action.id && event.text.includes(item.name)));
      assert.ok(outputEvents.some((event) => event.id === action.id && event.text.includes(item.address)));
    }
  });

  test("ESP 工具适配器契约只提交临时启用的自定义烧录项", async () => {
    const fixture = createFixture();
    const outputEvents: EspActionOutputEvent[] = [];
    fixture.adapter.onActionOutput((event) => outputEvents.push(event));
    const [enabledItem, disabledItem] = fixture.customFlashItems;

    const action = await fixture.adapter.runCustomFlash({
      config: fixture.initialConfig,
      items: [enabledItem, { ...disabledItem, enabled: false }]
    });
    await fixture.completeAction(action.id);

    assert.ok(outputEvents.some((event) => event.id === action.id && event.text.includes(enabledItem.name)));
    assert.ok(outputEvents.every((event) => !event.text.includes(disabledItem.name)));
  });

  test("ESP 工具适配器契约拒绝没有启用项的自定义烧录", async () => {
    const fixture = createFixture();

    await assert.rejects(
      fixture.adapter.runCustomFlash({
        config: fixture.initialConfig,
        items: fixture.customFlashItems.map((item) => ({ ...item, enabled: false }))
      }),
      /至少启用一个自定义烧录项/
    );
    assert.equal(await fixture.adapter.stopAction(), false);
  });

  test("ESP 工具适配器契约拒绝零字节自定义烧录项", async () => {
    const fixture = createFixture();

    await assert.rejects(
      fixture.adapter.runCustomFlash({
        config: fixture.initialConfig,
        items: [{ ...fixture.customFlashItems[0], expectedFileSize: 0 }]
      }),
      /文件大小必须大于 0 字节/
    );
  });

  test("ESP 工具适配器契约明确拒绝启用项的半开地址范围重叠", async () => {
    const fixture = createFixture();
    const [firstItem, secondItem] = fixture.customFlashItems;

    await assert.rejects(
      fixture.adapter.runCustomFlash({
        config: fixture.initialConfig,
        items: [firstItem, { ...secondItem, address: firstItem.address }]
      }),
      (error) => {
        assert.match(String(error), /地址范围重叠/);
        assert.match(String(error), new RegExp(firstItem.name));
        assert.match(String(error), new RegExp(secondItem.name));
        return true;
      }
    );
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
