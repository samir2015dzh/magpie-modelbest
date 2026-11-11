// magpie 供应商插件：ModelBest / 面壁智能（MiniCPM）
//
// 推理走 https://api.modelbest.cn/v1（OpenAI 兼容）；积分与签到走控制台
// https://platform.modelbest.cn/api（Bearer = 网页里的 map_token）。
//
// magpie 通常跑在服务器或容器里，那里没有浏览器可以借，所以登录只能在服务端完成：
// 账号密码 → 自动过滑块 → 换 console token → 顺手取/建 API key。
// 账号开了二次验证时，/auth/login 会返回 step_up_required（此时服务端已把验证码发到手机/邮箱），
// 这里用 magpie 的 method: "code" 弹一个输入框让用户填 6 位码，填完换 token。
import { decode, findGap } from "./slider.mjs";

const PROVIDER = "modelbest";
const API = "https://api.modelbest.cn/v1";
const CONSOLE = "https://platform.modelbest.cn/api";
const UA = "magpie-modelbest/0.5.4";
const LOGIN_TRIES = 8;

// 模型快照（/api/models 与 /v1/models）。
//
// reasoning 是实测出来的：后端认 reasoning_effort，但把它当开关用——
// minimal/low/medium/high 效果完全一样，none 或不给就看模型默认（MiniCPM5-* 默认就思考，
// V-4.6/V-4.5 默认不思考）。除了 OCR-Jev 完全不认这个参数，其余模型都给档位。
//
// 注意：难题下这些模型可能停不下来，把 max_tokens 全耗在思考里、正文返回空
// （V-4.7-1B / V-4.6 / V-4.5 用奥数题都复现过；简单问题正常）。这是模型行为，不是插件能修的。
//
// 只收 chat 模型：MiniCPM-OCR-1.0 只有 document_parse 协议，VoxCPM2 是语音合成，
// MiniCPM-o-4.5-Realtime 走实时通道。
const THINK = { low: {}, medium: {}, high: {} };
const MODELS = {
  "MiniCPM-V-4.7-35B-A3B": {
    ctx: 256000, image: true, video: true, toolcall: true, reasoning: true, variants: THINK, free: true,
  },
  "MiniCPM-V-4.7-1B": {
    ctx: 256000, image: true, video: true, toolcall: true, reasoning: true, variants: THINK, free: true,
  },
  "MiniCPM-V-4.6": {
    ctx: 256000, image: true, video: true, toolcall: true, reasoning: true, variants: THINK, cost: [0.2, 1.6],
  },
  "MiniCPM-V-4.5": {
    ctx: 40000, image: true, video: true, toolcall: true, reasoning: true, variants: THINK, cost: [0.2, 1.6],
  },
  "MiniCPM5-2B": { ctx: 128000, reasoning: true, variants: THINK, cost: [0.15, 0.3] },
  "MiniCPM5-1B": { ctx: 128000, reasoning: true, variants: THINK, toolcall: true, cost: [0.1, 0.2] },
  // 唯一不认 reasoning_effort 的模型：加了也没反应，别给档位
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
    ...(m.variants ? { variants: { ...m.variants } } : {}),
    ...(m.free ? { free: true } : {}),
  };
};

// ---------- 控制台 ----------

function tokenExp(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    return typeof p.exp === "number" ? p.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

// oauth 账号 token 在 access；填 key 降级登录的账号在 metadata.consoleToken
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
    throw Object.assign(new Error("ModelBest 控制台登录已失效，请重新登录插件"), { signIn: "expired" });
  }
  if (!res.ok || (body && body.code !== 0)) throw new Error(body?.message || `控制台回答 ${res.status}`);
  return body?.data;
}

// API key 也由插件自己搞定，用户不用去控制台复制
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
  if (!secret) throw new Error(`自动创建 API key 失败：${created.json?.message ?? "未知原因"}`);
  return secret;
}

// ---------- 滑块 ----------

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
  throw new Error("滑块没解出来，稍后重试");
}

// ---------- 密码登录（可能要求二次验证） ----------

/**
 * 第一步：解滑块 + POST /auth/login。
 * 返回 { token } 或 { challengeToken, channel, notified }。
 * 二次验证时服务端已经发了一条验证码，这里不用再调 resend。
 *
 * 注意 data.code：控制台前端把它标成「当前环境验证码」，服务端在信任这个登录环境时
 * 会把验证码直接回给客户端（省得用户去看手机）。有它就不用弹框。
 */
async function beginPasswordLogin(account, password) {
  let last = "";
  for (let i = 0; i < LOGIN_TRIES; i++) {
    const captchaId = await solveCaptcha().catch(() => null);
    if (!captchaId) continue;
    const { json } = await cpost("/auth/login", { account, password, captcha_id: captchaId });
    if (json?.code === 0) {
      const d = json.data ?? {};
      if (d.token) return { token: d.token };
      if (d.step_up_required && d.challenge_token) {
        // 服务端把验证码直接给了（可信环境）：自己验掉，用户看不到这一步
        if (/^\d{6}$/.test(String(d.code ?? ""))) {
          const auto = await verifyStepUp(d.challenge_token, String(d.code)).catch(() => null);
          if (auto) return { token: auto, autoStepUp: true };
          // 猜错了就退回让用户填，别把人卡死
        }
        return {
          challengeToken: d.challenge_token,
          channel: d.verification_channel === "phone" ? "手机" : "邮箱",
          notified: d.notification_status !== "failed",
        };
      }
    }
    last = json?.message ?? `code ${json?.code}`;
    if (json?.code !== 20013) break; // 20013 = 人机验证未通过，换张图继续
  }
  throw new Error(`ModelBest 登录失败：${last}`);
}

// 第二步（仅在要求二次验证时）：6 位验证码换 token
async function verifyStepUp(challengeToken, code) {
  const { json } = await cpost("/auth/password-login/verify", { challenge_token: challengeToken, code });
  if (json?.code === 0 && json.data?.token) return json.data.token;
  throw new Error(json?.message || "验证码不对，再试一次");
}

// 验证码没收到时可以重发
async function resendStepUp(challengeToken) {
  const { json } = await cpost("/auth/password-login/resend", { challenge_token: challengeToken });
  return json?.data ?? null;
}

// token → 一整套凭据（顺便把 API key 也取好）
async function credentialFromLogin(token) {
  const apiKey = await apiKeyFrom(token);
  const expires = tokenExp(token);
  const me = await consoleGet(token, "/me").catch(() => null);
  return { token, apiKey, expires, username: me?.username };
}

function successOf(c, inputs) {
  return {
    type: "success",
    access: c.token,
    refresh: "account-password", // 有值才会被写进 plugin-auth.json
    expires: c.expires,
    apiKey: c.apiKey,
    ...(c.username ? { accountId: c.username } : {}),
    metadata: {
      account: inputs?.account,
      password: inputs?.password,
      consoleToken: c.token,
      consoleExpires: c.expires,
    },
  };
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
        // 用 oauth 类型是为了绕开 api 类型那个「必须填 API key」的输入框：
        // opened + 空 url 让 magpie 什么都不打开，callback 立刻开跑，登录全在服务端完成。
        type: "oauth",
        label: "ModelBest 账号登录（推荐）",
        prompts: [
          {
            type: "text",
            key: "account",
            message: "ModelBest 账号（手机号或邮箱）",
            placeholder: "登录 platform.modelbest.cn 用的那个",
          },
          { type: "password", key: "password", message: "ModelBest 密码" },
        ],
        async authorize(inputs) {
          const { account, password } = inputs ?? {};
          if (!account || !password) throw new Error("需要账号和密码才能登录");

          // 先把第一步做完，这样才能决定要不要弹验证码框
          const first = await beginPasswordLogin(account, password);
          const base = { url: "", opened: true };

          // 不需要二次验证：直接成功，不打扰用户
          if (first.token) {
            return {
              ...base,
              method: "auto",
              instructions: "正在完成登录…",
              async callback() {
                return successOf(await credentialFromLogin(first.token), inputs);
              },
            };
          }

          // 需要二次验证：magpie 会弹一个输入框，用户填 6 位验证码
          return {
            ...base,
            method: "code",
            instructions: first.notified
              ? `验证码已发到你的${first.channel}，请输入 6 位数字`
              : `验证码可能没发出去（${first.channel}），请输入收到的码；收不到就重新登录一次`,
            async callback(code) {
              const typed = String(code ?? "").trim();
              if (!/^\d{6}$/.test(typed)) throw new Error("需要 6 位数字验证码");
              try {
                return successOf(await credentialFromLogin(await verifyStepUp(first.challengeToken, typed)), inputs);
              } catch (e) {
                // 输错了给一次重发机会，再错就让用户重来
                await resendStepUp(first.challengeToken).catch(() => {});
                throw e;
              }
            },
          };
        },
      },
      {
        type: "api",
        label: "直接填 API key（不存密码）",
        placeholder: "sk-live-…",
        prompts: [
          {
            type: "password",
            key: "consoleToken",
            message: "控制台 token（可选，用于积分与签到）",
            placeholder: "已登录网页 F12 里 localStorage.map_token",
          },
        ],
      },
    ],

    // magpie 在 expires 前自动调用。账号要求二次验证时这里没法弹框，标记为需要重新登录。
    async refresh(auth) {
      const meta = auth?.metadata ?? {};
      if (!meta.account || !meta.password) {
        throw Object.assign(new Error("没有可用的账号密码，无法自动续期，请重新登录插件"), { signIn: "expired" });
      }
      let first;
      try {
        first = await beginPasswordLogin(meta.account, meta.password);
      } catch (e) {
        throw Object.assign(new Error(`自动续期失败：${e.message}`), { signIn: "expired" });
      }
      if (!first.token) {
        throw Object.assign(
          new Error("这个账号每次登录都要验证码，重新登录插件并填入收到的验证码即可"),
          { signIn: "expired" },
        );
      }
      const c = await credentialFromLogin(first.token);
      return {
        access: c.token,
        expires: c.expires,
        apiKey: c.apiKey,
        metadata: { ...meta, consoleToken: c.token, consoleExpires: c.expires },
      };
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

export const _internal = {
  MODELS,
  modelOf,
  tokenExp,
  solveCaptcha,
  beginPasswordLogin,
  verifyStepUp,
  apiKeyFrom,
  consoleGet,
};
