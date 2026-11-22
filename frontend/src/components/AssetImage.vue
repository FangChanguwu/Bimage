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
const emit = defineEmits<{ state: [status: "loading" | "ready" | "error"] }>();
const image = ref<HTMLImageElement>(),
  src = ref(""),
  error = ref(false),
  loaded = ref(false);
let observer: IntersectionObserver | undefined,
  held = "";
let heldCache: ReturnType<typeof assetCache> | undefined;
let heldVariant: "original" | "thumbnail" = "thumbnail";
let generation = 0;
let unlisten: (() => void) | undefined;
function updateState() {
  emit("state", error.value ? "error" : loaded.value ? "ready" : "loading");
}
function release() {
  unlisten?.();
  unlisten = undefined;
  if (held) heldCache?.release(held, heldVariant);
  held = "";
  src.value = "";
  loaded.value = false;
  generation++;
}
async function load() {
  if (held) return;
  const version = ++generation,
    id = props.asset;
  held = id;
  error.value = false;
  loaded.value = false;
  updateState();
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
        if (version === generation) { src.value = ""; loaded.value = false; error.value = true; updateState(); }
      };
      entry.signal.addEventListener("abort", invalidated, { once: true });
      unlisten = () => entry.signal.removeEventListener("abort", invalidated);
    }
  } catch {
    if (version === generation) { error.value = true; loaded.value = false; updateState(); }
  }
}
function onLoad() {
  if (src.value) { loaded.value = true; error.value = false; updateState(); }
}
function onError() {
  if (src.value) { loaded.value = false; error.value = true; updateState(); }
}
function retry() {
  release();
  error.value = false;
  void load();
}
defineExpose({ retry });
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
    :data-state="error ? 'error' : loaded ? 'ready' : 'loading'"
    draggable="false"
    @load="onLoad"
    @error="onError"
  />
</template>
