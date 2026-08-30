import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function loadBrowserSource(url, { executablePath, timeoutMs = 45_000 } = {}) {
  const browser = executablePath ?? process.env.BROWSER_EXECUTABLE ?? defaultBrowserPath();
  if (!browser) throw new Error("No browser found. Set BROWSER_EXECUTABLE to Chrome or Chromium.");

  const profileDirectory = mkdtempSync(join(tmpdir(), "vegfinder-browser-"));
  const child = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });

  try {
    const debuggingURL = await readDebuggingURL(child, timeoutMs);
    const client = await CDPClient.connect(debuggingURL, timeoutMs);
    try {
      const { targetId } = await client.command("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.command("Target.attachToTarget", { targetId, flatten: true });
      await client.command("Page.enable", {}, sessionId);
      const loaded = client.waitForEvent("Page.loadEventFired", sessionId, 25_000);
      await client.command("Page.navigate", { url }, sessionId);
      await loaded;
      await delay(7_000);
      const result = await client.command("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
        returnByValue: true
      }, sessionId);
      const source = result.result?.value;
      if (typeof source !== "string" || !source.trim()) {
        throw new Error("Browser returned an empty document");
      }
      if (/Performing security verification|Enable JavaScript and cookies to continue/i.test(source)) {
        throw new Error("Browser was blocked by the source's security verification");
      }
      return source;
    } finally {
      await client.command("Browser.close").catch(() => {});
      client.close();
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(profileDirectory, { recursive: true, force: true });
  }
}

function defaultBrowserPath() {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return process.platform === "win32" ? null : "chromium";
}

function readDebuggingURL(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let errorOutput = "";
    const timer = setTimeout(() => finish(new Error("Browser debugging endpoint timed out")), timeoutMs);
    const onData = (chunk) => {
      errorOutput += chunk.toString();
      const match = errorOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) finish(null, match[1]);
      if (errorOutput.length > 20_000) errorOutput = errorOutput.slice(-10_000);
    };
    const onExit = (code) => finish(new Error(`Browser exited before startup (${code}): ${errorOutput.trim()}`));
    child.stderr.on("data", onData);
    child.once("exit", onExit);

    function finish(error, value) {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolve(value);
    }
  });
}

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.nextID = 1;
    this.pending = new Map();
    this.eventWaiters = [];
    socket.addEventListener("message", (event) => this.receive(JSON.parse(event.data)));
  }

  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("Browser connection timed out")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CDPClient(socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Could not connect to browser debugging endpoint"));
      }, { once: true });
    });
  }

  command(method, params = {}, sessionId) {
    const id = this.nextID++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitForEvent(method, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject };
      waiter.timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.eventWaiters.push(waiter);
    });
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
      return;
    }
    const waiter = this.eventWaiters.find(
      (candidate) => candidate.method === message.method && candidate.sessionId === message.sessionId
    );
    if (waiter) {
      clearTimeout(waiter.timer);
      this.eventWaiters = this.eventWaiters.filter((candidate) => candidate !== waiter);
      waiter.resolve(message.params);
    }
  }

  close() {
    this.socket.close();
    for (const pending of this.pending.values()) pending.reject(new Error("Browser connection closed"));
    for (const waiter of this.eventWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Browser connection closed"));
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
