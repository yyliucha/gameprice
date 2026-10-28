// 唯一出网点。所有外部请求都从这里走，因此这里也是"排障信息最全"的地方。
//
// 每个请求会产生三类记录：
//   http.request   发出前（url / attempt / 超时设置）
//   http.response  成功（status / bytes / elapsedMs / contentType）
//   http.retry     重试（原因 / 等待多久）
//   http.error     最终失败（错误码 / 主机名 / 响应片段）
// 只有 requestId 相同的记录属于同一次尝试，排障时按它串起来即可。
import { redactUrl } from './log.js';
import * as undici from 'undici';
import { decideProxy, redactProxy } from './proxy.js';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 steamdeals/0.2 (personal use)';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 代理连接复用：同一代理地址只建一个 Agent
const agents = new Map();

/** 按目标主机挑选出网通道；返回 null 表示直连。 */
function dispatcherFor(host) {
  const decision = decideProxy(host, process.env);
  if (!decision.url) return { dispatcher: null, via: 'direct', proxy: null };
  if (!agents.has(decision.url)) agents.set(decision.url, new undici.ProxyAgent(decision.url));
  return { dispatcher: agents.get(decision.url), via: decision.via, proxy: redactProxy(decision.url) };
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

const rid = () => Math.random().toString(36).slice(2, 10);

// 出网错误的"翻译表"：把 undici/Node 的英文错误码变成能照着做的中文提示。
const CODE_HINTS = {
  ENOTFOUND: 'DNS 解析失败（域名不存在或 DNS 不可用）',
  ECONNREFUSED: '连接被拒绝（端口没有服务）',
  ECONNRESET: '连接被对端重置（常见于风控或中间设备）',
  ETIMEDOUT: '连接超时（目标不可达或被阻断）',
  UND_ERR_CONNECT_TIMEOUT: '连接超时（目标不可达或被阻断）',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时',
  UND_ERR_BODY_TIMEOUT: '读取响应体超时',
  UND_ERR_SOCKET: '连接被关闭',
  UND_ERR_ABORTED: '请求被中止（常见于代理拒绝隧道或连接被重置）',
  UND_ERR_PRX_TLS: '代理的 HTTPS 证书校验失败（自签证书？换 http:// 或导入证书）',
  CERT_HAS_EXPIRED: '证书过期',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败（可能有中间人代理）',
  DEPTH_ZERO_SELF_SIGNED_CERT: '证书是自签名的（可能有中间人代理）',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配（可能有中间人代理）',
};

/** undici 在代理拒绝建隧道时抛的英文原因，形如 "Proxy response (407) !== 200 when HTTP Tunneling" */
const PROXY_TUNNEL_RE = /Proxy response \((\d{3})\) !== 200/;

/** 代理 CONNECT 的状态码 → 人话。诊断命令也复用这张表。 */
export const PROXY_STATUS_HINTS = {
  400: '代理不接受 CONNECT（配的可能是反向代理，不是 HTTP 正向代理）',
  403: '代理拒绝放行该域名（检查代理规则/白名单）',
  405: '代理不允许 CONNECT（配的可能不是 HTTP 正向代理）',
  407: '代理要求认证（在代理地址里带上账号密码：用户名:密码@主机:端口）',
  421: '代理无法处理该目标',
  502: '代理连不上目标（代理侧故障，稍后重试）',
  503: '代理暂时不可用（稍后重试）',
  504: '代理连目标超时（稍后重试）',
};

export function proxyStatusHint(status) {
  return PROXY_STATUS_HINTS[status] ?? `代理拒绝建立隧道（HTTP ${status}）`;
}

/** 配了代理却连不上代理本身时，这几个错误码更可能是"代理没开/地址错"，而不是目标站点的问题。 */
const PROXY_UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** 把错误码翻译与出网通道合起来，得到最终给用户看的一句提示。 */
export function errorHint(info, route, { aborted = false, timeoutMs = 0 } = {}) {
  if (aborted) return `超时（${timeoutMs}ms 内无响应）`;
  if (route?.via && route.via !== 'direct' && PROXY_UNREACHABLE_CODES.has(info.code)) {
    return `连不上代理${route.proxy ? ` ${route.proxy}` : ''}（确认代理在运行、地址/端口正确）`;
  }
  return info.hint;
}

/** 顺着 err.cause 挖到最底层：undici 把真实原因埋了 2~3 层，只看最外层等于没打日志。 */
export function rootCause(err, depth = 0) {
  if (!err || typeof err !== 'object' || depth > 8) return null;
  const next = err.cause;
  if (!next || typeof next !== 'object' || next === err) return err;
  return rootCause(next, depth + 1) ?? err;
}

/**
 * 把 fetch/undici 的错误翻译成 { code, hint, cause, proxyStatus, retryable }。
 *
 * 实测 undici 8.x 的代理隧道失败长这样（最外层完全看不出原因）：
 *   TypeError: fetch failed
 *     cause: DOMException { message: 'Request was cancelled.', code: 0 }   ← 数字 0，不是错误码
 *       cause: AbortError { message: 'Proxy response (407) !== 200 when HTTP Tunneling' }
 * 所以必须挖到底层，否则同步记录里只有 "fetch failed" + code=0。
 */
export function explainError(err) {
  for (let cur = err, guard = 0; cur && typeof cur === 'object' && guard < 8; cur = cur.cause, guard += 1) {
    const m = PROXY_TUNNEL_RE.exec(String(cur.message ?? ''));
    if (!m) continue;
    const proxyStatus = Number(m[1]);
    return {
      code: `PROXY_${proxyStatus}`,
      hint: proxyStatusHint(proxyStatus),
      cause: `代理 CONNECT 返回 ${proxyStatus}`,
      proxyStatus,
      retryable: proxyStatus >= 500,
    };
  }

  const codes = [];
  for (let cur = err, guard = 0; cur && typeof cur === 'object' && guard < 8; cur = cur.cause, guard += 1) {
    for (const value of [cur.code, cur.errno]) {
      if (value == null || value === 0 || value === '') continue;
      const text = String(value);
      if (!codes.includes(text)) codes.push(text);
    }
  }
  // 已知错误码优先；DOMException 的 code=0（"未知"）上面已经排除
  const code = codes.find((c) => CODE_HINTS[c]) ?? codes[0] ?? '';
  const deep = rootCause(err);
  const deepMessage = String(deep?.message ?? '').slice(0, 200);
  // HTTP 4xx/5xx 的 message 已经是"HTTP 500"，再塞进 cause 只是重复
  const cause = !err?.status && !/^(fetch failed|Request was cancelled\.?)$/i.test(deepMessage) ? deepMessage : '';
  return { code, hint: CODE_HINTS[code] ?? '', cause, proxyStatus: null, retryable: null };
}

/**
 * 发请求拿文本。返回 {body,status,bytes,elapsedMs,contentType,finalUrl}。
 * opts: {logger, label, headers, timeoutMs, retries, fetchImpl, method, body}
 */
export async function fetchText(url, opts = {}) {
  const {
    logger = null,
    label = 'http',
    headers = {},
    timeoutMs = 20000,
    retries = 2,
    fetchImpl = null,
    method = 'GET',
    body,
    forceDirect = false,
  } = opts;

  // 传入 fetchImpl 时（测试/特殊场景）不干预出网通道；
  // forceDirect 强制直连（诊断/兜底用）；否则按主机决定是否走代理
  const route = fetchImpl
    ? { dispatcher: null, via: 'custom', proxy: null }
    : forceDirect
      ? { dispatcher: null, via: 'direct', proxy: null }
      : dispatcherFor(hostOf(url));
  const doFetch = fetchImpl ?? undici.fetch;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const requestId = rid();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    logger?.debug('http.request', {
      label,
      requestId,
      attempt: attempt + 1,
      method,
      url: redactUrl(url),
      timeoutMs,
      via: route.via,
      ...(route.proxy ? { proxy: route.proxy } : {}),
    });

    try {
      const res = await doFetch(url, {
        method,
        body,
        signal: controller.signal,
        redirect: 'follow',
        ...(route.dispatcher ? { dispatcher: route.dispatcher } : {}),
        headers: {
          accept: 'application/json, text/html;q=0.9, */*;q=0.8',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'user-agent': USER_AGENT,
          ...headers,
        },
      });
      const text = await res.text();
      const elapsedMs = Date.now() - startedAt;

      logger?.info('http.response', {
        label,
        requestId,
        attempt: attempt + 1,
        status: res.status,
        bytes: text.length,
        elapsedMs,
        contentType: res.headers.get('content-type'),
        finalUrl: redactUrl(res.url || url),
        via: route.via,
      });

      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.body = text.slice(0, 500);
        throw err;
      }
      return { body: text, status: res.status, bytes: text.length, elapsedMs, contentType: res.headers.get('content-type'), finalUrl: res.url };
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      lastError = err;
      const info = explainError(err);
      const aborted = err.name === 'AbortError';
      const code = aborted ? 'ABORTED' : info.code;
      const hint = errorHint(info, route, { aborted, timeoutMs });
      // 代理拒绝隧道（403/407）是配置问题，重试 3 次只会拖慢并刷屏；5xx 才值得再试
      const retryable = aborted
        ? true
        : info.proxyStatus != null
          ? info.retryable
          : !err.status || err.status === 429 || err.status >= 500;

      logger?.warn('http.error', {
        label,
        requestId,
        attempt: attempt + 1,
        elapsedMs,
        status: err.status ?? null,
        code,
        hint,
        message: String(err.message).slice(0, 200),
        // undici 把真正的网络原因埋在 cause 链最底层（如 "Proxy response (407) !== 200 when HTTP Tunneling"、
        // ECONNREFUSED、证书错误）。只打 "fetch failed" 等于没打，排障时必须有这一行。
        ...(info.cause ? { cause: info.cause } : {}),
        ...(info.proxyStatus != null ? { proxyStatus: info.proxyStatus } : {}),
        bodySnippet: err.body ? err.body.slice(0, 300) : undefined,
        via: route.via,
        retryable,
      });

      if (!retryable) break;
      if (attempt < retries) {
        const delayMs = 500 * (attempt + 1);
        logger?.info('http.retry', { label, requestId, attempt: attempt + 1, delayMs, status: err.status ?? null });
        await sleep(delayMs);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const info = explainError(lastError);
  const code = info.code;
  const hint = errorHint(info, route, { aborted: lastError?.name === 'AbortError' });
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* 保留原串 */
  }
  const finalErr = new Error(
    `${lastError?.message ?? 'request failed'}${code ? ` (${code})` : ''} → ${host}${hint ? ` · ${hint}` : ''}` +
      `${route.via !== 'direct' ? ` · 经 ${route.via}${route.proxy ? `(${route.proxy})` : ''}` : ''}`,
  );
  finalErr.status = lastError?.status;
  finalErr.body = lastError?.body;
  finalErr.code = code;
  finalErr.via = route.via;
  finalErr.cause = lastError?.cause;
  finalErr.proxyStatus = info.proxyStatus ?? undefined;
  finalErr.detail = info.cause || undefined;
  logger?.error('http.fail', {
    label,
    url: redactUrl(url),
    code,
    hint,
    status: lastError?.status ?? null,
    ...(info.cause ? { cause: info.cause } : {}),
    ...(info.proxyStatus != null ? { proxyStatus: info.proxyStatus } : {}),
    via: route.via,
  });
  throw finalErr;
}

/**
 * 发请求拿 JSON。解析失败时把响应片段打进日志——远端返回了 HTML 错误页
 * 是最常见的一类问题，光看 "Unexpected token <" 根本没法修。
 */
export async function fetchJson(url, opts = {}) {
  const res = await fetchText(url, opts);
  const { logger = null, label = 'http' } = opts;
  try {
    return { ...res, json: JSON.parse(res.body) };
  } catch (err) {
    logger?.error('http.parse_error', {
      label,
      status: res.status,
      bytes: res.bytes,
      contentType: res.contentType,
      bodySnippet: res.body.slice(0, 500),
      message: err.message,
    });
    const e = new Error(`响应不是合法 JSON：${err.message}`);
    e.status = res.status;
    e.body = res.body.slice(0, 500);
    throw e;
  }
}

/** 拉取原始字节（图片等二进制），走同一套代理与重试逻辑。 */
export async function fetchBuffer(url, opts = {}) {
  const { logger = null, label = 'img', timeoutMs = 15000, retries = 1, headers = {}, forceDirect = false } = opts;
  const route = forceDirect ? { dispatcher: null, via: 'direct', proxy: null } : dispatcherFor(hostOf(url));
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await undici.fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        ...(route.dispatcher ? { dispatcher: route.dispatcher } : {}),
        headers: { 'user-agent': USER_AGENT, ...headers },
      });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      const buf = Buffer.from(await res.arrayBuffer());
      return { body: buf, bytes: buf.length, status: res.status, contentType: res.headers.get('content-type') ?? 'image/jpeg' };
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error('fetchBuffer failed');
}
