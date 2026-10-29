<script setup>
import { computed, ref } from 'vue';

const info = window.__BAN_PAGE__ || {};
const language = ref(/^zh/i.test(navigator.language || '') ? 'zh-CN' : 'en');
const copied = ref(false);
const message = ref('');
const appealText = computed(() => `${language.value === 'zh-CN' ? '申诉编号' : 'Appeal code'}: ${info.code || '—'}\n${language.value === 'zh-CN' ? '时间' : 'Time'}: ${info.until || new Date().toISOString()}\n${language.value === 'zh-CN' ? '原因' : 'Reason'}: ${info.reason || '—'}\n\n${language.value === 'zh-CN' ? '请说明当时正在进行的操作，以及是否使用脚本或共享网络。' : 'Please describe what you were doing, and whether scripts or a shared network were used.'}`);
const title = computed(() => language.value === 'zh-CN' ? '访问受限' : 'Access restricted');
const lead = computed(() => language.value === 'zh-CN' ? '你的网络或设备暂时被本站限制访问。' : 'Your network or device is temporarily restricted from this site.');
const appealTitle = computed(() => language.value === 'zh-CN' ? '如果你认为这是误判' : 'Think this is a mistake?');
const appealLead = computed(() => language.value === 'zh-CN' ? '发送邮件申诉，管理员会人工复核。' : 'Send an appeal email and an administrator will review it.');
const mailto = computed(() => info.email ? `mailto:${info.email}?subject=${encodeURIComponent(`[${info.site || 'SteamDeals'}] ${language.value === 'zh-CN' ? '解封申诉' : 'Ban appeal'} ${info.code || ''}`)}&body=${encodeURIComponent(appealText.value)}` : '');

async function copyAppeal() {
  copied.value = false;
  try { await navigator.clipboard.writeText(`${appealText.value}\nEmail: ${info.email || ''}`); copied.value = true; message.value = language.value === 'zh-CN' ? '申诉内容已复制，可粘贴到邮件中。' : 'Appeal text copied.'; }
  catch { message.value = language.value === 'zh-CN' ? '复制失败，请选中文本手动复制。' : 'Copy failed. Select and copy the text manually.'; }
}
</script>

<template>
  <main class="ban-page"><article class="ban-card">
    <div class="ban-top"><span class="ban-logo">%</span><strong>{{ info.site || 'SteamDeals' }}</strong><el-select v-model="language" size="small" class="ban-language"><el-option label="简体中文" value="zh-CN"/><el-option label="English" value="en"/></el-select></div>
    <el-tag type="danger" effect="light">{{ info.status || 403 }}</el-tag>
    <h1>{{ title }}</h1><p class="ban-lead">{{ lead }}</p>
    <dl><div><dt>{{ language === 'zh-CN' ? '原因' : 'Reason' }}</dt><dd>{{ info.reason || '—' }}</dd></div><div><dt>{{ language === 'zh-CN' ? '限制解除时间' : 'Restriction ends' }}</dt><dd>{{ info.until ? new Date(info.until).toLocaleString(language) : (language === 'zh-CN' ? '暂未设定' : 'Not specified') }}</dd></div><div><dt>{{ language === 'zh-CN' ? '申诉编号' : 'Appeal code' }}</dt><dd><code>{{ info.code || '—' }}</code></dd></div></dl>
    <section class="ban-appeal"><h2>{{ appealTitle }}</h2><p>{{ appealLead }}</p>
      <div v-if="info.email" class="ban-actions"><a class="ban-primary" :href="mailto">{{ language === 'zh-CN' ? '发送申诉邮件' : 'Send appeal email' }}</a><el-button plain @click="copyAppeal">{{ language === 'zh-CN' ? '复制申诉内容' : 'Copy appeal text' }}</el-button></div>
      <el-alert v-else type="warning" :closable="false" :title="language === 'zh-CN' ? '管理员尚未配置申诉邮箱，请联系站点管理员。' : 'The administrator has not configured an appeal email.'" />
      <el-alert v-if="message" class="ban-message" :type="copied ? 'success' : 'info'" :title="message" :closable="false"/>
      <textarea :value="appealText" readonly @focus="$event.target.select()" :aria-label="language === 'zh-CN' ? '申诉内容' : 'Appeal text'" />
      <p class="ban-hint">{{ language === 'zh-CN' ? '如果邮件客户端未打开，可以复制上方申诉内容并发送至' : 'If your mail app did not open, copy the appeal text and send it to' }} <b>{{ info.email || '—' }}</b></p>
    </section>
    <footer><span>{{ language === 'zh-CN' ? '访问被拒绝' : 'Access denied' }} · {{ info.status || 403 }}</span><a href="/">{{ language === 'zh-CN' ? '返回首页' : 'Home' }}</a></footer>
  </article></main>
</template>

<style scoped>
.ban-page{min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(1000px 440px at 50% -5%,#7166df1b,transparent),#f6f7fa;color:#202a3d}.ban-card{width:min(620px,100%);padding:28px;border:1px solid #e5e8ef;border-radius:18px;background:#fff;box-shadow:0 18px 48px #202a3d12}.ban-top{display:flex;align-items:center;gap:10px;margin-bottom:22px}.ban-logo{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;color:#fff;font-weight:800;background:linear-gradient(135deg,#22d3ee,#4f46e5)}.ban-language{width:120px;margin-left:auto}.ban-card h1{font-size:24px;margin:12px 0 4px}.ban-lead,.ban-appeal p{color:#7f899b;font-size:13px}.ban-card dl{margin:18px 0;border:1px solid #e8ebf1;border-radius:12px;overflow:hidden}.ban-card dl div{display:flex;gap:12px;padding:10px 13px;border-bottom:1px solid #edf0f4;font-size:13px}.ban-card dl div:last-child{border:0}.ban-card dt{min-width:105px;color:#8a94a6}.ban-card dd{margin:0;overflow-wrap:anywhere}.ban-appeal{padding:16px;border:1px solid #e5e4fc;border-radius:12px;background:#f8f8ff}.ban-appeal h2{font-size:15px;margin:0}.ban-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.ban-primary{display:inline-flex;align-items:center;padding:8px 14px;border-radius:8px;background:#6258d9;color:#fff;text-decoration:none;font-size:13px;font-weight:600}.ban-appeal textarea{width:100%;min-height:98px;padding:10px;border:1px solid #e3e6ed;border-radius:8px;color:#475268;background:#fff;font:12px/1.5 ui-monospace,monospace;resize:vertical}.ban-message{margin:8px 0}.ban-hint{font-size:11px!important}.ban-card footer{display:flex;justify-content:space-between;margin-top:18px;color:#8992a2;font-size:12px}.ban-card footer a{color:#6258d9;text-decoration:none}@media(prefers-color-scheme:dark){.ban-page{background:#0b1020;color:#e6eaf2}.ban-card{background:#121a2e;border-color:#26344f}.ban-card dl,.ban-card dl div{border-color:#26344f}.ban-appeal{background:#181b33;border-color:#38345e}.ban-appeal textarea{background:#0d1425;color:#e6eaf2;border-color:#26344f}}
</style>
