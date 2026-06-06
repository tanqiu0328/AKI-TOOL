import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const args = new Set(process.argv.slice(2));
const target = args.has("--electron") ? "electron" : args.has("--packaged") ? "packaged" : "preview";
const port = Number(process.env.AKI_SMOKE_PORT || (target === "preview" ? 9224 : 9225));
let pageUrl = pathToFileURL(path.join(repoRoot, "dist", "index.html")).href;
const userDataDir = path.join(os.tmpdir(), `aki-tool-smoke-${target}-${port}`);
const debug = process.env.AKI_SMOKE_DEBUG === "1" || args.has("--debug");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandForTarget() {
  if (target === "preview") {
    if (!fs.existsSync(edgePath)) {
      throw new Error(`找不到 Edge: ${edgePath}`);
    }

    return {
      command: edgePath,
      args: [
        "--headless=new",
        "--disable-gpu",
        "--disable-gpu-sandbox",
        "--disable-gpu-compositing",
        "--disable-software-rasterizer",
        "--disable-accelerated-2d-canvas",
        "--disable-dev-shm-usage",
        "--use-angle=swiftshader",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1360,900",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        pageUrl
      ]
    };
  }

  if (target === "packaged") {
    const packagedExe = path.join(repoRoot, "release", "win-unpacked", "AKI-TOOL.exe");
    if (!fs.existsSync(packagedExe)) {
      throw new Error(`找不到已解包程序: ${packagedExe}`);
    }

    return {
      command: packagedExe,
      args: [`--remote-debugging-port=${port}`]
    };
  }

  const electronExe = path.join(repoRoot, "node_modules", "electron", "dist", "electron.exe");
  if (!fs.existsSync(electronExe)) {
    throw new Error(`找不到 Electron: ${electronExe}`);
  }

  return {
    command: electronExe,
    args: [`--remote-debugging-port=${port}`, "."]
  };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".svg") {
    return "image/svg+xml";
  }
  if (ext === ".png") {
    return "image/png";
  }

  return "application/octet-stream";
}

function startStaticServer(rootDir) {
  const root = path.resolve(rootDir);

  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(requestUrl.pathname);
      const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(root, relativePath);

      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }

      fs.readFile(filePath, (error, data) => {
        if (error) {
          response.writeHead(404);
          response.end("Not found");
          return;
        }

        response.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
        response.end(data);
      });
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("静态预览服务启动失败。"));
        return;
      }

      resolve({ server, port: address.port });
    });
  });
}

async function waitForJsonList() {
  const endpoint = `http://127.0.0.1:${port}/json/list`;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
        if (page) {
          return page;
        }
      }
    } catch {
      // Browser is still starting.
    }

    await sleep(250);
  }

  throw new Error(`CDP 端口无响应: ${endpoint}`);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.socket = new RawWebSocket(webSocketUrl, (data) => this.handleMessage(data));
  }

  async open() {
    await this.socket.open();
  }

  handleMessage(data) {
    if (debug) {
      console.error(`CDP <= ${data.slice(0, 160)}`);
    }

    const message = JSON.parse(data);
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(message.error.message));
      } else {
        resolve(message.result);
      }
      return;
    }

    this.events.push(message);
  }

  call(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, timeoutMs);
    });
  }

  async eval(expression, options = {}) {
    const result = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      ...options
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }

    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

class RawWebSocket {
  constructor(webSocketUrl, onMessage) {
    this.url = new URL(webSocketUrl);
    this.onMessage = onMessage;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshaken = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      this.socket = net.createConnection(Number(this.url.port || 80), this.url.hostname);

      const fail = (error) => reject(error);
      this.socket.once("error", fail);
      this.socket.on("error", () => {
        // The browser often resets the CDP socket while the test process is cleaning up.
      });
      this.socket.once("connect", () => {
        this.socket.write(
          [
            `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
            `Host: ${this.url.host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            ""
          ].join("\r\n")
        );
      });

      this.socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        if (!this.handshaken) {
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) {
            return;
          }

          const header = this.buffer.subarray(0, headerEnd).toString("utf8");
          if (!header.includes(" 101 ")) {
            reject(new Error(`WebSocket 握手失败: ${header.split("\r\n")[0]}`));
            return;
          }

          this.handshaken = true;
          this.socket.off("error", fail);
          this.buffer = this.buffer.subarray(headerEnd + 4);
          resolve();
        }

        this.readFrames();
      });
    });
  }

  send(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = crypto.randomBytes(4);
    const header = [];

    header.push(0x81);
    if (payload.length < 126) {
      header.push(0x80 | payload.length);
    } else if (payload.length <= 0xffff) {
      header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
    } else {
      const length = BigInt(payload.length);
      header.push(
        0x80 | 127,
        Number((length >> 56n) & 0xffn),
        Number((length >> 48n) & 0xffn),
        Number((length >> 40n) & 0xffn),
        Number((length >> 32n) & 0xffn),
        Number((length >> 24n) & 0xffn),
        Number((length >> 16n) & 0xffn),
        Number((length >> 8n) & 0xffn),
        Number(length & 0xffn)
      );
    }

    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }

    this.socket.write(Buffer.concat([Buffer.from(header), mask, masked]));
  }

  readFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let offset = 2;
      let length = second & 0x7f;

      if (length === 126) {
        if (this.buffer.length < offset + 2) {
          return;
        }
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) {
          return;
        }
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("WebSocket 帧过大");
        }
        length = Number(bigLength);
        offset += 8;
      }

      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) {
        offset += 4;
      }

      if (this.buffer.length < offset + length) {
        return;
      }

      let payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);

      if (mask) {
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x1) {
        if (debug) {
          console.error(`WS text frame: ${payload.length} bytes`);
        }
        this.onMessage(payload.toString("utf8"));
      } else if (opcode === 0x8) {
        this.close();
        return;
      }
    }
  }

  close() {
    this.socket?.end();
  }
}

async function waitForApp(client) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await client.eval(`Boolean(document.querySelector(".app-shell"))`);
    if (ready) {
      return;
    }
    await sleep(250);
  }

  throw new Error("UI 未加载 .app-shell");
}

async function main() {
  let staticPreview = null;
  if (target === "preview") {
    staticPreview = await startStaticServer(path.join(repoRoot, "dist"));
    pageUrl = `http://127.0.0.1:${staticPreview.port}/index.html`;
  }

  const launch = commandForTarget();
  const child = spawn(launch.command, launch.args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: target === "preview"
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const cleanup = async () => {
    if (child.pid && child.exitCode === null) {
      try {
        if (process.platform === "win32") {
          await new Promise((resolve) => {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true
            });
            killer.once("exit", resolve);
            killer.once("error", resolve);
          });
        } else {
          child.kill();
        }
      } catch {
        // Already exited.
      }

      await new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", resolve);
        setTimeout(resolve, 1200);
      });
    }

    if (process.platform === "win32") {
      const escapedUserDataDir = userDataDir.replace(/'/g, "''");
      const escapedPort = String(port).replace(/'/g, "''");
      await new Promise((resolve) => {
        const cleaner = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            [
              "$processes = Get-CimInstance Win32_Process -Filter \"name = 'msedge.exe'\" |",
              `Where-Object { $_.CommandLine -like '*${escapedUserDataDir}*' -or $_.CommandLine -like '*remote-debugging-port=${escapedPort}*' };`,
              "$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
            ].join(" ")
          ],
          {
            stdio: "ignore",
            windowsHide: true
          }
        );
        cleaner.once("exit", resolve);
        cleaner.once("error", resolve);
      });
    }

    await new Promise((resolve) => {
      staticPreview?.server.close(() => resolve());
      if (!staticPreview) {
        resolve();
      }
    });
  };

  try {
    const page = await waitForJsonList();
    if (debug) {
      console.error(`CDP target: ${page.type} ${page.url} ${page.webSocketDebuggerUrl}`);
    }
    const client = new CdpClient(page.webSocketDebuggerUrl);
    await client.open();
    await client.call("Runtime.enable");
    await client.call("Page.enable");
    await client.call("Emulation.setDeviceMetricsOverride", {
      width: 1360,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    await waitForApp(client);

    await client.eval(`
      window.__akiSmoke = { errors: [], rejections: [] };
      window.addEventListener("error", (event) => {
        window.__akiSmoke.errors.push(String(event.error?.message || event.message || event.type));
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__akiSmoke.rejections.push(String(event.reason?.message || event.reason || event.type));
      });
    `);

    const before = await client.eval(`
      Array.from(document.querySelectorAll("button")).map((button, index) => ({
        index,
        text: button.innerText.trim(),
        title: button.title,
        disabled: button.disabled,
        className: button.className
      }))
    `);

    const result = await client.eval(`
      (async () => {
      async function waitFor(condition, timeoutMs = 3000) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          if (condition()) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return false;
      }

      function clickTool(match) {
        const button = Array.from(document.querySelectorAll(".tool-nav-item")).find((item) => item.innerText.includes(match));
        if (!button) {
          return false;
        }
        button.click();
        return true;
      }

      async function clickButton(match) {
        const buttons = Array.from(document.querySelectorAll("button"));
        const button = buttons.find((item) => item.innerText.trim().includes(match) || item.title.includes(match));
        if (!button) {
          return { match, found: false };
        }

        const statusBefore = document.querySelector(".sidebar-footer span")?.textContent || "";
        const logBefore = document.querySelector(".terminal-output")?.textContent || "";
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const statusAfter = document.querySelector(".sidebar-footer span")?.textContent || "";
        const logAfter = document.querySelector(".terminal-output")?.textContent || "";
        return {
          match,
          found: true,
          disabled: button.disabled,
          statusBefore,
          statusAfter,
          logChanged: logAfter !== logBefore,
          logLength: logAfter.length
        };
      }

      clickTool("ESP 烧录");
      await waitFor(() => Boolean(document.querySelector(".workspace-grid")));

      const clicks = [];
      for (const match of ["刷新串口", "保存配置", "环境检查", "停止", "清空日志", "复制日志", "用户数据", "后端目录"]) {
        clicks.push(await clickButton(match));
      }

      function setCheckbox(labelText, checked) {
        const label = Array.from(document.querySelectorAll("label")).find((item) => item.textContent.includes(labelText));
        const input = label?.querySelector("input[type='checkbox']");
        if (!input) {
          return false;
        }
        if (input.checked !== checked) {
          input.click();
        }
        return true;
      }

      function pressTerminalKey(target, key) {
        target.dispatchEvent(new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true
        }));
      }

      const serialChecks = {
        foundTool: clickTool("串口助手"),
        loaded: false,
        controlHasNoInternalScroll: false,
        sendPanelBeforeTerminal: false,
        sendPanelHiddenInTerminal: false,
        draftBeforeEnter: "",
        statusChangedAfterEnter: false,
        counterChangedAfterEnter: false,
        controlMetrics: null,
        failures: []
      };

      if (serialChecks.foundTool) {
        serialChecks.loaded = await waitFor(() => Boolean(document.querySelector(".serial-layout")));
      }

      if (serialChecks.loaded) {
        setCheckbox("终端模式", false);
        await waitFor(() => !document.querySelector(".serial-terminal-panel")?.classList.contains("terminal-mode"));

        const control = document.querySelector(".serial-control-panel");
        serialChecks.controlHasNoInternalScroll = Boolean(control && control.scrollHeight <= control.clientHeight + 1);
        serialChecks.controlMetrics = control
          ? {
              scrollHeight: control.scrollHeight,
              clientHeight: control.clientHeight,
              childCount: control.children.length
            }
          : null;
        serialChecks.sendPanelBeforeTerminal = Boolean(document.querySelector(".serial-send-panel"));

        setCheckbox("终端模式", true);
        if (${JSON.stringify(target)} === "preview") {
          setCheckbox("自动打开串口", true);
        }
        await waitFor(() => document.querySelector(".serial-terminal-panel")?.classList.contains("terminal-mode"));

        const terminal = document.querySelector(".serial-receive-output");
        serialChecks.sendPanelHiddenInTerminal = !document.querySelector(".serial-send-panel");

        if (terminal) {
          terminal.focus();
          for (const key of ["h", "e", "l", "x", "Backspace", "p"]) {
            pressTerminalKey(terminal, key);
          }
          await waitFor(() => (document.querySelector(".serial-terminal-draft-line")?.textContent || "") === "help");
          serialChecks.draftBeforeEnter = document.querySelector(".serial-terminal-draft-line")?.textContent || "";

          const statusBefore = document.querySelector(".terminal-toolbar p")?.textContent || "";
          const counterBefore = document.querySelector(".serial-counter-bar")?.textContent || "";
          pressTerminalKey(terminal, "Enter");
          await new Promise((resolve) => setTimeout(resolve, 900));
          const statusAfter = document.querySelector(".terminal-toolbar p")?.textContent || "";
          const counterAfter = document.querySelector(".serial-counter-bar")?.textContent || "";
          serialChecks.statusChangedAfterEnter = statusAfter !== statusBefore;
          serialChecks.counterChangedAfterEnter = counterAfter !== counterBefore;
        }
      }

      if (!serialChecks.foundTool) {
        serialChecks.failures.push("串口助手导航不存在");
      }
      if (!serialChecks.loaded) {
        serialChecks.failures.push("串口助手页面未加载");
      }
      if (!serialChecks.controlHasNoInternalScroll) {
        serialChecks.failures.push("串口设置栏在 1360x900 下出现内部滚动");
      }
      if (!serialChecks.sendPanelBeforeTerminal) {
        serialChecks.failures.push("非终端模式下发送框未显示");
      }
      if (!serialChecks.sendPanelHiddenInTerminal) {
        serialChecks.failures.push("终端模式下发送框未隐藏");
      }
      if (serialChecks.draftBeforeEnter !== "help") {
        serialChecks.failures.push("终端窗口键盘输入未形成 help 草稿");
      }
      if (!serialChecks.statusChangedAfterEnter && !serialChecks.counterChangedAfterEnter) {
        serialChecks.failures.push("终端 Enter 发送后没有状态或计数反馈");
      }

      return {
        target: ${JSON.stringify(target)},
        hasDesktopApi: Boolean(window.aki),
        buttonCount: document.querySelectorAll("button").length,
        buttons: [],
        clicks,
        serialChecks,
        smokeErrors: window.__akiSmoke
      };
      })()
    `);

    result.buttons = before;

    const cdpExceptions = client.events
      .filter((event) => event.method === "Runtime.exceptionThrown")
      .map((event) => event.params?.exceptionDetails?.text || "Runtime exception");

    result.cdpExceptions = cdpExceptions;
    result.stderr = stderr.trim();

    const screenshotOutput = process.env.AKI_SMOKE_SCREENSHOT;
    if (screenshotOutput) {
      const screenshotPath = path.resolve(repoRoot, screenshotOutput);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      const screenshot = await client.call("Page.captureScreenshot", {
        format: "png",
        fromSurface: true
      });
      fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
      result.screenshot = screenshotPath;
    }

    client.close();
    await cleanup();

    console.log(JSON.stringify(result, null, 2));

    const failedClicks = result.clicks.filter((item) => !item.found || (!item.disabled && item.statusBefore === item.statusAfter && !item.logChanged));
    const failures = [
      ...failedClicks.map((item) => `按钮无可见反馈: ${item.match}`),
      ...(result.serialChecks?.failures || []),
      ...result.smokeErrors.errors,
      ...result.smokeErrors.rejections,
      ...result.cdpExceptions
    ].filter(Boolean);

    if (failures.length > 0) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    await cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
    process.exitCode = 1;
  }
}

await main();
