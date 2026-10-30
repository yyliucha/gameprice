<script setup>
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';

const route = useRoute();
const email = String(route.query.email || '').trim();
const appealCode = String(route.query.code || '').trim();
const reason = String(route.query.reason || '访问受限').slice(0, 160);
const until = String(route.query.until || '').slice(0, 40);
const contactEmail = ref('');
const explanation = ref('');
const submitted = ref(false);
const body = computed(() => [
  `申诉编号：${appealCode || '未知'}`,
  `封禁原因：${reason}`,
  `解除时间：${until || '未提供'}`,
  `联系邮箱：${contactEmail.value.trim() || '未填写'}`,
  '',
  '申诉说明：',
  explanation.value.trim(),
].join('\n'));
const mailto = computed(() => email ? `mailto:${email}?subject=${encodeURIComponent(`[SteamDeals] 解封申请 ${appealCode}`)}&body=${encodeURIComponent(body.value)}` : '');

async function submitAppeal() {
  if (!email) return ElMessage.error('站点尚未配置申诉邮箱，请联系站点管理员。');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.value.trim())) return ElMessage.warning('请填写有效的联系邮箱。');
  if (explanation.value.trim().length < 10) return ElMessage.warning('请至少填写 10 个字说明情况。');
  const text = body.value;
  document.getElementById('appeal-copy-text').value = text;
  document.getElementById('appeal-copy-text').hidden = false;
  submitted.value = true;
  window.location.href = mailto.value;
}

async function copyAppeal() {
  const textarea = document.getElementById('appeal-copy-text');
  textarea.value = body.value;
  textarea.hidden = false;
  textarea.focus();
  textarea.select();
  try { await navigator.clipboard.writeText(body.value); ElMessage.success('申诉内容已复制，可粘贴到邮件中。'); }
  catch { ElMessage.info('内容已展开，请手动选中并复制。'); }
}
</script>

<template>
  <main class="appeal-page"><section class="appeal-card">
    <router-link to="/banned" class="back-link">← 返回访问受限说明</router-link>
    <p class="eyebrow">APPEAL</p><h1>申请解除访问限制</h1>
    <p class="intro">请说明当时的操作和网络情况，管理员会根据申诉编号核查访问记录。</p>
    <div class="appeal-meta"><span>申诉编号 <code>{{ appealCode || '未提供' }}</code></span><span>限制原因 {{ reason }}</span><span>解除时间 {{ until ? new Date(until).toLocaleString('zh-CN') : '未提供' }}</span></div>
    <el-alert v-if="!email" type="warning" :closable="false" title="站点尚未配置申诉邮箱，请联系站点管理员。" />
    <el-form label-position="top" @submit.prevent="submitAppeal">
      <el-form-item label="联系邮箱"><el-input v-model="contactEmail" type="email" autocomplete="email" placeholder="管理员用于回复申诉的邮箱" /></el-form-item>
      <el-form-item label="申诉说明"><el-input v-model="explanation" type="textarea" :rows="6" maxlength="2000" show-word-limit placeholder="请说明你当时在进行什么操作、是否使用自动化脚本、是否与他人共用网络。" /></el-form-item>
      <div class="appeal-actions"><el-button type="primary" :disabled="!email" @click="submitAppeal">{{ submitted ? '重新打开邮件客户端' : '提交解封申请' }}</el-button><el-button plain @click="copyAppeal">复制申请内容</el-button></div>
    </el-form>
    <el-alert v-if="submitted" class="submitted" type="success" :closable="false" title="申请内容已准备好" description="如果邮件客户端没有自动打开，请复制下方内容，发送至页面提供的申诉邮箱。" />
    <textarea id="appeal-copy-text" readonly hidden aria-label="申诉内容" @focus="$event.target.select()" />
    <p v-if="email" class="recipient">申诉邮箱：<a :href="`mailto:${email}`">{{ email }}</a></p>
  </section></main>
</template>

<style scoped>
.appeal-page{min-height:100vh;display:grid;place-items:center;padding:28px;background:radial-gradient(ellipse at 50% -15%,#e8eaff,transparent 48%),#f5f7fb;color:#202a3d}.appeal-card{width:min(690px,100%);padding:30px;border:1px solid #e7eaf1;border-radius:18px;background:#fff;box-shadow:0 16px 44px #26345a12}.back-link{color:#6860d6;text-decoration:none;font-size:12px}.eyebrow{margin:26px 0 6px;color:#7067de;font-size:10px;font-weight:800;letter-spacing:.2em}.appeal-card h1{margin:0;font-size:27px;letter-spacing:-.04em}.intro{margin:8px 0 18px;color:#818b9d;font-size:13px}.appeal-meta{display:grid;gap:9px;padding:13px 15px;margin-bottom:20px;border:1px solid #e8ebf1;border-radius:11px;background:#f9faff;color:#59657a;font-size:12px}.appeal-meta code{margin-left:6px}.appeal-card :deep(.el-form-item){margin-bottom:14px}.appeal-card :deep(.el-form-item__label){font-size:12px;font-weight:650}.appeal-actions{display:flex;gap:8px;flex-wrap:wrap}.submitted{margin-top:14px}.appeal-card textarea{width:100%;min-height:120px;margin-top:12px;padding:10px;border:1px solid #e2e6ef;border-radius:9px;color:#445068;background:#fafbfe;font:12px/1.6 ui-monospace,monospace;resize:vertical}.recipient{margin:16px 0 0;color:#8992a3;font-size:12px}.recipient a{color:#6258d9}@media(max-width:600px){.appeal-page{padding:14px}.appeal-card{padding:22px 17px}.appeal-card h1{font-size:23px}}
</style>
