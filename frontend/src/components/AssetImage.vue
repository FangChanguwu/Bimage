<script setup lang="ts">
import { ref, watch, onBeforeUnmount, onMounted } from "vue";
import { assetCache } from "../composables/assetCache";
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
function release() {
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
    if (version === generation) src.value = entry.url;
  } catch {
    if (version === generation) error.value = true;
  }
}
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting) load();
      else release();
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
    :alt="error ? '图片加载失败，请重新打开' : alt"
    draggable="false"
  />
</template>
