<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <a href="/" class="admin-brand"><span class="brand-mark">S</span><span>SteamDeals<small>管理控制台</small></span></a>
      <div class="admin-search"><el-input v-model="filter" placeholder="搜索管理功能" clearable @keyup.enter="onFilterEnter"><template #prefix><el-icon><Search /></el-icon></template></el-input></div>
      <nav class="admin-nav">
        <template v-for="group in visibleGroups" :key="group.name">
          <div class="nav-heading">{{ group.name }}</div>
          <button v-for="item in group.items" :key="item.id" :class="{ active: selected === item.id }" @click="select(item)"><span class="nav-glyph">{{ item.glyph }}</span><span>{{ item.label }}</span><el-icon v-if="selected === item.id" class="arrow"><ArrowRight /></el-icon></button>
        </template>
        <el-empty v-if="!visibleGroups.length" :image-size="44" description="没有匹配的功能" />
      </nav>
      <div class="admin-bottom"><el-tag v-if="user" type="success" effect="plain">{{ user.display_name || user.username }}</el-tag><el-button text @click="router.push('/')">返回网站 ↗</el-button>
        <div class="admin-version" :title="versionTitle" @click="loadVersion(true)">
          <span v-if="versionLoading" class="version-text">版本 检查中…</span>
          <span v-else-if="verInfo.error && !verInfo.current" class="version-text">版本检查失败（悬停查看原因）</span>
          <span v-else class="version-text">版本 v{{ verInfo.current || '—' }}</span>
          <a v-if="verInfo.updateAvailable && verInfo.latest" :href="verInfo.url || '#'" target="_blank" rel="noopener" class="version-update" @click.stop>↑ 新版 v{{ String(verInfo.latest).replace(/^v/i, '') }} 可用</a>
        </div>
      </div>
    </aside>
    <main class="admin-content">
      <header class="admin-header"><div><div class="admin-crumb">管理中心 <span>/</span> {{ selectedItem?.group }}</div><h1>{{ selectedItem?.label }}</h1><p>{{ selectedItem?.description }}</p></div><el-button text class="theme-btn" :title="themeMode === 'dark' ? '切换亮色' : '切换暗色'" @click="toggleTheme">{{ themeMode === 'dark' ? '🌞' : '🌙' }}</el-button></header>
      <AdminModules v-if="nativeSections.includes(selected)" :section="selected" />
      <AdminExtras v-else :section="selected" />
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowRight, Search } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import AdminModules from './AdminModules.vue';
import AdminExtras from './AdminExtras.vue';
import { useTheme } from '../composables/useTheme.js';

const router=useRouter(), route=useRoute(), filter=ref(''), user=ref(null);
const theme = useTheme();
const themeMode = theme.mode;
function toggleTheme(){
  const m = themeMode.value === 'dark' ? 'light' : 'dark';
  theme.set(m);
  if (user.value) {
    fetch('/api/prefs', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: m }) }).catch(() => {});
  }
}
const nativeSections=['games','visitors','announcements','settings','stats'];
const groups=[
  {name:'内容运营',items:[{id:'games',label:'游戏管理',glyph:'▦',description:'维护游戏目录、采集计划与数据回填'},{id:'recycle',label:'回收站',glyph:'▤',description:'查看并恢复已删除的游戏'},{id:'announcements',label:'站点通知',glyph:'▱',description:'发布和管理网站公告'}]},
  {name:'访问与安全',items:[{id:'visitors',label:'访问记录',glyph:'◉',description:'流量、异常请求和访问控制'}]},
  {name:'账号与服务',items:[{id:'users',label:'用户管理',glyph:'♙',description:'管理账号、角色与登录权限'},{id:'steam',label:'Steam 账号',glyph:'◈',description:'查看已连接的 Steam 账号与游戏库'},{id:'mail',label:'邮件服务',glyph:'✉',description:'配置 SMTP、测试邮件和发送记录'}]},
  {name:'系统',items:[{id:'settings',label:'系统设置',glyph:'⚙',description:'数据源、网络代理与提醒配置'},{id:'stats',label:'数据统计',glyph:'▥',description:'价格变化、缓存、备份与访问排行'},{id:'sync',label:'运行日志',glyph:'≋',description:'查看服务实时输出和同步记录'}]},
];
const selected=ref(String(route.query.section||'games'));
const selectedItem=computed(()=>groups.flatMap(g=>g.items.map(i=>({...i,group:g.name}))).find(i=>i.id===selected.value)||groups[0].items[0]);
const visibleGroups=computed(()=>{const q=filter.value.trim().toLocaleLowerCase();return groups.map(g=>({...g,items:g.items.filter(i=>!q||`${i.label} ${i.description} ${g.name}`.toLocaleLowerCase().includes(q))})).filter(g=>g.items.length);});
async function select(item){ selected.value=item.id; await router.replace({path:'/console',query:{section:item.id}}); }
// 侧栏搜索按 Enter：直接打开第一个匹配的功能
function onFilterEnter(){const first=visibleGroups.value[0]?.items[0];if(first){filter.value='';select(first);}else if(filter.value.trim()){ElMessage.warning('没有匹配的功能');}}

// 版本检查：进入控制台自动查一次（走服务端缓存），点击带 force=1 重新检查
const verInfo=ref({current:null,latest:null,updateAvailable:false,url:null,checkedAt:null,error:null});
const versionLoading=ref(false);
const versionTitle=computed(()=>{
  if(versionLoading.value)return '正在检查新版本…';
  if(verInfo.value.error)return '版本检查失败：'+verInfo.value.error;
  if(verInfo.value.checkedAt)return '上次检查：'+new Date(verInfo.value.checkedAt).toLocaleString()+'（点击重新检查）';
  return '点击检查新版本';
});
async function loadVersion(force){
  versionLoading.value=true;
  try{
    const res=await fetch('/api/admin/version'+(force?'?force=1':''),{credentials:'same-origin'});
    const d=await res.json();
    if(!res.ok)throw new Error(d.error||`HTTP ${res.status}`);
    verInfo.value=d;
  }catch(e){verInfo.value={...verInfo.value,error:e.message};}
  finally{versionLoading.value=false;}
}

onMounted(async()=>{try{const valid=groups.some(g=>g.items.some(i=>i.id===selected.value));if(!valid)selected.value='games';const res=await fetch('/api/me',{credentials:'same-origin'});const data=await res.json();user.value=data.user||null;if(user.value?.role!=='admin'){ElMessage.warning('此页面需要管理员账号登录');router.replace('/');return;}const st=data.prefs?.theme;if(st==='light'||st==='dark'){if(theme.storedMode()!==st)theme.set(st);}else if(theme.storedMode()){fetch('/api/prefs',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({theme:theme.storedMode()})}).catch(()=>{});}}catch{ElMessage.error('无法验证管理员身份');router.replace('/');return;}loadVersion(false);});
</script>

<style scoped>
.theme-btn{font-size:17px}
.admin-version{margin-top:9px;padding-top:9px;border-top:1px solid var(--border);cursor:pointer;display:flex;flex-direction:column;gap:3px;text-align:left}
.version-text{font-size:11px;color:var(--fg-muted)}
.version-update{font-size:11px;color:var(--warn);text-decoration:none;font-weight:600}
.version-update:hover{text-decoration:underline}
</style>
