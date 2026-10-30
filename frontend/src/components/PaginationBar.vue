<script setup>
defineProps({
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
});
const emit = defineEmits(['update:page', 'update:pageSize', 'change']);
function changePage(value) { emit('update:page', value); emit('change', value); }
function changeSize(value) { emit('update:pageSize', value); emit('update:page', 1); emit('change', 1); }
</script>

<template>
  <div v-if="total > 0" class="pagination-wrap">
    <el-pagination
      background
      layout="total, sizes, prev, pager, next, jumper"
      :total="total"
      :current-page="page"
      :page-size="pageSize"
      :page-sizes="[20, 50, 100]"
      @current-change="changePage"
      @size-change="changeSize"
    />
  </div>
</template>

<style scoped>
.pagination-wrap{display:flex;justify-content:flex-end;padding:14px 16px;overflow-x:auto}
.pagination-wrap :deep(.el-pagination){flex-wrap:nowrap;white-space:nowrap}
</style>
