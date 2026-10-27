// 校验零构建前端的 <script> 内联 JS 语法：new Function 方式。
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
let failed = false;
for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let n = 0;
  while ((m = re.exec(html)) !== null) {
    n += 1;
    const code = m[1];
    try {
      new Function(code);
      console.log(`OK  ${file} script#${n} (${code.length} chars)`);
    } catch (err) {
      failed = true;
      console.log(`FAIL ${file} script#${n}: ${err.message}`);
    }
  }
  if (n === 0) console.log(`WARN ${file}: no inline script`);
}
if (failed) process.exit(1);
console.log('all inline scripts syntax OK');
