// 本地验证：注入真实凭据跑一遍插件的每个钩子
import { ModelBestAuthPlugin, _internal } from "file:///D:/杂七杂八/magpie-modelbest/index.mjs";

const key = process.env.MB_KEY;
const consoleToken = process.env.MB_CONSOLE;
if (!key || !consoleToken) throw new Error("需要 MB_KEY 与 MB_CONSOLE");

// 假的 client.auth.set，记录插件想存回去的新 token
const saved = [];
const client = { auth: { set: async (args) => void saved.push(args) } };

const plugin = await ModelBestAuthPlugin({ client });

const cfg = {};
await plugin.config(cfg);
const declared = cfg.provider.modelbest;
console.log("provider:", declared.name, "| api:", declared.api);
console.log("静态模型:", Object.keys(declared.models).join(", "));

const auth = { type: "api", key, metadata: { consoleToken } };
const getAuth = async () => auth;

console.log("token 剩余天数:", (_internal.tokenExp(consoleToken) - Date.now()) / 86400000 | 0);
console.log("loader:", JSON.stringify(await plugin.auth.loader(getAuth)));
console.log("usage:", JSON.stringify(await plugin.auth.usage(getAuth)));
console.log("checkin:", JSON.stringify(await plugin.auth.checkin(getAuth)));
const live = await plugin.provider.models(declared, { auth });
console.log("在线模型:", Object.keys(live).length);

// 用例 A：token 无效 + 没账号密码 → 不该发登录请求，直接报要重新登录
const broken = { type: "api", key, metadata: { consoleToken: "invalid.token.value" } };
try {
  await plugin.auth.usage(async () => broken);
  console.log("A 无效 token 且无账号密码: 没抛错（意料之外）");
} catch (e) {
  console.log("A 无效 token 且无账号密码 →", e.message, "| signIn:", e.signIn);
}

// 用例 B：token 无效 + 填了账号密码 → 应该真的走滑块登录，这里用假账号，预期登录失败
const bad = {
  type: "api",
  key,
  metadata: {
    consoleToken: "invalid.token.value",
    account: "probe@example.invalid",
    password: "not-a-real-password",
  },
};
try {
  await plugin.auth.usage(async () => bad);
  console.log("B 无效 token + 假账号: 没抛错（意料之外）");
} catch (e) {
  console.log("B 无效 token + 假账号 →", e.message);
}
console.log("client.auth.set 调用次数:", saved.length);
