// 模拟真实续期流程：反复取图 → 求解 → verify，直到拿到 captcha_id。统计每轮要几次。
import { findGap, decode } from "./slider.mjs";

const BASE = "https://platform.modelbest.cn/api";
const post = async (p, b) =>
  (
    await fetch(BASE + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    })
  ).json();

async function attempt() {
  const cap = (await post("/auth/captcha", {})).data;
  const master = decode(cap.master_b64);
  const tile = decode(cap.tile_b64);
  const hit = findGap(master, tile.w, tile.h);
  const v = await post("/auth/captcha/verify", { id: cap.id, x: hit.x, y: cap.tile_y });
  return v?.code === 0 && v?.data?.passed === true ? { ok: true, id: v.data.id } : { ok: false };
}

const MAX = Number(process.argv[2] || 8);
const ROUNDS = Number(process.argv[3] || 4);
const used = [];
for (let r = 0; r < ROUNDS; r++) {
  let n = 0;
  let got = null;
  while (n < MAX && !got) {
    n++;
    got = await attempt();
  }
  used.push(got ? n : Infinity);
  console.log(`第 ${r + 1} 轮：${got ? `第 ${n} 次通过` : `${MAX} 次都没过`}`);
}
console.log(`\n每轮用次数：${used.map((u) => (u === Infinity ? "失败" : u)).join(", ")}`);
