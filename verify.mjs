// 自测：静态检查 + 验证二次验证分支的接口能通
import { ModelBestAuthPlugin, _internal } from "./index.mjs";
import * as mod from "./index.mjs";

console.log("导出面:", Object.entries(mod).map(([k, v]) => `${k}:${typeof v}`).join(", "));

const plugin = await ModelBestAuthPlugin({ client: { auth: { set: async () => {} } } });
console.log("methods:", plugin.auth.methods.map((m) => `${m.type}:${m.label}`).join(" | "));
console.log("prompts:", plugin.auth.methods.find((m) => m.type === "oauth").prompts.map((p) => p.key).join(", "));

// 缺凭据
const empty = async () => ({ type: "oauth", access: "", apiKey: "" });
console.log("空凭据 usage:", JSON.stringify(await plugin.auth.usage(empty)));
try {
  await plugin.auth.refresh({ type: "oauth", access: "x", metadata: {} });
} catch (e) {
  console.log("无账号密码时 refresh →", e.message, "| signIn:", e.signIn);
}

const oauth = plugin.auth.methods.find((m) => m.type === "oauth");

// 假账号：应该走到 /auth/login 并被拒，证明滑块在服务端能过
console.log("\n[1] 假账号跑完整登录链（会真解一次滑块）…");
let t0 = Date.now();
try {
  const flow = await oauth.authorize({ account: "probe@example.invalid", password: "wrong-password" });
  console.log("    authorize 返回了:", Object.keys(flow).join(","));
} catch (e) {
  console.log(`    结果 → ${e.message}（${Date.now() - t0}ms）`);
}

// 二次验证接口探活：假 challenge_token，确认接口存在且参数能收
console.log("\n[2] /auth/password-login/verify 探活…");
try {
  await _internal.verifyStepUp("fake-challenge-token", "123456");
  console.log("    居然通过（意料之外）");
} catch (e) {
  console.log("    结果 →", e.message);
}

// 真凭据（可选）
const account = process.env.MB_ACCOUNT;
const password = process.env.MB_PASSWORD;
if (account && password) {
  console.log("\n[3] 真账号…");
  t0 = Date.now();
  const first = await _internal.beginPasswordLogin(account, password).catch((e) => ({ error: e.message }));
  if (first.error) console.log("    失败:", first.error);
  else if (first.token) {
    console.log(`    直接拿到 token（${Date.now() - t0}ms），不需要二次验证`);
    const apiKey = await _internal.apiKeyFrom(first.token);
    const auth = { type: "oauth", access: first.token, apiKey, expires: _internal.tokenExp(first.token) };
    const getAuth = async () => auth;
    console.log("    usage:", JSON.stringify(await plugin.auth.usage(getAuth)));
    console.log("    checkin:", JSON.stringify(await plugin.auth.checkin(getAuth)));
  } else {
    console.log(`    要求二次验证：通道=${first.channel}，已发送=${first.notified}`);
    console.log("    插件这时会弹输入框要 6 位验证码");
  }
}
