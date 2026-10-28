// 登录图形验证码（自托管，不依赖第三方）。
//
// 设计取舍：
//   · 不用 SVG 里塞明文答案——答案只存库（一次性、5 分钟过期、用完即删）
//   · 4 位字符去掉易混淆的 0/O/1/I，配旋转 + 噪点 + 干扰线，足够挡住脚本爆破
//   · 校验通过即消费掉 token，同一张图不能用第二次
import { randomInt, randomBytes } from 'node:crypto';

const CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LEN = 4;
const TTL_MINUTES = 5;

export function newCode(len = CODE_LEN) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += CHARS[randomInt(0, CHARS.length)];
  return out;
}

/** 生成 SVG：每个字符随机旋转/偏移，加干扰线与噪点。 */
export function renderSvg(code) {
  const W = 132;
  const H = 44;
  let chars = '';
  const colors = ['#0ea5e9', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];
  for (let i = 0; i < code.length; i += 1) {
    const x = 16 + i * 28 + randomInt(-3, 4);
    const y = 29 + randomInt(-4, 5);
    const rotate = randomInt(-18, 19);
    const color = colors[randomInt(0, colors.length)];
    chars += `<text x="${x}" y="${y}" fill="${color}" font-size="${22 + randomInt(0, 7)}" font-family="Verdana,DejaVu Sans,sans-serif" font-weight="700" transform="rotate(${rotate} ${x} ${y})">${code[i]}</text>`;
  }
  let lines = '';
  for (let i = 0; i < 3; i += 1) {
    lines += `<line x1="${randomInt(0, W)}" y1="${randomInt(0, H)}" x2="${randomInt(0, W)}" y2="${randomInt(0, H)}" stroke="rgba(148,163,184,.7)" stroke-width="1"/>`;
  }
  let dots = '';
  for (let i = 0; i < 22; i += 1) {
    dots += `<circle cx="${randomInt(0, W)}" cy="${randomInt(0, H)}" r="${randomInt(1, 3)}" fill="rgba(148,163,184,.55)"/>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="验证码">` +
    `<rect width="${W}" height="${H}" rx="8" fill="#0f172a"/>` +
    `${lines}${dots}${chars}</svg>`
  );
}

/** 生成一张新验证码并落库，返回 { token, svg }。 */
export async function issue(q) {
  const token = randomBytes(16).toString('hex');
  const code = newCode();
  await q(
    `insert into login_challenges (token, answer, expires_at) values ($1, $2, now() + interval '${TTL_MINUTES} minutes')
     on conflict (token) do nothing`,
    [token, code],
  );
  // 顺手清理一小时前的过期记录，避免表无限增长
  q(`delete from login_challenges where expires_at < now() - interval '1 hour'`).catch(() => {});
  return { token, svg: renderSvg(code), expiresInSec: TTL_MINUTES * 60 };
}

/** 校验并消费验证码（一次性）。 */
export async function verify(q, token, answer) {
  const t = String(token ?? '').trim();
  const a = String(answer ?? '').trim();
  if (!t || !a) return false;
  try {
    const r = await q('delete from login_challenges where token = $1 and expires_at > now() returning answer', [t]);
    const row = r.rows[0];
    if (!row) return false;
    return String(row.answer).toLowerCase() === a.toLowerCase();
  } catch {
    return false;
  }
}

/** 验证码是否启用（默认启用，CAPTCHA_ENABLED=0 可关）。 */
export function enabled(env = process.env) {
  return String(env.CAPTCHA_ENABLED ?? '') !== '0';
}
