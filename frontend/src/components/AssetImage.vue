<script setup lang="ts">
import { ref, watch, onBeforeUnmount, onMounted } from "vue";
import { assetCache } from "../composables/assetCache";
import { t } from "../i18n";
const props = defineProps<{
  asset: string;
  signal: AbortSignal;
  alt: string;
  original?: boolean;
}>();
const image = ref<HTMLImageElement>(),
  src = ref(""),
  error = ref(false);
let observer: IntersectionObserver | undefined,
  held = "";
let heldCache: ReturnType<typeof assetCache> | undefined;
let heldVariant: "original" | "thumbnail" = "thumbnail";
let generation = 0;
let unlisten: (() => void) | undefined;
function release() {
  unlisten?.();
  unlisten = undefined;
  if (held) heldCache?.release(held, heldVariant);
  held = "";
  src.value = "";
  generation++;
}
async function load() {
  if (held) return;
  const version = ++generation,
    id = props.asset;
  held = id;
  try {
    const cache = assetCache(props.signal);
    heldCache = cache;
    heldVariant = props.original ? "original" : "thumbnail";
    const entry = await cache.acquire(id, heldVariant);
    if (version === generation) {
      entry.signal.throwIfAborted();
      src.value = entry.url;
      // Scrolling is not disposal. Keep the displayed URL pinned until the
      // component unmounts or its asset/session is explicitly invalidated.
      observer?.disconnect();
      const invalidated = () => {
        if (version === generation) { src.value = ""; error.value = true; }
      };
      entry.signal.addEventListener("abort", invalidated, { once: true });
      unlisten = () => entry.signal.removeEventListener("abort", invalidated);
    }
  } catch {
    if (version === generation) error.value = true;
  }
}
onMounted(() => {
  // Dialog children mount before showModal(). An original with no intrinsic
  // size must not wait for its own IntersectionObserver to start loading.
  if (props.original) { void load(); return; }
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) load();
    },
    { rootMargin: "200px" },
  );
  if (image.value) observer.observe(image.value);
});
watch(
  () => [props.asset, props.original, props.signal],
  () => {
    release();
    error.value = false;
    load();
  },
);
onBeforeUnmount(() => {
  observer?.disconnect();
  release();
});
</script>
<template>
  <img
    ref="image"
    :src="src || undefined"
    :alt="error ? t('图片加载失败，请重新打开') : alt"
    draggable="false"
  />
</template>
