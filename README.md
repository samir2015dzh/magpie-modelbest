# magpie-modelbest

[English](#english) · [中文](#中文)

---

## English

ModelBest (面壁智能 / MiniCPM) provider plugin for [magpie](https://usemagpie.ai) and OpenCode.

**One click to sign in.** Pick 「用浏览器登录 ModelBest」 — the plugin opens a clean Chrome window, you log in there, and it takes the console token and your API key out of the page itself. No token to copy, no field to fill.

```
user_xxxxxx                    积分
1250 / 1500 积分 · 剩余 83.3%
  ● 今日已签到                 自动签到
```

### Install

```bash
magpie plugin add samir2015dzh/magpie-modelbest
magpie plugin login modelbest      # 选第一个登录方式
magpie provider test modelbest
magpie quota
```

### Two ways to sign in

| Method | What you do | Renewal |
| --- | --- | --- |
| **用浏览器登录（推荐）** | Click it; a Chrome window opens; log in to ModelBest once | magpie reopens that window before the token expires. If the profile still holds a session it closes in a second; otherwise you log in again (~7 days) |
| **直接填 API key** | Paste `sk-live-…`; optionally also the console account + password | With account + password, renewal is fully silent (solved captcha, no window). With only the key, no credits and no check-in |

The browser route is the point: the console token lives in the page's `localStorage`, so the plugin reads it from the page instead of asking you to open DevTools.

### Where credentials are stored

`~/.config/magpie/plugin-auth.json` (mode 600) — the same file magpie uses for every other provider login. The isolated browser profile lives in `~/.config/magpie/plugin-data/modelbest/browser/` and holds only the ModelBest console session.

### Models

Seven chat models, refreshed per account from `GET /v1/models`:

| Model | Context | Notes |
| --- | --- | --- |
| `MiniCPM-V-4.7-35B-A3B` | 256k | free, vision, video, reasoning, tool calls |
| `MiniCPM-V-4.7-1B` | 256k | free, vision, video, reasoning, tool calls |
| `MiniCPM-V-4.6` | 256k | vision, video, tool calls |
| `MiniCPM-V-4.5` | 40k | vision, video, tool calls |
| `MiniCPM5-2B` | 128k | text |
| `MiniCPM5-1B` | 128k | text, tool calls |
| `MiniCPM-OCR-Jev` | 32k | vision, file input |

Not listed on purpose: `MiniCPM-OCR-1.0` (only speaks `document_parse`), `VoxCPM2` (speech synthesis), `MiniCPM-o-4.5-Realtime` (realtime channel).

### How it works

The console token is a 7-day JWT. There is no refresh endpoint (`/auth/refresh`, `/auth/token/refresh`, `/auth/renew`, `/auth/session/refresh`, `/auth/token` all 404), `/me` does not reissue it, the `sk-live-…` key is rejected by every console endpoint (`10001`), and a guest token only reaches the playground (`10010`). A new token requires `POST /auth/login`, which enforces a slider captcha.

So there are two renewal paths, in priority order:

1. **Browser** — reopen the isolated Chrome (persistent profile) and read the token from the page. `opened: true` in the oauth authorize result tells magpie not to open the system browser, because the plugin opens its own.
2. **Silent captcha login** — if you supplied account + password, `ensureConsole` solves the slider itself: locate the half-transparent dark block in the background image (integral image, ~10 ms), `POST /auth/captcha/verify` for a one-shot `captcha_id`, then `POST /auth/login`. Single-shot success is about two in three, retried up to 8 times; 10/10 runs passed first try.

One gotcha worth repeating: the captcha `x` is the gap's **absolute horizontal coordinate in the background image**, not the drag distance. go-captcha's `confirm` reports `F = M + J*L`, the puzzle piece's final `left`. Passing the delta gives `20014 人机验证未通过` forever.

### Limitations

- The browser route is verified up to "opens window → polls page → reads token from a signed-in page"; the full "you log in and it picks up a brand-new token" run needs a human.
- Silent renewal has never run end-to-end with a real password — only up to `/auth/login` (a fake account returns 账号或密码错误, proving the captcha was solved and accepted).
- Email step-up accounts cannot auto-renew; the plugin says so and you use the browser route.
- A console redesign can break the captcha solver; the browser route keeps working.
- Credit totals only count currently active packs.

### Dependencies

`vendor/jpeg-js` (0.4.4) and `vendor/pngjs` (7.0.0) — pure JS, no build, MIT, committed so installing from git needs no `npm install`. They only decode captcha images.

---

## 中文

ModelBest（面壁智能 MiniCPM）的 [magpie](https://usemagpie.ai) / OpenCode 供应商插件。

**点一下就登录。** 选「用浏览器登录 ModelBest」，插件会开一个干净的 Chrome 窗口，你在里面登录，它自己从页面里把控制台 token 和 API key 取走。不用复制 token，不用填任何输入框。

### 安装

```bash
magpie plugin add samir2015dzh/magpie-modelbest
magpie plugin login modelbest      # 选第一个登录方式
magpie provider test modelbest
magpie quota
```

### 两种登录方式

| 方式 | 你要做什么 | 续期 |
| --- | --- | --- |
| **用浏览器登录（推荐）** | 点一下，弹出 Chrome 窗口，在里面登录一次 ModelBest | token 快到期时 magpie 重开那个窗口；登录态还在就一秒关掉，不在了就再登一次（约 7 天） |
| **直接填 API key** | 粘 `sk-live-…`，可选再填控制台账号密码 | 填了账号密码就是完全静默续期（自动过滑块，不弹窗）；只填 key 则没有积分和签到 |

浏览器那条是重点：控制台 token 就存在页面的 `localStorage` 里，插件直接从页面读，不用你开 F12。

### 凭据存在哪

`~/.config/magpie/plugin-auth.json`（权限 600），和 magpie 存其它供应商登录信息是同一个文件。隔离浏览器的 profile 在 `~/.config/magpie/plugin-data/modelbest/browser/`，只有 ModelBest 控制台的会话。

### 模型

七个 chat 模型，按账号从 `GET /v1/models` 实时刷新：`MiniCPM-V-4.7-35B-A3B`（256k，免费）、`MiniCPM-V-4.7-1B`（256k，免费）、`MiniCPM-V-4.6`（256k）、`MiniCPM-V-4.5`（40k）、`MiniCPM5-2B`（128k）、`MiniCPM5-1B`（128k）、`MiniCPM-OCR-Jev`（32k）。

`MiniCPM-OCR-1.0` 只有 `document_parse` 协议、`VoxCPM2` 是语音合成、`MiniCPM-o-4.5-Realtime` 走实时通道，都不是 chat completions，故不列出。

### 实现要点

控制台 token 是 7 天 JWT，没有 refresh 接口（`/auth/refresh` 等一律 404），`/me` 不换发，`sk-live-…` key 读不了控制台（`10001`），游客 token 只到体验中心（`10010`）。要新 token 只能过 `POST /auth/login`，而它强制滑块。

续期两条路：

1. **浏览器** —— 重开隔离的 Chrome（profile 持久化），从页面读 token。oauth 的 authorize 结果里 `opened: true` 让 magpie 不要再开系统浏览器，窗口由插件自己开。
2. **静默滑块登录** —— 填过账号密码时，`ensureConsole` 自己解滑块：在背景图里找那块半透明压暗的方块（积分图，约 10ms），`POST /auth/captcha/verify` 换一次性 `captcha_id`，再 `POST /auth/login`。单次通过率约六七成，最多重试 8 次，实测 10/10 首试通过。

一个值得重复的坑：滑块 `x` 是缺口在背景图里的**绝对横坐标**，不是拖拽位移。go-captcha 的 `confirm` 给的是 `F = M + J*L`，即拼图最终 `left`。传位移会一直 `20014 人机验证未通过`。

### 限制

- 浏览器路线已验证到「开窗口 → 轮询页面 → 从已登录页面读到 token」，完整「你登录后它接住新 token」那段需要真人跑一次。
- 静默续期没做过「真密码换真 token」的端到端实测，只验到 `/auth/login`（假账号返回「账号或密码错误」，说明滑块确实过了并被接受）。
- 账号开了邮箱二次验证时自动续期走不通，插件会提示改用浏览器登录。
- 控制台改版可能让滑块求解失效，浏览器路线不受影响。
- 积分总量只统计当前有效的额度包。

### 依赖

`vendor/jpeg-js`（0.4.4）和 `vendor/pngjs`（7.0.0），纯 JS、无构建、MIT，已提交进仓库，从 git 安装不需要 `npm install`。只用来解验证码图片。

## License

MIT
