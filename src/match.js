// 跨平台名称匹配。
//
// 场景：杉果商品页没有 Steam appid，只能靠名称对齐。中文名、英文名、版本后缀
// （标准版/豪华版/Deluxe/Ultimate…）、括号里的平台标注都会干扰比较，所以先归一化
// 再算相似度。
//
// 相似度用「字符 bigram 的 Dice 系数」而不是编辑距离：中文没有词边界，bigram 对
// 中文和英文都稳，且对"多几个字"比编辑距离宽容。
//
// 注意：这里只负责打分，**不做自动落库决定**——阈值由调用方定，最终由人确认。

const EDITION_WORDS = [
  /标准版|普通版|豪华版|黄金版|年度版|完整版|决定版|终极版|数字豪华版|季票版/g,
  /\b(standard|deluxe|ultimate|complete|definitive|gold|enhanced|special|premium|collector'?s?)\s+edition\b/gi,
  /\bgame\s+of\s+the\s+year(\s+edition)?\b/gi,
  /\bgoty(\s+edition)?\b/gi,
  /\bremastered\b/gi,
];

/** 归一化：去版本词、平台标注与标点。 */
export function normalizeName(raw) {
  // ™®© 必须先去掉：NFKC 会把 ™ 展开成 "TM"，让 "ELDEN RING™" 变成 "elden ringtm"
  let s = String(raw ?? '').replace(/[™®©]/g, ' ');
  s = s.normalize('NFKC').toLowerCase();
  s = s.replace(/[（(\[]\s*steam\s*[）)\]]/gi, ' ');
  for (const re of EDITION_WORDS) s = s.replace(re, ' ');
  s = s.replace(/[（(][^）)]*[）)]/g, ' ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return s.replace(/\s+/g, ' ');
}

/** 字符 bigram 集合（单字时退化为该字本身）。 */
export function bigrams(text) {
  const chars = [...String(text ?? '').replace(/\s+/g, '')];
  if (chars.length <= 1) return chars.length ? [chars[0]] : [];
  const out = [];
  for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，对顺序和长度差异比编辑距离宽容。 */
export function diceCoefficient(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const countA = new Map();
  for (const g of A) countA.set(g, (countA.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of B) {
    const n = countA.get(g) ?? 0;
    if (n > 0) {
      overlap += 1;
      countA.set(g, n - 1);
    }
  }
  return (2 * overlap) / (A.length + B.length);
}

/**
 * 拆出标题的多个候选写法：
 *   杉果标题常是「中文名 版本（Steam） English Name - Edition (Steam)」，
 *   中英两部分要分别和候选的 name / name_en 比较。
 *
 * 注意：中文片段必须保留数字——「全境封锁2」的 2 是标题的一部分，
 * 早期实现按"删除所有 ASCII"来取中文，把 2 也删了，导致匹配退化。
 */
export function nameVariants(raw) {
  const text = String(raw ?? '');
  // 中文片段必须以汉字开头，否则「Cyberpunk 2077」里的 2077 会被当成中文变体，
  // 反而和中文标题里的数字产生 0.6 的假高分。
  const cjkRuns = text.match(/[\u3040-\u30ff\u3400-\u9fff][\u3040-\u30ff\u3400-\u9fff0-9]*/g) ?? [];
  const latinRuns = text.match(/[A-Za-z][A-Za-z0-9'’\-:.]*(?:\s+[A-Za-z0-9'’\-:.]+)*/g) ?? [];

  const variants = [
    normalizeName(text),
    ...cjkRuns.map((run) => normalizeName(run)),
    ...latinRuns.map((run) => normalizeName(run)),
  ].filter((v) => v && v.length >= 2 && v !== 'steam');

  return [...new Set(variants)];
}

/** 两个（已归一化的）名字的相似度：Dice 与「包含关系」取较大者。 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dice = diceCoefficient(a, b);
  let contains = 0;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    contains = (shorter / longer) * 0.95;
  }
  return Math.max(dice, contains);
}

/** 两个商品名的最佳相似度（考虑各自的多种写法）。 */
export function scorePair(titleA, titleB) {
  const va = nameVariants(titleA);
  const vb = nameVariants(titleB);
  let best = 0;
  for (const a of va) for (const b of vb) best = Math.max(best, similarity(a, b));
  return best;
}

/**
 * 在候选里找最像的一个。
 * candidates: [{ name, nameEn }]；返回 { candidate, score, matchedField } 或 null。
 */
export function bestMatch(title, candidates, { minScore = 0.86, getFields = (c) => [c.name, c.nameEn] } = {}) {
  let best = null;
  for (const candidate of candidates ?? []) {
    for (const field of getFields(candidate)) {
      if (!field) continue;
      const score = scorePair(title, field);
      if (!best || score > best.score) best = { candidate, score, matchedField: field };
    }
  }
  if (!best || best.score < minScore) return null;
  return best;
}

/** 分数 → 人读置信度，用于 CLI 输出与"是否自动应用"的默认阈值。 */
export function confidenceLabel(score) {
  if (score >= 0.94) return '自动';
  if (score >= 0.86) return '待确认';
  return '无候选';
}
