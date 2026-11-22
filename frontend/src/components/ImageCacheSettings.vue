<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { t } from '../i18n';
import { assetCache } from "../composables/assetCache";
const props = defineProps<{ signal: AbortSignal }>();
const emit = defineEmits<{ cleared: [] }>();
const bytes = ref(0), count = ref(0), limit = ref(128 * 1024 * 1024), busy = ref(false);
const percent = computed(() => Math.min(100, limit.value > 0 ? Math.round((bytes.value / limit.value) * 1000) / 10 : 0));
async function refresh() {
  const usage = await assetCache(props.signal).usage();
  if (!props.signal.aborted) { bytes.value = usage.bytes; count.value = usage.count; limit.value = usage.limit; }
}
async function clear() {
  if (busy.value || props.signal.aborted) return;
  busy.value = true;
  try {
    await assetCache(props.signal).clear();
    await refresh();
    if (!props.signal.aborted) emit("cleared");
  } finally { busy.value = false; }
}
onMounted(refresh);
</script>
<template>
  <section class="image-cache-settings" :aria-label="t('本地图片缓存')">
    <div class="cache-copy">
      <h3>{{ t('本地图片缓存') }}</h3>
      <p class="cache-stats">{{ t('已使用 {size} MB · {count} 项，最多 128 MB', { size: (bytes / 1024 / 1024).toFixed(1), count }) }}</p>
      <div class="cache-meter" role="progressbar" :aria-valuenow="Math.round(percent)" aria-valuemin="0" aria-valuemax="100" :aria-label="t('本地图片缓存')">
        <div class="cache-meter-fill" :style="{ width: `${percent}%` }" />
      </div>
      <p>{{ t('预览缓存保存在此浏览器，刷新后可复用；每次恢复仍会联网验证权限。退出登录或切换账号时自动清除，不影响服务器原图。') }}</p>
    </div>
    <button type="button" :disabled="busy || (count === 0 && bytes === 0)" @click="clear">{{ t(busy ? "正在清除…" : "清除图片缓存") }}</button>
  </section>
</template>
<style scoped>
.image-cache-settings { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; padding: .25rem 0; }
.cache-copy { min-width: 0; flex: 1; }
h3 { font-size: 14px; margin: 0 0 6px; }
p { margin: 4px 0 0; font-size: 12px; line-height: 1.65; color: var(--muted); }
.cache-stats { font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 500; }
.cache-meter { height: 6px; margin: 10px 0 12px; border-radius: 99px; background: var(--field); border: 1px solid var(--line); overflow: hidden; }
.cache-meter-fill { height: 100%; border-radius: 99px; background: var(--accent); transition: width 260ms cubic-bezier(.16, 1, .3, 1); }
button { flex-shrink: 0; }
@media (max-width: 540px) { .image-cache-settings { align-items: flex-start; flex-direction: column; } }
</style>
