<script setup>
// Element Plus 统一中文：分页的 Total / Go to / N per page、下拉空值占位等都由 locale 决定
import zhCn from 'element-plus/es/locale/lang/zh-cn';
</script>

<template>
  <el-config-provider :locale="zhCn"><router-view /></el-config-provider>
</template>
