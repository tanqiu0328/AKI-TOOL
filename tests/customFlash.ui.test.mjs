import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

function buttonByText(document, text) {
  return Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
}

function setInputValue(window, input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function waitFor(assertion, act, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  throw lastError;
}

test("浏览器预览可编辑并批量执行多个自定义烧录项", async (context) => {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://127.0.0.1/"
  });
  const { window } = dom;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    navigator: { configurable: true, value: window.navigator },
    HTMLElement: { configurable: true, value: window.HTMLElement },
    Node: { configurable: true, value: window.Node },
    Event: { configurable: true, value: window.Event },
    MouseEvent: { configurable: true, value: window.MouseEvent },
    MutationObserver: { configurable: true, value: window.MutationObserver },
    getComputedStyle: { configurable: true, value: window.getComputedStyle.bind(window) },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true }
  });

  const vite = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true }
  });
  const [{ default: React, act }, { createRoot }, { default: App }] = await Promise.all([
    import("react"),
    import("react-dom/client"),
    vite.ssrLoadModule("/src/App.tsx")
  ]);
  const rootElement = window.document.getElementById("root");
  assert.ok(rootElement);
  const root = createRoot(rootElement);

  context.after(async () => {
    await act(async () => root.unmount());
    await vite.close();
    dom.window.close();
  });

  await act(async () => {
    root.render(React.createElement(App));
    await Promise.resolve();
  });

  const customModeButton = buttonByText(window.document, "自定义烧录");
  assert.ok(customModeButton);
  await act(async () => customModeButton.click());

  const confirmPreviewButton = buttonByText(window.document, "查看确认摘要");
  assert.ok(confirmPreviewButton);
  assert.equal(confirmPreviewButton.disabled, true);

  const firstNameInput = window.document.querySelector('input[aria-label="烧录项 1 名称"]');
  const firstAddressInput = window.document.querySelector('input[aria-label="烧录项 1 十六进制绝对地址"]');
  const firstFileButton = window.document.querySelector('button[aria-label="烧录项 1 选择固定 BIN"]');
  assert.ok(firstNameInput);
  assert.ok(firstAddressInput);
  assert.ok(firstFileButton);
  await act(async () => setInputValue(window, firstNameInput, "出厂数据"));
  await act(async () => firstFileButton.click());

  const addButton = buttonByText(window.document, "添加烧录项");
  assert.ok(addButton);
  await act(async () => addButton.click());
  assert.equal(window.document.querySelectorAll(".custom-flash-item").length, 2);

  const secondNameInput = window.document.querySelector('input[aria-label="烧录项 2 名称"]');
  const secondAddressInput = window.document.querySelector('input[aria-label="烧录项 2 十六进制绝对地址"]');
  const secondFileButton = window.document.querySelector('button[aria-label="烧录项 2 选择固定 BIN"]');
  assert.ok(secondNameInput);
  assert.ok(secondAddressInput);
  assert.ok(secondFileButton);
  await act(async () => setInputValue(window, secondNameInput, "设备配置"));
  await act(async () => setInputValue(window, secondAddressInput, "0x11000"));
  await act(async () => secondFileButton.click());

  await act(async () => addButton.click());
  assert.equal(window.document.querySelectorAll(".custom-flash-item").length, 3);
  const deleteThirdButton = window.document.querySelector('button[aria-label="删除烧录项 3"]');
  assert.ok(deleteThirdButton);
  await act(async () => deleteThirdButton.click());
  assert.equal(window.document.querySelectorAll(".custom-flash-item").length, 2);

  const enabledInputs = window.document.querySelectorAll('input[type="checkbox"][aria-label*="临时启用"]');
  assert.equal(enabledInputs.length, 2);
  await act(async () => {
    enabledInputs[0].click();
    enabledInputs[1].click();
  });
  assert.equal(confirmPreviewButton.disabled, true);
  await act(async () => {
    enabledInputs[0].click();
    enabledInputs[1].click();
  });

  await act(async () => setInputValue(window, secondAddressInput, "0x10000"));
  await act(async () => confirmPreviewButton.click());
  await waitFor(() => {
    const alert = window.document.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent ?? "", /出厂数据/);
    assert.match(alert.textContent ?? "", /设备配置/);
    assert.match(alert.textContent ?? "", /地址范围重叠/);
  }, act);

  await act(async () => setInputValue(window, secondAddressInput, "0x11000"));
  await act(async () => confirmPreviewButton.click());
  const summary = window.document.querySelector('[aria-label="确认摘要"]');
  assert.ok(summary);
  assert.equal(summary.querySelectorAll(".custom-flash-summary-item").length, 2);
  assert.match(summary.textContent ?? "", /esp32/);
  assert.match(summary.textContent ?? "", /COM3/);
  assert.match(summary.textContent ?? "", /出厂数据/);
  assert.match(summary.textContent ?? "", /设备配置/);
  assert.match(summary.textContent ?? "", /4\.00 KiB/);
  assert.match(summary.textContent ?? "", /0x10000/);
  assert.match(summary.textContent ?? "", /0x10fff/i);
  assert.match(summary.textContent ?? "", /0x11000/);
  assert.match(summary.textContent ?? "", /0x11fff/i);

  await act(async () => enabledInputs[0].click());
  assert.equal(window.document.querySelector('[aria-label="确认摘要"]'), null);
  await act(async () => confirmPreviewButton.click());
  const enabledOnlySummary = window.document.querySelector('[aria-label="确认摘要"]');
  assert.ok(enabledOnlySummary);
  assert.equal(enabledOnlySummary.querySelectorAll(".custom-flash-summary-item").length, 1);
  assert.doesNotMatch(enabledOnlySummary.textContent ?? "", /出厂数据/);
  await act(async () => enabledInputs[0].click());
  await act(async () => confirmPreviewButton.click());

  const runButton = buttonByText(window.document, "确认并烧录");
  assert.ok(runButton);
  await act(async () => runButton.click());
  assert.equal(firstAddressInput.disabled, true);
  assert.ok(buttonByText(window.document, "停止"));
  await waitFor(
    () => assert.match(window.document.body.textContent ?? "", /浏览器预览模式未调用本机烧录后端/),
    act
  );
  await waitFor(() => assert.match(window.document.body.textContent ?? "", /执行完成/), act);
});
