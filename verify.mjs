// 本地自测：先跑静态检查，有控制台 token 再跑真接口
import { ModelBestAuthPlugin, _internal } from "./index.mjs";
import { _internal as browser } from "./browser.mjs";

const plugin = await ModelBestAuthPlugin({ client: { auth: { set: async () => {} } } });

// ---- 静态部分（不需要凭据） ----
const oauth = plugin.auth.methods.find((m) => m.type === "oauth");
const t0 = Date.now();
const flow = await oauth.authorize();
console.log(`authorize: ${Date.now() - t0}ms, opened=${flow.opened}, method=${flow.method}`);
console.log("methods:", plugin.auth.methods.map((m) => m.type).join(" | "));

const empty = async () => ({ type: "oauth", access: "", apiKey: "" });
console.log("空凭据 usage:", JSON.stringify(await plugin.auth.usage(empty)));
console.log("空凭据 loader:", JSON.stringify(await plugin.auth.loader(empty)));

try {
  await plugin.auth.usage(async () => ({ type: "oauth", access: "invalid.token.x" }));
} catch (e) {
  console.log("无效 token →", e.message, "| signIn:", e.signIn);
}

// ---- 真接口部分 ----
const token = process.env.MB_CONSOLE || (await browser.evalOnce(9222, browser.READ_TOKEN).catch(() => ""));
if (!token) {
  console.log("\n没有可用的控制台 token，跳过真接口检查（设 MB_CONSOLE，或在 9222 上登录着 ModelBest）");
  process.exit(0);
}

let apiKey;
try {
  apiKey = await _internal.apiKeyFrom(token);
} catch (e) {
  console.log("\n读到 token 但服务端不认（可能已失效）:", e.message);
  process.exit(0);
}
console.log(`\n自动取到 API key: ${apiKey.slice(0, 8)}…(${apiKey.length} 字符)`);

const auth = { type: "oauth", access: token, refresh: "browser-profile", expires: _internal.tokenExp(token), apiKey };
const getAuth = async () => auth;
console.log("剩余天数:", Math.round((_internal.tokenExp(token) - Date.now()) / 86400000));
console.log("loader:", JSON.stringify(await plugin.auth.loader(getAuth)));
console.log("usage:", JSON.stringify(await plugin.auth.usage(getAuth)));
console.log("checkin:", JSON.stringify(await plugin.auth.checkin(getAuth)));

const cfg = {};
await plugin.config(cfg);
const live = await plugin.provider.models(cfg.provider.modelbest, { auth });
console.log("在线模型:", Object.keys(live).length);
