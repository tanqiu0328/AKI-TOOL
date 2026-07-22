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

test("浏览器预览可完成单项自定义烧录流程", async (context) => {
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

  const chooseFileButton = buttonByText(window.document, "选择固定 BIN");
  assert.ok(chooseFileButton);
  await act(async () => chooseFileButton.click());
  await waitFor(() => {
    const fileInput = window.document.querySelector("input[readonly]");
    assert.ok(fileInput);
    assert.equal(fileInput.value, "factory.bin");
  }, act);

  const addressInput = window.document.querySelector('input[aria-label="十六进制绝对地址"]');
  assert.ok(addressInput);
  await act(async () => setInputValue(window, addressInput, "0x1001"));
  assert.equal(confirmPreviewButton.disabled, true);
  await act(async () => setInputValue(window, addressInput, "0x10000"));
  assert.equal(confirmPreviewButton.disabled, false);

  await act(async () => confirmPreviewButton.click());
  assert.match(window.document.body.textContent ?? "", /确认摘要/);
  assert.match(window.document.body.textContent ?? "", /esp32/);
  assert.match(window.document.body.textContent ?? "", /COM3/);
  assert.match(window.document.body.textContent ?? "", /factory\.bin/);
  assert.match(window.document.body.textContent ?? "", /4\.00 KiB/);
  assert.match(window.document.body.textContent ?? "", /0x10000/);
  assert.match(window.document.body.textContent ?? "", /0x10fff/i);

  const runButton = buttonByText(window.document, "确认并烧录");
  assert.ok(runButton);
  await act(async () => runButton.click());
  assert.equal(addressInput.disabled, true);
  assert.ok(buttonByText(window.document, "停止"));
  await waitFor(
    () => assert.match(window.document.body.textContent ?? "", /浏览器预览模式未调用本机烧录后端/),
    act
  );
  await waitFor(() => assert.match(window.document.body.textContent ?? "", /执行完成/), act);
});
