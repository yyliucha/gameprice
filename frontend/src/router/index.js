import { createRouter, createWebHistory } from 'vue-router';
import Home from '../pages/Home.vue';
import Setup from '../pages/Setup.vue';
import BanPage from '../pages/BanPage.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home, meta: { title: 'SteamDeals · 游戏价格' } },
    { path: '/index.html', redirect: '/' },
    { path: '/setup', name: 'setup', component: Setup, meta: { title: 'SteamDeals · 系统初始化' } },
    { path: '/setup.html', redirect: '/setup' },
    { path: '/banned', name: 'banned', component: BanPage, meta: { title: '访问受限 · SteamDeals' } },
    { path: '/banned.html', redirect: '/banned' },
    { path: '/console', name: 'console', component: () => import('../pages/Console.vue'), meta: { title: 'SteamDeals · 管理控制台' } },
    { path: '/console.html', redirect: '/console' },
  ],
});

router.afterEach((to) => { document.title = to.meta?.title || 'SteamDeals'; });
export default router;
