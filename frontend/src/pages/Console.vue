<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <a href="/" class="admin-brand"><span class="brand-mark">S</span><span>SteamDeals<small>管理控制台</small></span></a>
      <div class="admin-search"><el-input v-model="filter" placeholder="搜索管理功能" clearable><template #prefix><el-icon><Search /></el-icon></template></el-input></div>
      <nav class="admin-nav">
        <template v-for="group in visibleGroups" :key="group.name">
          <div class="nav-heading">{{ group.name }}</div>
          <button v-for="item in group.items" :key="item.id" :class="{ active: selected === item.id }" @click="select(item)"><span class="nav-glyph">{{ item.glyph }}</span><span>{{ item.label }}</span><el-icon v-if="selected === item.id" class="arrow"><ArrowRight /></el-icon></button>
        </template>
        <el-empty v-if="!visibleGroups.length" :image-size="44" description="没有匹配的功能" />
      </nav>
      <div class="admin-bottom"><el-tag v-if="user" type="success" effect="plain">{{ user.display_name || user.username }}</el-tag><el-button text @click="router.push('/')">返回网站 ↗</el-button></div>
    </aside>
    <main class="admin-content">
      <header class="admin-header"><div><div class="admin-crumb">管理中心 <span>/</span> {{ selectedItem?.group }}</div><h1>{{ selectedItem?.label }}</h1><p>{{ selectedItem?.description }}</p></div></header>
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

const router=useRouter(), route=useRoute(), filter=ref(''), user=ref(null);
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
onMounted(async()=>{try{const valid=groups.some(g=>g.items.some(i=>i.id===selected.value));if(!valid)selected.value='games';const res=await fetch('/api/me',{credentials:'same-origin'});const data=await res.json();user.value=data.user||null;if(user.value?.role!=='admin'){ElMessage.warning('此页面需要管理员账号登录');router.replace('/');}}catch{ElMessage.error('无法验证管理员身份');router.replace('/');}});
</script>
