// 滑块求解。
// 背景图上已经画出目标位置：一块半透明压暗的拼图块。找「窗口比外圈暗得最多」的位置，
// 返回的 x 是缺口在背景图里的绝对横坐标——go-captcha 的 confirm 传的就是拼图最终 left，不是位移。
import jpeg from "./vendor/jpeg-js/index.js";
import pngjs from "./vendor/pngjs/lib/png.js";

const decode = (uri) => {
  const buf = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  if (/^data:image\/png/i.test(uri)) {
    const p = pngjs.PNG.sync.read(buf);
    return { w: p.width, h: p.height, rgba: p.data };
  }
  const { width, height, data } = jpeg.decode(buf, { useTArray: true });
  return { w: width, h: height, rgba: data };
};

export function findGap(master, tw, th) {
  const W = master.w;
  const H = master.h;
  const gray = new Float32Array(W * H);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * master.rgba[p] + 0.587 * master.rgba[p + 1] + 0.114 * master.rgba[p + 2];
  }

  // 积分图：任意矩形均值 O(1)
  const S = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x];
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const sum = (x0, y0, x1, y1) =>
    S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
  const cl = (v, hi) => Math.min(hi, Math.max(0, v));
  const mean = (x0, y0, x1, y1) => sum(x0, y0, x1, y1) / Math.max(1, (x1 - x0) * (y1 - y0));

  let best = { score: Infinity, x: -1, y: -1 };
  for (let y = 0; y <= H - th; y++) {
    for (let x = 0; x <= W - tw; x++) {
      const inner = mean(x, y, x + tw, y + th);
      const outer = mean(cl(x - 6, W), cl(y - 6, H), cl(x + tw + 6, W), cl(y + th + 6, H));
      const score = inner - outer;
      if (score < best.score) best = { score, x, y };
    }
  }
  return best;
}

export { decode };



