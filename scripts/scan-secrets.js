#!/usr/bin/env node
// 发布前扫描：确认仓库里没有会被公开的凭据。
//
// 触发时机：把仓库转为 public 之前，或每次提交前。
// 只扫文本文件，跳过 node_modules / .git / logs / 本地数据库目录。
//
// 用法：node scripts/scan-secrets.js [目录]
// 退出码：发现高置信度凭据时为 1。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', '.npm-cache', 'pgdata', 'coverage', 'out']);
// 这些目录里没有"会被误公开的凭据"，只有本地数据库文件与抓包快照：
// 扫它们既慢又会产生大量噪音（实测 2147 个文件 → 50 个）
const SKIP_PATHS = [/^data\/.+pgdata(\/|$)/, /^data\/pages(\/|$)/];

const shouldSkipDir = (relPath) => {
  const name = relPath.split('/').pop();
  if (SKIP_DIRS.has(name)) return true;
  if (name.endsWith('-pgdata')) return true;
  return SKIP_PATHS.some((re) => re.test(relPath));
};
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.sh', '.txt', '.sql', '.html', '.example',
  '.pem', '.key', '.crt', '.env', '.conf', '.ini', '',
]);
const BARE_FILES = new Set(['Dockerfile', '.env.example', '.gitignore', '.gitattributes', '.dockerignore', 'LICENSE']);
const MAX_BYTES = 2 * 1024 * 1024;

// 高置信度：这些前缀一旦出现基本就是真凭据
const HARD_PATTERNS = [
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'AI 服务 key', re: /\bsk-[A-Za-z0-9-]{20,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

// 带密码的连接串：用命名分组把 user / pass / host 分开取。
// 早期版本用 ([^:]+):([^@]+)@ 取用户名当主机，导致示例主机永远过滤不掉。
const CONN_RE =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/(?<user>[^\s:'"/]+):(?<pass>[^\s@'"/]+)@(?<host>[^\s:/'"]+)/g;

const PLACEHOLDER_RE =
  /^(?:pass|passwd|password|pwd|pw|secret|token|key|user|密码|口令|x{2,}|\*+|\.+|abc123|abc.*|abcdef[\w]*|test[\w]*|demo[\w]*|example[\w]*|your[\w-]*|change[\w-]*|placeholder[\w]*|dummy[\w]*|你的.*|改成.*|\$\{[^}]*\}|<[^>]*>)$/i;

export const isPlaceholder = (value) => {
  const v = String(value ?? '').trim();
  return v === '' || PLACEHOLDER_RE.test(v);
};

// 文档里的示例主机（localhost / host / db / 内网示例 IP）不算泄漏
const EXAMPLE_HOST_RE = /^(?:host|localhost|db|postgres|example\.com|your-host|10\.0\.0\.5|127\.0\.0\.1|x+)$/i;
const looksLikeRealHost = (host) => Boolean(host) && !EXAMPLE_HOST_RE.test(host) && !host.includes('${') && !host.includes('<');

const SOFT_PATTERNS = [
  { name: '可疑赋值', re: /\b(?:api[_-]?key|apikey|secret|passwd|password|token|access[_-]?key)\b\s*[:=]\s*["']([^"'\s]{8,})["']/i },
];

function isTextish(file) {
  const base = file.split(/[\\/]/).pop();
  if (BARE_FILES.has(base)) return true;
  return TEXT_EXT.has(extname(base).toLowerCase());
}

function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = relative(root, abs).replace(/\\/g, '/');
      if (st.isDirectory()) {
        if (!shouldSkipDir(rel)) walk(abs);
        continue;
      }
      if (st.size <= MAX_BYTES && isTextish(abs)) out.push(abs);
    }
  };
  walk(root);
  return out;
}

/** 返回 {files, hardHits, softHits, skipped}；纯函数式，方便测试。ignore 传入相对路径前缀。 */
export function scanSecrets(root = process.cwd(), { ignore = [] } = {}) {
  const ignorePrefixes = ignore.map((p) => p.replace(/\\/g, '/'));
  const files = collectFiles(root);
  const hardHits = [];
  const softHits = [];
  const skipped = [];

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = relative(root, file).replace(/\\/g, '/');
    if (ignorePrefixes.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
    // 文件级豁免：文件头 5 行内声明 scan-secrets: ignore-file
    // 只对本身就是"假凭据测试"的文件用，且会打印出来，不是静默跳过
    if (text.split('\n', 5).join('\n').includes('scan-secrets: ignore-file')) {
      skipped.push(rel);
      continue;
    }
    const inTests = rel.startsWith('test/');

    text.split('\n').forEach((line, i) => {
      for (const p of HARD_PATTERNS) {
        if (p.re.test(line)) hardHits.push({ file: rel, line: i + 1, rule: p.name, snippet: line.trim().slice(0, 120) });
      }
      for (const m of line.matchAll(CONN_RE)) {
        const { pass, host } = m.groups;
        if (!isPlaceholder(pass) && looksLikeRealHost(host)) {
          hardHits.push({
            file: rel,
            line: i + 1,
            rule: '带密码的连接串',
            snippet: line.trim().replace(/(:)([^:@\s]+)(@)/, '$1***$3').slice(0, 120),
          });
        }
      }
      if (inTests) return; // 测试夹具里的假值不报
      for (const p of SOFT_PATTERNS) {
        const m = line.match(p.re);
        if (m && !isPlaceholder(m[1])) {
          softHits.push({ file: rel, line: i + 1, rule: p.name, snippet: line.trim().slice(0, 120) });
        }
      }
    });
  }
  return { files, hardHits, softHits, skipped };
}

function main() {
  const root = process.argv[2] ? process.argv[2] : process.cwd();
  const { files, hardHits, softHits, skipped } = scanSecrets(root);
  console.log(`扫描 ${files.length} 个文件\n`);
  if (skipped.length) {
    console.log(`已按文件头 "scan-secrets: ignore-file" 标记跳过：${skipped.join(', ')}\n`);
  }

  if (hardHits.length) {
    console.log(`❌ 高置信度凭据 ${hardHits.length} 处：`);
    for (const h of hardHits) console.log(`  ${h.file}:${h.line}  [${h.rule}]  ${h.snippet}`);
  } else {
    console.log('✅ 未发现高置信度凭据（token / 私钥 / 带真实密码的连接串）');
  }

  if (softHits.length) {
    console.log(`\n⚠️  需要人工确认的赋值 ${softHits.length} 处：`);
    for (const h of softHits) console.log(`  ${h.file}:${h.line}  ${h.snippet}`);
  } else {
    console.log('✅ 未发现可疑的密钥赋值');
  }

  return hardHits.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = main();
}
