<script setup>
import { onMounted, reactive, ref } from 'vue';

const status = ref(null);
const schema = ref(null);
const loading = ref(true);
const saving = ref(false);
const message = ref('');
const error = ref(false);
const token = ref('');
const admin = reactive({ username: '', email: '', password: '', confirm: '' });
const values = reactive({});

async function request(url, options) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

onMounted(async () => {
  try {
    const result = await request('/api/setup/status');
    if (!result.response.ok) throw new Error(result.body.error || `HTTP ${result.response.status}`);
    status.value = result.body;
    if (result.body.completed) { location.replace('/'); return; }
    if (result.body.hasAdmin) return;
    const config = await request('/api/setup/schema');
    if (!config.response.ok) throw new Error(config.body.error || `HTTP ${config.response.status}`);
    schema.value = config.body;
    for (const field of config.body.fields || []) {
      if (field.group === 'advanced' || field.advanced) continue;
      values[field.key] = field.type === 'bool' ? Boolean(config.body.values?.[field.key]) : (config.body.values?.[field.key] ?? '');
    }
  } catch (err) {
    message.value = err.message || String(err);
    error.value = true;
  } finally { loading.value = false; }
});

async function complete() {
  message.value = '';
  if (!/^[^\s/]{3,32}$/.test(admin.username)) { message.value = '用户名需要 3-32 个字符，且不能包含空格或斜杠'; error.value = true; return; }
  if (admin.password.length < 8) { message.value = '密码至少 8 位'; error.value = true; return; }
  if (admin.password !== admin.confirm) { message.value = '两次输入的密码不一致'; error.value = true; return; }
  saving.value = true;
  try {
    const settings = {};
    for (const field of (schema.value?.fields || [])) {
      if (field.group === 'advanced' || field.advanced) continue;
      const value = values[field.key];
      if (field.type === 'secret' && !String(value || '').trim()) continue;
      if (value === '' || value == null) continue;
      settings[field.key] = field.type === 'int' ? Number(value) : value;
    }
    const result = await request('/api/setup/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ admin: { username: admin.username.trim(), email: admin.email.trim() || null, password: admin.password }, settings, setupToken: token.value }),
    });
    if (result.response.ok || result.response.status === 409) {
      message.value = '初始化完成，正在进入控制台…'; error.value = false;
      setTimeout(() => location.replace('/console'), 700);
      return;
    }
    throw new Error(result.body.error || `初始化失败：HTTP ${result.response.status}`);
  } catch (err) { message.value = err.message || String(err); error.value = true; }
  finally { saving.value = false; }
}
</script>

<template>
  <main class="setup-page">
    <header><span class="setup-mark">S</span><strong>SteamDeals</strong><span class="setup-tag">首次启动</span></header>
    <section class="setup-intro"><p class="eyebrow">WELCOME</p><h1>初始化系统</h1><p>创建管理员并确认基础配置。完成前，前台和 API 不会对外开放。</p></section>
    <el-skeleton v-if="loading" :rows="6" animated />
    <el-alert v-else-if="error && !schema" type="error" :title="message" :closable="false" />
    <section v-else-if="status?.hasAdmin" class="setup-card"><el-alert type="info" title="检测到已存在管理员" description="请直接登录控制台，在系统设置中检查配置。" :closable="false"/><el-button type="primary" class="setup-submit" @click="location.href='/console'">前往控制台</el-button></section>
    <template v-else-if="schema">
      <div class="setup-status">版本 <b>{{ status?.version || '—' }}</b><span>数据库</span><b>{{ status?.database || '—' }}</b><el-tag v-if="status?.setupTokenRequired" size="small" type="warning">需要初始化口令</el-tag></div>
      <el-form label-position="top" class="setup-form">
        <section v-if="status?.setupTokenRequired" class="setup-card"><h2>初始化口令</h2><p>口令由部署者设置，或在首次启动日志中生成。</p><el-form-item label="SETUP_TOKEN"><el-input v-model="token" type="password" show-password autocomplete="off" /></el-form-item></section>
        <section class="setup-card"><h2>管理员账号</h2><p>第一个管理员拥有全部权限；密码使用安全哈希存储。</p><div class="setup-grid">
          <el-form-item label="用户名"><el-input v-model="admin.username" autocomplete="username" placeholder="3-32 位，不能有空格" /></el-form-item>
          <el-form-item label="登录邮箱（可选）"><el-input v-model="admin.email" type="email" autocomplete="email" placeholder="用于验证码登录和找回密码" /></el-form-item>
          <el-form-item label="密码"><el-input v-model="admin.password" type="password" show-password autocomplete="new-password" placeholder="至少 8 位" /></el-form-item>
          <el-form-item label="确认密码"><el-input v-model="admin.confirm" type="password" show-password autocomplete="new-password" /></el-form-item>
        </div></section>
        <section v-for="group in schema.groups || []" :key="group.id" class="setup-card" v-show="group.id !== 'advanced' && (schema.fields || []).some(f => f.group === group.id && !f.advanced)">
          <h2>{{ group.title }}</h2><p v-if="group.description">{{ group.description }}</p>
          <el-form-item v-for="field in (schema.fields || []).filter(f => f.group === group.id && !f.advanced)" :key="field.key" :label="field.label">
            <el-switch v-if="field.type === 'bool'" v-model="values[field.key]" />
            <el-select v-else-if="field.type === 'enum'" v-model="values[field.key]" class="setup-control"><el-option v-for="option in field.options || []" :key="option" :label="option" :value="option" /></el-select>
            <el-input v-else v-model="values[field.key]" :type="field.type === 'secret' ? 'password' : field.type === 'int' ? 'number' : 'text'" :min="field.min" :max="field.max" :placeholder="field.help || ''" :show-password="field.type === 'secret'" />
            <small v-if="field.help">{{ field.help }}</small>
          </el-form-item>
        </section>
        <el-alert class="setup-notice" type="warning" :closable="false" title="建议先配置 Steam 代理或 ITAD API Key" description="其他选项可以在初始化后到控制台的系统设置修改。" />
        <div class="setup-actions"><el-button type="primary" :loading="saving" @click="complete">完成初始化</el-button><span>完成后会自动登录并进入控制台。</span></div>
        <el-alert v-if="message" :type="error ? 'error' : 'success'" :title="message" :closable="false" />
      </el-form>
    </template>
  </main>
</template>

<style scoped>
.setup-page{max-width:820px;margin:0 auto;padding:34px 22px 72px;color:var(--fg)}.setup-page header{display:flex;align-items:center;gap:10px}.setup-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;color:white;font-weight:800;background:linear-gradient(135deg,var(--brand-2),var(--brand))}.setup-tag{margin-left:auto;color:var(--fg-muted);font-size:12px}.setup-intro{padding:36px 0 18px}.eyebrow{font-size:10px;font-weight:700;letter-spacing:.18em;color:var(--brand);margin:0 0 8px}.setup-intro h1{font-size:30px;margin:0}.setup-intro>p:last-child,.setup-card>p{color:var(--fg-muted);font-size:13px}.setup-status{display:flex;align-items:center;gap:8px;color:var(--fg-muted);font-size:12px;margin:6px 0 16px}.setup-status b{color:var(--fg-2);font-weight:600}.setup-card{padding:20px;margin:14px 0;border:1px solid var(--border);border-radius:14px;background:var(--panel);box-shadow:0 5px 20px #25324a08}.setup-card h2{font-size:14px;margin:0 0 4px}.setup-card>p{margin:4px 0 14px}.setup-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 18px}.setup-card :deep(.el-form-item){margin-bottom:12px}.setup-card :deep(.el-form-item__label){font-size:12px;font-weight:600;padding-bottom:4px}.setup-card small{display:block;color:var(--fg-muted);font-size:11px;margin-top:4px;line-height:1.5}.setup-control{width:100%}.setup-notice{margin:14px 0}.setup-actions{display:flex;align-items:center;gap:14px;margin:18px 0;color:var(--fg-muted);font-size:12px}@media(max-width:620px){.setup-page{padding:24px 15px}.setup-grid{grid-template-columns:1fr}.setup-intro{padding-top:26px}.setup-actions{align-items:flex-start;flex-direction:column}}
</style>
