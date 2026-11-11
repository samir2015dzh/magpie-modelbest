// magpie 供应商插件：ModelBest / 面壁智能（MiniCPM）
//
// 推理走 https://api.modelbest.cn/v1（OpenAI 兼容）；积分与签到走控制台
// https://platform.modelbest.cn/api（Bearer = 网页里的 map_token）。
//
// 控制台 token 是 7 天的 JWT，没有 refresh 接口，只能重新登录一次控制台；
// 而控制台登录强制滑块（captcha_enabled: true）。所以这里给两条登录路：
//
//   A. 浏览器登录（推荐）：插件自己开一个隔离的 Chrome 窗口，你在里面登录，
//      它从页面 localStorage 把 token 读走，顺手把 API key 也取出来。
//      → 不需要在任何输入框里填东西，点一下就行。
//   B. 填 API key：老路子，适合不想被弹窗的人；顺手填账号密码就能永久自动续。
import { decode, findGap } from "./slider.mjs";
import { loginInBrowser } from "./browser.mjs";

const PROVIDER = "modelbest";
const API = "https://api.modelbest.cn/v1";
const CONSOLE = "https://platform.modelbest.cn/api";
const UA = "magpie-modelbest/0.3.0";
const RENEW_BEFORE = 3 * 24 * 3600 * 1000;
const LOGIN_TRIES = 8;

// 模型快照（/api/models 与 /v1/models）。只收 chat 模型：
// MiniCPM-OCR-1.0 只有 document_parse 协议，VoxCPM2 是语音合成，MiniCPM-o-4.5-Realtime 走实时通道。
const MODELS = {
  "MiniCPM-V-4.6": { ctx: 256000, image: true, video: true, toolcall: true, cost: [0.2, 1.6] },
  "MiniCPM-V-4.7-35B-A3B": { ctx: 256000, image: true, video: true, toolcall: true, reasoning: true, free: true },
  "MiniCPM-V-4.7-1B": { ctx: 256000, image: true, video: true, toolcall: true, reasoning: true, free: true },
  "MiniCPM-V-4.5": { ctx: 40000, image: true, video: true, toolcall: true, cost: [0.2, 1.6] },
  "MiniCPM5-2B": { ctx: 128000, cost: [0.15, 0.3] },
  "MiniCPM5-1B": { ctx: 128000, toolcall: true, cost: [0.1, 0.2] },
  "MiniCPM-OCR-Jev": { ctx: 32000, image: true, file: true },
};

// 入口只导出插件函数，辅助函数放 _internal，否则 magpie 会把每个导出函数都当插件跑
const modelOf = (id) => {
  const m = MODELS[id] ?? {};
  const images = !!m.image;
  return {
    id,
    name: id,
    limit: { context: m.ctx ?? 128000, output: m.out ?? 8192 },
    capabilities: {
      reasoning: !!m.reasoning,
      toolcall: !!m.toolcall,
      attachment: !!(m.image || m.video || m.file),
      input: { text: true, image: images, video: !!m.video, pdf: !!m.file },
    },
    modalities: { input: ["text", ...(images ? ["image"] : []), ...(m.video ? ["video"] : [])] },
    cost: { input: m.cost?.[0] ?? 0, output: m.cost?.[1] ?? 0 },
    ...(m.free ? { free: true } : {}),
  };
};

// ---------- 凭据 ----------

function tokenExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof p.exp === "number" ? p.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// 浏览器登录的账号是 oauth 类型（token 在 access）；填 key 的账号是 api 类型
const consoleTokenOf = (auth) =>
  (auth?.type === "oauth" ? auth.access : auth?.metadata?.consoleToken || auth?.consoleToken) || "";
const apiKeyOf = (auth) => (auth?.type === "oauth" ? auth.apiKey : auth?.key) || "";

async function cpost(path, body, token) {
  const res = await fetch(CONSOLE + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept-language": "zh-CN",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function consoleGet(token, path, init) {
  const res = await fetch(CONSOLE + path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "accept-language": "zh-CN",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  // 控制台对失效会话既可能回 401，也可能回 HTTP 200 + code 10001
  if (res.status === 401 || body?.code === 10001) {
    throw Object.assign(new Error("ModelBest 控制台 token 已过期，请重新登录插件"), { signIn: "expired" });
  }
  if (!res.ok || (body && body.code !== 0)) throw new Error(body?.message || `控制台回答 ${res.status}`);
  return body?.data;
}

// 拿这个账号的推理 key：已有一个就用它，没有就建一个
async function apiKeyFrom(token) {
  const keys = await consoleGet(token, "/keys"); // token 失效会在这里抛 signIn: expired，别吞掉
  const list = keys?.list ?? (Array.isArray(keys) ? keys : []);
  const usable = list.find((k) => k?.status !== "disabled") ?? list[0];
  if (usable?.id) {
    const secret = await consoleGet(token, `/keys/${usable.id}/secret`).catch(() => null);
    if (secret?.secret) return secret.secret;
  }
  const me = await consoleGet(token, "/me").catch(() => null);
  const projectId = me?.default_project_id;
  if (!projectId) throw new Error("这个账号下没有可用的 API key，也拿不到默认项目，请先去控制台建一个");
  const created = await cpost(`/projects/${projectId}/keys`, { name: "magpie" }, token);
  const secret = created.json?.data?.secret ?? created.json?.data?.key;
  if (!secret) throw new Error(`自动创建 API key 失败：${created.json?.message ?? "未知原因"}，请去控制台手动建一个`);
  return secret;
}

// ---------- 滑块登录（填了账号密码时用，不弹窗） ----------

async function solveCaptcha() {
  for (let i = 0; i < 3; i++) {
    const { json } = await cpost("/auth/captcha", {});
    const cap = json?.data;
    if (!cap?.master_b64 || !cap?.tile_b64) continue;
    const tile = decode(cap.tile_b64);
    const hit = findGap(decode(cap.master_b64), tile.w, tile.h);
    if (hit.x < 0) continue;
    // go-captcha 的 confirm 给的是拼图最终 left（绝对坐标），不是拖拽位移
    const v = await cpost("/auth/captcha/verify", { id: cap.id, x: hit.x, y: cap.tile_y });
    if (v.json?.code === 0 && v.json?.data?.passed && v.json.data.id) return v.json.data.id;
  }
  throw new Error("滑块没解出来，换一次登录试试");
}

async function passwordLogin(account, password) {
  let last = "";
  for (let i = 0; i < LOGIN_TRIES; i++) {
    const captchaId = await solveCaptcha().catch(() => null);
    if (!captchaId) continue;
    const { json } = await cpost("/auth/login", { account, password, captcha_id: captchaId });
    if (json?.code === 0 && json.data?.token) return json.data.token;
    if (json?.data?.step_up_required) {
      throw new Error("这个账号要邮箱二次验证，自动登录走不通，请点「用浏览器登录」");
    }
    last = json?.message ?? `code ${json?.code}`;
    if (json?.code !== 20013) break;
  }
  throw new Error(`ModelBest 登录失败：${last}`);
}

// ---------- 插件 ----------

export const ModelBestAuthPlugin = async ({ client } = {}) => ({
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: "ModelBest 面壁智能",
      npm: "@ai-sdk/openai-compatible",
      api: API,
      models: Object.fromEntries(Object.keys(MODELS).map((id) => [id, modelOf(id)])),
    };
  },

  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "oauth",
        label: "用浏览器登录 ModelBest（推荐）",
        async authorize() {
          // ⚠ 这里必须立刻返回：真正等用户的是 callback()，在 authorize 里 await 会和 magpie 死锁
          return {
            url: "",
            opened: true, // 窗口我们自己开，让 magpie 别再开系统浏览器
            method: "auto",
            instructions:
              "1) 会弹出一个独立的 Chrome 窗口（不碰你日常浏览器的登录状态）\n" +
              "2) 在里面登录 ModelBest 控制台\n" +
              "3) 登录成功窗口会自己关掉，API key 也会自动取好",
            async callback(_url, _input, signal) {
              const { token, expires } = await loginInBrowser({ timeoutMs: 5 * 60_000, signal });
              const apiKey = await apiKeyFrom(token);
              const me = await consoleGet(token, "/me").catch(() => null);
              return {
                type: "success",
                access: token,
                refresh: "browser-profile", // 有值才会被写进 plugin-auth.json；续期靠重开浏览器
                expires,
                apiKey,
                ...(me?.username ? { accountId: me.username } : {}),
                metadata: { consoleToken: token, consoleExpires: expires },
              };
            },
          };
        },
      },
      {
        type: "api",
        label: "直接填 API key",
        placeholder: "sk-live-…",
        prompts: [
          {
            type: "text",
            key: "account",
            message: "控制台账号（可选，填了就不用再弹窗）",
            placeholder: "手机号或邮箱",
          },
          {
            type: "password",
            key: "password",
            message: "控制台密码（可选，填了自动续期就不打扰你）",
          },
        ],
      },
    ],

    // magpie 在 expires 前自动调用（oauth 账号）
    async refresh(auth) {
      const meta = auth?.metadata ?? {};
      // 填过账号密码：滑块静默登录，不弹窗
      if (meta.account && meta.password) {
        const token = await passwordLogin(meta.account, meta.password);
        const expires = tokenExp(token);
        const apiKey = await apiKeyFrom(token).catch(() => auth.apiKey);
        return { access: token, expires, apiKey, metadata: { ...meta, consoleToken: token, consoleExpires: expires } };
      }
      // 否则重开登录窗口；profile 里还留着登录态时会一闪而过
      const { token, expires } = await loginInBrowser({ timeoutMs: 3 * 60_000 });
      const apiKey = await apiKeyFrom(token).catch(() => auth.apiKey);
      return { access: token, expires, apiKey, metadata: { ...meta, consoleToken: token, consoleExpires: expires } };
    },

    async loader(getAuth) {
      const auth = await getAuth();
      const key = apiKeyOf(auth);
      return key ? { baseURL: API, apiKey: key } : { baseURL: API };
    },

    async usage(getAuth) {
      const auth = await getAuth();
      const token = consoleTokenOf(auth);
      if (!token) return { plan: "积分", error: "还没登录控制台：积分与签到读不到", windows: [] };

      const [account, rewards, packs, me] = await Promise.all([
        consoleGet(token, "/billing/account"),
        consoleGet(token, "/rewards"),
        consoleGet(token, "/billing/credit-packages"),
        consoleGet(token, "/me").catch(() => null),
      ]);
      const balance = Number(account?.balance ?? 0);
      const daily = Number(rewards?.daily_checkin_points ?? 0);
      const claimed = !!rewards?.claimed_today;

      const active = (packs?.list ?? []).filter((p) => p.status === "ACTIVE" || Number(p.remaining_amount) > 0);
      const loose = Number(packs?.other_available_balance ?? 0);
      const left = active.reduce((s, p) => s + Number(p.remaining_amount || 0), 0) + loose;
      const total = active.reduce((s, p) => s + Number(p.original_amount || 0), 0) + loose;

      let soonest = null;
      for (const p of active) {
        const at = Date.parse(p.expires_at ?? "");
        if (!Number.isFinite(at) || Number(p.remaining_amount) <= 0) continue;
        if (!soonest || at < soonest.at) soonest = { at, amount: Number(p.remaining_amount) };
      }

      const window = { name: "积分", unit: "积分" };
      if (total > 0) {
        Object.assign(window, {
          amount: left,
          limit: total,
          display: `${left} / ${total} 积分 · 剩余 ${((left / total) * 100).toFixed(1)}%`,
        });
      } else {
        Object.assign(window, { balance, display: `剩余 ${balance} 积分` });
      }
      if (soonest) {
        window.runsOutAt = new Date(soonest.at).toISOString();
        window.runsOut = soonest.amount;
      }

      return {
        plan: "积分",
        user: me?.username || undefined,
        balance: `${balance} 积分`,
        windows: [
          window,
          { name: "每日签到", display: claimed ? "今日已签到" : `今日未签到（+${daily}）`, aside: true },
        ],
      };
    },

    async checkin(getAuth) {
      const auth = await getAuth();
      const token = consoleTokenOf(auth);
      const before = await consoleGet(token, "/rewards");
      if (before?.claimed_today) return { outcome: "done", message: `今日已签到（${before.reward_date}）` };
      const r = await consoleGet(token, "/rewards/daily-checkins", { method: "POST", body: "{}" });
      if (r?.claimed) {
        return {
          outcome: "claimed",
          credit: Number(r.reward_points ?? 0),
          message: `签到 +${r.reward_points ?? 0} 积分，余额 ${r.balance} 积分`,
        };
      }
      return { outcome: "done", message: `今日已领取（${r?.reward_date ?? before?.reward_date}）` };
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      const key = apiKeyOf(auth);
      if (!key) return provider.models;
      const res = await fetch(`${API}/models`, { headers: { authorization: `Bearer ${key}`, "x-title": UA } });
      if (!res.ok) return provider.models;
      const { data } = await res.json().catch(() => ({}));
      if (!Array.isArray(data)) return provider.models;
      const listed = Object.fromEntries(data.map((m) => [m.id, m]));
      const out = {};
      for (const [id, base] of Object.entries(provider.models ?? {})) {
        const live = listed[id];
        if (!live) continue;
        out[id] = {
          ...base,
          limit: {
            context: live.context_window || base.limit?.context,
            output: live.max_output_tokens || base.limit?.output,
          },
        };
      }
      return Object.keys(out).length ? out : provider.models;
    },
  },
});

export const _internal = { MODELS, modelOf, tokenExp, passwordLogin, solveCaptcha, apiKeyFrom, consoleGet };
