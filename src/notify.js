// 提醒通道：通用 webhook / 企业微信群机器人 / 邮件（SMTP）。
//
// 邮件没有引入 nodemailer，而是自己实现最小 SMTP 客户端（EHLO → STARTTLS →
// AUTH → MAIL/RCPT/DATA）。这样做的好处是运行时依赖仍然只有 pg，且协议对话
// 可以在本地假 SMTP 服务器上逐行断言——比"配好了应该能发"可靠得多。
//
// 代价：只实现 PLAIN / LOGIN 两种认证与 STARTTLS，不支持 OAuth2 与附件。
import net from 'node:net';
import tls from 'node:tls';
import { serializeError } from './log.js';

// ---------------------------------------------------------------- 通道发现

/** 从环境变量读出已配置的通道。没有配任何通道时返回空数组。 */
export function channelsFromEnv(env = process.env) {
  const channels = [];
  if (env.ALERT_WEBHOOK_URL) {
    channels.push({ name: 'webhook', kind: 'webhook', url: env.ALERT_WEBHOOK_URL });
  }
  if (env.WECOM_WEBHOOK_URL) {
    channels.push({ name: 'wecom', kind: 'wecom', url: env.WECOM_WEBHOOK_URL });
  }
  if (env.SMTP_HOST && env.ALERT_EMAIL_TO) {
    channels.push({
      name: 'email',
      kind: 'email',
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT ?? 465),
      secure: (env.SMTP_SECURE ?? '1') !== '0',
      user: env.SMTP_USER ?? '',
      pass: env.SMTP_PASS ?? '',
      from: env.SMTP_FROM ?? env.SMTP_USER ?? '',
      to: env.ALERT_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return channels;
}

export const hasNotifier = (env = process.env) => channelsFromEnv(env).length > 0;

// ---------------------------------------------------------------- HTTP 投递

export async function postJson(url, payload, { fetchImpl = globalThis.fetch, logger = null, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'steamdeals-notify/1.0' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    logger?.info('notify.http', { status: res.status, bytes: text.length, ok: res.ok });
    return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
  } catch (err) {
    logger?.error('notify.http_failed', { err: serializeError(err) });
    return { ok: false, status: null, error: String(err.message).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** 企业微信群机器人：{"msgtype":"text","text":{"content":...}}，errcode=0 才算成功。 */
export async function sendWecom(text, { url, fetchImpl, logger = null } = {}) {
  const res = await postJson(url, { msgtype: 'text', text: { content: text } }, { fetchImpl, logger });
  let errcode = null;
  let errmsg = null;
  try {
    const body = JSON.parse(res.body ?? '{}');
    errcode = body.errcode ?? null;
    errmsg = body.errmsg ?? null;
  } catch {
    /* 非 JSON（可能是网关错误页），保持 null */
  }
  const ok = res.ok && (errcode === 0 || errcode === null);
  logger?.info('notify.wecom', { ok, status: res.status, errcode, errmsg });
  return { ok, status: res.status, errcode, errmsg };
}

// ---------------------------------------------------------------- 邮件内容

const BASE64_LINE = 76;

/** 非 ASCII 主题必须按 RFC 2047 编码，否则客户端会显示乱码。 */
export function encodeSubject(subject) {
  const text = String(subject ?? '');
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

export function buildMessage({ from, to, subject, text, date = new Date(), messageId = null }) {
  const recipients = Array.isArray(to) ? to.join(', ') : String(to);
  const body = Buffer.from(String(text ?? ''), 'utf8')
    .toString('base64')
    .replace(new RegExp(`(.{${BASE64_LINE}})`, 'g'), '$1\r\n');
  const id = messageId ?? `<${Date.now()}.${Math.random().toString(36).slice(2, 10)}@steamdeals>`;
  return [
    `From: ${from}`,
    `To: ${recipients}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    `Reply-To: ${from}`,
    'X-Mailer: SteamDeals',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

// ---------------------------------------------------------------- SMTP 客户端

class SmtpSession {
  constructor({ logger = null, timeoutMs = 15000 } = {}) {
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.closed = false;
    this.trace = [];
  }

  attach(socket) {
    // STARTTLS 升级后旧 socket 上的监听必须摘掉，否则同一条回复会被投递两次
    if (this.socket && this.socket !== socket) {
      this.socket.removeAllListeners('data');
      this.socket.removeAllListeners('error');
      this.socket.removeAllListeners('close');
    }
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this.drain();
    });
    socket.on('error', (err) => this.failAll(err));
    socket.on('close', () => {
      this.closed = true;
      this.failAll(new Error('SMTP 连接已关闭'));
    });
  }

  drain() {
    let idx;
    // SMTP 多行回复形如 "250-XXX" 若干行 + "250 YYY" 结束行
    while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const waiter = this.waiters.shift();
        const reply = { code: Number(line.slice(0, 3)), lines: this.lines.slice() };
        this.lines = [];
        waiter?.resolve(reply);
      }
    }
  }

  failAll(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  read() {
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject: null };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`SMTP 响应超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.waiters.push(waiter);
    });
  }

  async cmd(line, { expect = [250] } = {}) {
    this.logger?.trace('smtp.cmd', { line: /^(AUTH|MAIL|RCPT)/.test(line) ? line.split(' ')[0] : line });
    this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    this.trace.push({ cmd: line.split(/[ :]/)[0], code: reply.code, text: reply.lines.join(" | ").slice(0, 160) });
    if (!expect.includes(reply.code)) {
      const err = new Error(`SMTP ${line.split(' ')[0]} 失败：${reply.code} ${reply.lines.join(' | ')}`);
      err.code = reply.code;
      throw err;
    }
    return reply;
  }

  close() {
    this.closed = true;
    try {
      this.socket?.end();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 建立连接（465 隐式 TLS / 其他端口先明文再 STARTTLS）。 */
async function openSocket({ host, port, secure, timeoutMs }) {
  const connect = secure ? tls.connect : net.connect;
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`SMTP 连接超时（${host}:${port}，${timeoutMs}ms）`));
    }, timeoutMs);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function capabilities(reply) {
  return reply.lines.map((l) => l.slice(4).toUpperCase());
}

/**
 * 发一封纯文本邮件。返回 { ok, code } 或抛出错误（由调用方决定是否中断）。
 * 支持 AUTH PLAIN / LOGIN 与 STARTTLS；不支持 OAuth2。
 */
export async function sendMail(
  { host, port = 465, secure = true, user = '', pass = '', from, to, subject, text },
  { logger = null, timeoutMs = 15000 } = {},
) {
  const session = new SmtpSession({ logger, timeoutMs });
  try {
    session.attach(await openSocket({ host, port, secure, timeoutMs }));
    const greeting = await session.read();
    if (greeting.code !== 220) throw new Error(`SMTP 握手失败：${greeting.code}`);

    const hostname = 'steamdeals.local';
    let ehlo = await session.cmd(`EHLO ${hostname}`);
    let caps = capabilities(ehlo);

    if (!secure && caps.includes('STARTTLS')) {
      await session.cmd('STARTTLS', { expect: [220] });
      session.attach(await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket: session.socket, servername: host }, () => resolve(upgraded));
        upgraded.once('error', reject);
      }));
      ehlo = await session.cmd(`EHLO ${hostname}`);
      caps = capabilities(ehlo);
    }

    if (user) {
      if (caps.includes('AUTH PLAIN') || caps.some((c) => c.startsWith('AUTH') && c.includes('PLAIN'))) {
        const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
        await session.cmd(`AUTH PLAIN ${token}`, { expect: [235] });
      } else if (caps.some((c) => c.includes('LOGIN'))) {
        await session.cmd('AUTH LOGIN', { expect: [334] });
        await session.cmd(Buffer.from(user, 'utf8').toString('base64'), { expect: [334] });
        await session.cmd(Buffer.from(pass, 'utf8').toString('base64'), { expect: [235] });
      } else {
        throw new Error('服务器未提供可用的 AUTH 机制（PLAIN/LOGIN）');
      }
    }

    await session.cmd(`MAIL FROM:<${from}>`, { expect: [250] });
    for (const rcpt of Array.isArray(to) ? to : [to]) {
      await session.cmd(`RCPT TO:<${rcpt}>`, { expect: [250, 251] });
    }
    await session.cmd('DATA', { expect: [354] });
    const message = buildMessage({ from, to, subject, text });
    await session.cmd(`${message}\r\n.`, { expect: [250] });
    await session.cmd('QUIT', { expect: [221] });
    logger?.info('notify.email_sent', { host, to: Array.isArray(to) ? to.length : 1 });
    return { ok: true, code: 250, steps: session.trace };
  } catch (err) {
    err.steps = session.trace;
    logger?.error('notify.email_failed', { host, err: serializeError(err) });
    return { ok: false, error: String(err.message).slice(0, 300), code: err.code ?? null };
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------- 统一投递

/** 按通道逐个投递；任一通道成功即视为"已送达"，但每个通道的结果都会记录。 */
export async function deliver(channels, { text, payload, subject = '游戏价格提醒', logger = null, fetchImpl = globalThis.fetch } = {}) {
  const results = [];
  for (const ch of channels) {
    try {
      if (ch.kind === 'email') {
        results.push({ channel: ch.name, ...(await sendMail({ ...ch, subject, text }, { logger })) });
      } else if (ch.kind === 'wecom') {
        results.push({ channel: ch.name, ...(await sendWecom(text, { url: ch.url, fetchImpl, logger })) });
      } else {
        results.push({ channel: ch.name, ...(await postJson(ch.url, payload ?? { text }, { fetchImpl, logger })) });
      }
    } catch (err) {
      logger?.error('notify.channel_failed', { channel: ch.name, err: serializeError(err) });
      results.push({ channel: ch.name, ok: false, error: String(err.message).slice(0, 200) });
    }
  }
  const ok = results.some((r) => r.ok);
  logger?.info('notify.delivered', {
    channels: results.length,
    ok,
    detail: results.map((r) => `${r.channel}:${r.ok ? 'ok' : 'fail'}`).join(','),
  });
  return { ok, results };
}
