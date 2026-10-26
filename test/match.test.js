// 名称匹配：归一化、bigram 相似度、候选挑选。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  bigrams,
  diceCoefficient,
  nameVariants,
  similarity,
  scorePair,
  bestMatch,
  confidenceLabel,
} from '../src/match.js';

test('归一化：去版本词、平台标注与标点', () => {
  assert.equal(normalizeName('全境封锁2 标准版（Steam）'), '全境封锁2');
  assert.equal(normalizeName('Cyberpunk 2077 (Steam)'), 'cyberpunk 2077');
  assert.equal(normalizeName('Some Game - Deluxe Edition'), 'some game');
  assert.equal(normalizeName('ELDEN RING™'), 'elden ring');
  assert.equal(normalizeName('巫师3：狂猎 年度版'), '巫师3 狂猎');
});

test('中英混合标题能拆出两种写法', () => {
  const variants = nameVariants("全境封锁2 标准版（Steam） Tom Clancy's The Division 2 - Standard Edition (Steam)");
  assert.ok(variants.includes('全境封锁2'), `缺少中文写法：${variants.join(' | ')}`);
  assert.ok(
    variants.some((v) => v.includes('tom clancy') && v.includes('division 2')),
    `缺少英文写法：${variants.join(' | ')}`,
  );
});

test('bigram 与 Dice：相同为 1，无关为 0', () => {
  assert.deepEqual(bigrams('abc'), ['ab', 'bc']);
  assert.deepEqual(bigrams('a'), ['a']);
  assert.equal(diceCoefficient('cyberpunk 2077', 'cyberpunk 2077'), 1);
  assert.equal(diceCoefficient('cyberpunk 2077', 'stardew valley'), 0);
});

test('相似度：完全一致为 1', () => {
  assert.equal(similarity('赛博朋克 2077', '赛博朋克 2077'), 1);
});

test('相似度：包含关系给部分分（本体 vs 版本名）', () => {
  const score = similarity('愚者不灭', '愚者不灭 荣光痴人版');
  assert.ok(score > 0.4, `本体与版本名应有较高相似度，实际 ${score}`);
});

test('相似度：跨语言得分低（共享数字只带来一点点）', () => {
  const score = scorePair('赛博朋克 2077', 'Cyberpunk 2077');
  // 「20/07/77」这些数字 bigram 会贡献约 0.4，但远低于匹配阈值 0.86
  assert.ok(score < 0.5, `中英直接比较不该接近阈值，实际 ${score}`);
  assert.ok(score < 0.86);
});

test('scorePair：中文对中文、英文对英文都能命中', () => {
  assert.ok(scorePair('赛博朋克 2077', '赛博朋克 2077') > 0.9);
  assert.ok(scorePair('Cyberpunk 2077 (Steam)', 'Cyberpunk 2077') > 0.9);
});

test('bestMatch：在干扰项里挑出正确候选', () => {
  const candidates = [
    { name: '星露谷物语', steam_appid: 1 },
    { name: '空洞骑士', steam_appid: 2 },
    { name: '赛博朋克 2077', steam_appid: 3 },
  ];
  const best = bestMatch('赛博朋克 2077 标准版（Steam）', candidates, { minScore: 0.8 });
  assert.equal(best.candidate.steam_appid, 3);
  assert.ok(best.score >= 0.8);
});

test('bestMatch：都低于阈值时返回 null（宁可不匹配）', () => {
  const candidates = [{ name: '星露谷物语', steam_appid: 1 }];
  assert.equal(bestMatch('赛博朋克 2077', candidates, { minScore: 0.8 }), null);
});

test('bestMatch：支持自定义字段（中英文名并列比较）', () => {
  const candidates = [{ name: '艾尔登法环', nameEn: 'ELDEN RING', steam_appid: 1245620 }];
  const best = bestMatch('ELDEN RING Deluxe Edition', candidates, { minScore: 0.8 });
  assert.equal(best.candidate.steam_appid, 1245620);
  assert.match(best.matchedField, /ELDEN/i);
});

test('置信度标签与阈值一致', () => {
  assert.equal(confidenceLabel(0.98), '自动');
  assert.equal(confidenceLabel(0.94), '自动');
  assert.equal(confidenceLabel(0.9), '待确认');
  assert.equal(confidenceLabel(0.5), '无候选');
});
