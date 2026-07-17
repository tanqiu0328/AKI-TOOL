import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

function buttonByText(document, text) {
  return Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes(text));
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

test("浏览器预览可进入下板模拟并完成核心操作", async (context) => {
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

  const enterButton = buttonByText(window.document, "下板模拟");
  assert.ok(enterButton);
  await act(async () => enterButton.click());
  assert.equal(window.document.querySelector("h1")?.textContent, "下板模拟");

  await waitFor(() => {
    const startButton = buttonByText(window.document, "启动");
    assert.ok(startButton);
    assert.equal(startButton.disabled, false);
    return startButton;
  }, act).then(async (startButton) => {
    await act(async () => startButton.click());
  });
  await waitFor(() => assert.match(window.document.body.textContent ?? "", /运行中 COM9/), act);

  const applyButton = buttonByText(window.document, "应用配置");
  assert.ok(applyButton);
  await act(async () => applyButton.click());
  await waitFor(() => assert.match(window.document.body.textContent ?? "", /下板模拟配置已应用/), act);

  const resetButton = window.document.querySelector('button[title="复位统计"]');
  assert.ok(resetButton);
  await act(async () => resetButton.click());
  await waitFor(() => assert.match(window.document.body.textContent ?? "", /下板模拟统计已复位/), act);

  const stopButton = buttonByText(window.document, "停止");
  assert.ok(stopButton);
  await act(async () => stopButton.click());
  await waitFor(() => assert.match(window.document.body.textContent ?? "", /下板模拟已停止/), act);
});
