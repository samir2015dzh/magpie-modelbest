// 自测：静态检查 + 用假账号验证「服务端过滑块登录」这条链真的走得到 /auth/login
import { ModelBestAuthPlugin, _internal } from "./index.mjs";
import * as mod from "./index.mjs";

console.log("导出面:", Object.entries(mod).map(([k, v]) => `${k}:${typeof v}`).join(", "));

const plugin = await ModelBestAuthPlugin({ client: { auth: { set: async () => {} } } });
console.log("methods:", plugin.auth.methods.map((m) => `${m.type}:${m.label}`).join(" | "));

// authorize 必须立刻返回，否则和 magpie 死锁
const oauth = plugin.auth.methods.find((m) => m.type === "oauth");
const t0 = Date.now();
const flow = await oauth.authorize({ account: "probe@example.invalid", password: "x" });
console.log(`authorize: ${Date.now() - t0}ms, opened=${flow.opened}, method=${flow.method}, url=${JSON.stringify(flow.url)}`);

// 缺凭据时的行为
const empty = async () => ({ type: "oauth", access: "", apiKey: "" });
console.log("空凭据 usage:", JSON.stringify(await plugin.auth.usage(empty)));
console.log("空凭据 loader:", JSON.stringify(await plugin.auth.loader(empty)));
try {
  await plugin.auth.refresh({ type: "oauth", access: "x", metadata: {} });
} catch (e) {
  console.log("无账号密码时 refresh →", e.message, "| signIn:", e.signIn);
}

// 真打一次：假账号应该走到 /auth/login 并被拒，证明滑块过了、请求到了
console.log("\n用假账号跑完整登录链（会真解一次滑块）…");
try {
  await flow.callback();
  console.log("假账号居然登录成功了？（意料之外）");
} catch (e) {
  console.log("结果 →", e.message);
}

// 真凭据（可选）
const account = process.env.MB_ACCOUNT;
const password = process.env.MB_PASSWORD;
if (account && password) {
  console.log("\n用真账号验证…");
  const c = await _internal.passwordLogin(account, password).catch((e) => {
    console.log("登录失败:", e.message);
    return null;
  });
  if (c) {
    console.log("token 剩余天数:", Math.round((_internal.tokenExp(c) - Date.now()) / 86400000));
    const auth = { type: "oauth", access: c, apiKey: await _internal.apiKeyFrom(c), expires: _internal.tokenExp(c) };
    const getAuth = async () => auth;
    console.log("loader:", JSON.stringify(await plugin.auth.loader(getAuth)));
    console.log("usage:", JSON.stringify(await plugin.auth.usage(getAuth)));
    console.log("checkin:", JSON.stringify(await plugin.auth.checkin(getAuth)));
  }
}
