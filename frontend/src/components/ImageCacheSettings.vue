<script setup lang="ts">
import { onMounted, ref } from "vue";
import { assetCache } from "../composables/assetCache";
const props = defineProps<{ signal: AbortSignal }>();
const emit = defineEmits<{ cleared: [] }>();
const bytes = ref(0), count = ref(0), busy = ref(false);
async function refresh() {
  const usage = await assetCache(props.signal).usage();
  if (!props.signal.aborted) { bytes.value = usage.bytes; count.value = usage.count; }
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
  <section class="image-cache-settings" aria-label="本地图片缓存">
    <div class="cache-copy">
      <h3>本地图片缓存</h3>
      <p>已使用 {{ (bytes / 1024 / 1024).toFixed(1) }} MB · {{ count }} 项，最多 128 MB</p>
      <p>预览缓存保存在此浏览器，刷新后可复用；每次恢复仍会联网验证权限。退出登录或切换账号时自动清除，不影响服务器原图。</p>
    </div>
    <button type="button" :disabled="busy" @click="clear">{{ busy ? "正在清除…" : "清除图片缓存" }}</button>
  </section>
</template>
<style scoped>
.image-cache-settings { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 0; }
.cache-copy { min-width: 0; }
h3 { font-size: .9rem; margin: 0 0 .4rem; }
p { margin: .25rem 0 0; font-size: .8rem; line-height: 1.6; color: var(--muted); }
button { flex-shrink: 0; }
@media (max-width: 540px) { .image-cache-settings { align-items: flex-start; flex-direction: column; } }
</style>
