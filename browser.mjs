// 打开一个隔离的浏览器窗口让用户登录 ModelBest，然后从页面 localStorage 里取 map_token。
//
// 为什么这么做：控制台 token 没法用密码换（登录强制滑块），但用户自己的浏览器里一定有。
// 与其让他去 F12 复制，不如替他开一个干净窗口，登录完直接从页面读。
// profile 是持久化的，下次续期时代号还在，多数情况连窗口都不用等。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const CONSOLE_URL = "https://platform.modelbest.cn/console";
const TOKEN_KEY = "map_token";

// 只认还没过期的 token；顺带把过期时间带回来
const READ_TOKEN = `(() => {
  const t = localStorage.getItem(${JSON.stringify(TOKEN_KEY)}) || "";
  if (!t) return "";
  try {
    const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (!p.exp || p.exp * 1000 - Date.now() < 60000) return "";
    localStorage.setItem("__magpie_exp", String(p.exp * 1000));
    return t;
  } catch { return ""; }
})()`;

const pluginDataDir = () => {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "magpie", "plugin-data", "modelbest");
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 按平台列出装了哪些 Chromium 内核浏览器
export function findBrowser() {
  const out = [];
  if (process.platform === "win32") {
    for (const base of [
      process.env["PROGRAMFILES"],
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ]) {
      if (!base) continue;
      out.push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
      out.push(join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
      out.push(join(base, "Chromium", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    out.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    out.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    out.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  return out.find((p) => existsSync(p)) ?? null;
}

async function waitDevtools(port, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  throw new Error("浏览器没有打开调试端口，可能是安全软件拦了 --remote-debugging-port");
}

// 一次求值：连到当前页面、跑表达式、断开
async function evalOnce(port, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page" && /modelbest\.cn/.test(t.url ?? ""));
  if (!page?.webSocketDebuggerUrl) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("CDP 连接失败"));
      setTimeout(() => reject(new Error("CDP 连接超时")), 5000);
    });
    return await new Promise((resolve, reject) => {
      const id = 1;
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id === id) resolve(msg.result?.result?.value ?? null);
      };
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
      setTimeout(() => reject(new Error("CDP 求值超时")), 8000);
    });
  } finally {
    try {
      ws.close();
    } catch {}
  }
}

/**
 * 开窗口等登录。返回 { token, expires }。
 * 用户关掉窗口、或者超时，都会抛错。
 */
export async function loginInBrowser({ timeoutMs = 5 * 60_000, signal } = {}) {
  const exe = findBrowser();
  if (!exe) throw new Error("没找到 Chrome / Edge / Chromium，请装一个再试，或改用「填 API key」登录");

  const port = await freePort();
  const profile = join(pluginDataDir(), "browser");
  mkdirSync(profile, { recursive: true });

  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      CONSOLE_URL,
    ],
    { stdio: "ignore" },
  );

  const gone = new Promise((_, reject) => {
    child.once("exit", () => reject(new Error("登录窗口被关掉了，还没拿到 token")));
    signal?.addEventListener?.("abort", () => reject(new Error("登录已取消")), { once: true });
  });

  const watch = (async () => {
    await waitDevtools(port, 20_000);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const token = await evalOnce(port, READ_TOKEN).catch(() => null);
      if (token) {
        const expires = Number(await evalOnce(port, `localStorage.getItem("__magpie_exp") || 0`)) || 0;
        return { token, expires };
      }
      await sleep(1200);
    }
    throw new Error("等登录超时了，重新点一次登录");
  })();

  try {
    return await Promise.race([watch, gone]);
  } finally {
    watch.catch(() => {});
    try {
      child.kill();
    } catch {}
  }
}

// 测试用（入口只导出插件函数，这些不参与加载）
export const _internal = { evalOnce, READ_TOKEN, pluginDataDir };
