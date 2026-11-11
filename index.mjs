// magpie 供应商插件：ModelBest / 面壁智能（MiniCPM）
// 推理走 https://api.modelbest.cn/v1（OpenAI 兼容）；
// 积分与签到走控制台 https://platform.modelbest.cn/api（Bearer = 网页 localStorage 的 map_token）。
// 那个 token 是 7 天的 JWT，没有 refresh 接口，续期只能重新登录一次控制台——登录要过滑块，
// 所以这里带着一个滑块求解器（slider.mjs），填了账号密码就能自动换新的 token。
import { decode, findGap } from "./slider.mjs";

const PROVIDER = "modelbest";
const API = "https://api.modelbest.cn/v1";
const CONSOLE = "https://platform.modelbest.cn/api";
const UA = "magpie-modelbest/0.2.0";
const RENEW_BEFORE = 3 * 24 * 3600 * 1000; // 剩不到 3 天就续
const LOGIN_TRIES = 8; // 滑块单次通过率约六七成，8 次足够

// 模型快照（/api/models 与 /v1/models，2026-11-11）。只收 chat 模型：
// MiniCPM-OCR-1.0 只有 document_parse 协议，VoxCPM2 是语音合成，MiniCPM-o-4.5-Realtime 走实时通道，都不在这里。
const MODELS = {
  "MiniCPM-V-4.6": { ctx: 256000, image: true, video: true, toolcall: true, cost: [0.2, 1.6] },
  "MiniCPM-V-4.7-35B-A3B": { ctx: 256000, image: true, video: true, toolcall: true, reasoning: true, free: true },
  "MiniCPM-V-4.7-1B": { ctx: 256000, image: true, video: true, toolcall: true, reasoning: true, free: true },
  "MiniCPM-V-4.5": { ctx: 40000, image: true, video: true, toolcall: true, cost: [0.2, 1.6] },
  "MiniCPM5-2B": { ctx: 128000, cost: [0.15, 0.3] },
  "MiniCPM5-1B": { ctx: 128000, toolcall: true, cost: [0.1, 0.2] },
  "MiniCPM-OCR-Jev": { ctx: 32000, image: true, file: true },
};

// 辅助函数不单独导出：magpie 会把导出的每个函数都当插件调用一遍，测试用的放 _internal 上
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

export const _internal = { MODELS, modelOf, tokenExp, passwordLogin, solveCaptcha };

// ---------- 控制台会话 ----------

// JWT 里带 exp（秒），拿不到就当未知
function tokenExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof p.exp === "number" ? p.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function cpost(path, body) {
  const res = await fetch(CONSOLE + path, {
    method: "POST",
    headers: { "content-type": "application/json", "accept-language": "zh-CN" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 取一张滑块图算缺口位置，verify 通过后拿 captcha_id；不过就换一张
async function solveCaptcha() {
  for (let i = 0; i < 3; i++) {
    const { json } = await cpost("/auth/captcha", {});
    const cap = json?.data;
    if (!cap?.master_b64 || !cap?.tile_b64) continue;
    const tile = decode(cap.tile_b64);
    const hit = findGap(decode(cap.master_b64), tile.w, tile.h);
    if (hit.x < 0) continue;
    const v = await cpost("/auth/captcha/verify", { id: cap.id, x: hit.x, y: cap.tile_y });
    if (v.json?.code === 0 && v.json?.data?.passed && v.json.data.id) return v.json.data.id;
  }
  throw new Error("滑块没解出来");
}

async function passwordLogin(account, password) {
  let last = "";
  for (let i = 0; i < LOGIN_TRIES; i++) {
    const captchaId = await solveCaptcha().catch(() => null);
    if (!captchaId) continue;
    const { json } = await cpost("/auth/login", { account, password, captcha_id: captchaId });
    if (json?.code === 0 && json.data?.token) return json.data.token;
    if (json?.data?.step_up_required) {
      throw new Error("ModelBest 要求邮箱二次验证，自动续期走不通；请在网页登录后把新 token 重新填进插件");
    }
    last = json?.message ?? `HTTP ${json?.code ?? "?"}`;
    if (json?.code !== 20013) break; // 20013 是「人机验证未通过」，换张图再来
  }
  throw new Error(`ModelBest 登录失败：${last}`);
}

// 控制台 token 快过期就用账号密码自动换一张。续不动就返回旧的，让厂商那边去报错。
async function ensureConsole(auth, client) {
  const meta = auth?.metadata ?? {};
  const token = meta.consoleToken || auth?.consoleToken || "";
  const exp = meta.consoleExpires || tokenExp(token);
  const fresh = token && exp - Date.now() > RENEW_BEFORE;
  if (fresh || !meta.account || !meta.password) return token;

  const next = await passwordLogin(meta.account, meta.password);
  await client?.auth
    ?.set({
      path: { id: PROVIDER },
      body: { ...auth, metadata: { ...meta, consoleToken: next, consoleExpires: tokenExp(next) } },
    })
    .catch(() => {});
  return next;
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
  // 控制台对失效会话既可能回 401，也可能回 HTTP 200 + code 10001（登录令牌缺失或无效）
  if (res.status === 401 || body?.code === 10001) {
    throw Object.assign(new Error("ModelBest 控制台 token 已过期，请重新登录插件"), { signIn: "expired" });
  }
  if (!res.ok || (body && body.code !== 0)) {
    throw new Error(body?.message || `控制台回答 ${res.status}`);
  }
  return body?.data;
}

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
        type: "api",
        label: "ModelBest API key",
        placeholder: "sk-live-…",
        prompts: [
          {
            type: "text",
            key: "account",
            message: "控制台账号（手机号或邮箱，用于自动续期，可留空）",
            placeholder: "登录 platform.modelbest.cn 用的那个",
          },
          {
            type: "password",
            key: "password",
            message: "控制台密码（同上，可留空；只存在本机 plugin-auth.json）",
          },
          {
            type: "password",
            key: "consoleToken",
            message: "控制台 token（可选）：积分与每日签到要用它",
            placeholder: "localStorage.map_token，留空则用账号密码换",
          },
        ],
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api") return {};
      return { baseURL: API };
    },

    // 卡片上的积分数：余额来自 /billing/account，总量与到期来自 /billing/credit-packages，签到状态来自 /rewards
    async usage(getAuth) {
      const auth = await getAuth();
      const token = await ensureConsole(auth, client);
      if (!token) {
        return { plan: "积分", error: "没填控制台 token 或账号密码：积分与签到读不到", windows: [] };
      }
      const [account, rewards, packs, me] = await Promise.all([
        consoleGet(token, "/billing/account"),
        consoleGet(token, "/rewards"),
        consoleGet(token, "/billing/credit-packages"),
        consoleGet(token, "/me").catch(() => null),
      ]);
      const balance = Number(account?.balance ?? 0);
      const daily = Number(rewards?.daily_checkin_points ?? 0);
      const claimed = !!rewards?.claimed_today;

      // 额度包：original_amount 是给过的总量，remaining_amount 是还剩的；包外的零散余额单列
      const active = (packs?.list ?? []).filter(
        (p) => p.status === "ACTIVE" || Number(p.remaining_amount) > 0,
      );
      const loose = Number(packs?.other_available_balance ?? 0);
      const left = active.reduce((s, p) => s + Number(p.remaining_amount || 0), 0) + loose;
      const total = active.reduce((s, p) => s + Number(p.original_amount || 0), 0) + loose;

      // 最早作废的一笔：magpie 用它在卡片上提示「xx 之后过期多少」
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

    // magpie 每个北京日给每个账号调一次
    async checkin(getAuth) {
      const auth = await getAuth();
      const token = await ensureConsole(auth, client);
      const before = await consoleGet(token, "/rewards");
      if (before?.claimed_today) {
        return { outcome: "done", message: `今日已签到（${before.reward_date}）` };
      }
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

  // 每个账号问一次模型列表；失败就保留 config 里的静态表
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api" || !auth.key) return provider.models;
      const res = await fetch(`${API}/models`, {
        headers: { authorization: `Bearer ${auth.key}`, "x-title": UA },
      });
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
