<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from "vue";
import { ZoomIn, ZoomOut, RotateCcw, Download, Copy, ChevronLeft, ChevronRight, LoaderCircle, Star, ImagePlus } from "lucide-vue-next";
import Modal from "./Modal.vue";
import AssetImage from "./AssetImage.vue";
import { assetCache, download, copyImage, extensionForMime } from "../composables/assetCache";
import type { Run, Point } from "../types";
import { t } from "../i18n";
interface LightboxItem { asset: string; mime?: string }
const props = defineProps<{
  asset: string;
  signal: AbortSignal;
  run: Run;
  mime?: string;
  items?: LightboxItem[];
  initialIndex?: number;
  canFavorite?: boolean;
  canUseAsReference?: boolean;
  isFavorite?: (asset: string) => boolean;
}>();
const emit = defineEmits<{
  close: [];
  toggleFavorite: [asset: string];
  useAsReference: [asset: string];
}>();
const gallery = computed<LightboxItem[]>(() =>
  props.items ? props.items : [{ asset: props.asset, mime: props.mime }],
);
const index = ref(Math.max(0, Math.min(props.initialIndex ?? 0, Math.max(0, (props.items?.length ?? 1) - 1))));
const activeAsset = ref(gallery.value[index.value]?.asset ?? props.asset);
const current = computed(() => gallery.value[index.value] ?? { asset: props.asset, mime: props.mime });
const previewThumb = computed(() => assetCache(props.signal).peek(current.value.asset, "thumbnail"));
const imageState = ref<"loading" | "ready" | "error">("loading");
const assetImage = ref<{ retry: () => void }>();
const zoom = ref(1),
  pan = ref<Point>({ x: 0, y: 0 }),
  stage = ref<HTMLDivElement>();
const pointers = new Map<number, Point>();
let drag: Point | null = null,
  pinch: { distance: number; zoom: number } | null = null;
function scale(z: number) {
  zoom.value = Math.max(0.25, Math.min(8, z));
  if (zoom.value <= 1) pan.value = { x: 0, y: 0 };
}
function reset() {
  zoom.value = 1;
  pan.value = { x: 0, y: 0 };
}
function step(delta: number) {
  if (gallery.value.length <= 1) return;
  index.value = (index.value + delta + gallery.value.length) % gallery.value.length;
  activeAsset.value = gallery.value[index.value]?.asset ?? activeAsset.value;
}
watch(
  gallery,
  (next) => {
    if (props.items && next.length === 0) {
      emit("close");
      return;
    }
    const found = next.findIndex((item) => item.asset === activeAsset.value);
    if (found >= 0) {
      index.value = found;
    } else {
      index.value = Math.max(0, Math.min(index.value, next.length - 1));
      activeAsset.value = next[index.value]?.asset ?? props.asset;
    }
  },
  { deep: true },
);
watch(() => current.value.asset, (nextAsset) => {
  activeAsset.value = nextAsset;
  reset();
  imageState.value = "loading";
});
function toggleZoom() {
  if (zoom.value > 1.05) reset();
  else zoom.value = 2;
}
function onWheel(e: WheelEvent) {
  e.preventDefault();
  scale(zoom.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}
function onKeydown(e: KeyboardEvent) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.key === "ArrowLeft" && gallery.value.length > 1) { e.preventDefault(); step(-1); }
  else if (e.key === "ArrowRight" && gallery.value.length > 1) { e.preventDefault(); step(1); }
  else if (e.key === "+" || e.key === "=") { e.preventDefault(); scale(zoom.value * 1.25); }
  else if (e.key === "-") { e.preventDefault(); scale(zoom.value / 1.25); }
  else if (e.key === "0") { e.preventDefault(); reset(); }
}
onMounted(() => {
  stage.value?.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  stage.value?.removeEventListener("wheel", onWheel);
  window.removeEventListener("keydown", onKeydown);
});
function down(e: PointerEvent) {
  if ((e.target as HTMLElement)?.closest("button")) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  drag = { x: e.clientX - pan.value.x, y: e.clientY - pan.value.y };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoom.value };
  }
}
function move(e: PointerEvent) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    scale(
      (pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) /
        Math.max(1, pinch.distance),
    );
  } else if (drag) pan.value = { x: e.clientX - drag.x, y: e.clientY - drag.y };
}
function up(e: PointerEvent) {
  pointers.delete(e.pointerId);
  drag = null;
  pinch = null;
}
</script>
<template>
  <Modal :title="t('图片预览')" wide @close="emit('close')"
    ><div class="preview-toolbar">
      <button class="icon-button" :aria-label="t('缩小')" @click="scale(zoom / 1.25)">
        <ZoomOut :size="18" /></button
      ><button
        class="icon-button"
        :aria-label="t('放大')"
        @click="scale(zoom * 1.25)"
      >
        <ZoomIn :size="18" /></button
      ><button :aria-label="t('复位')" @click="reset">
        <RotateCcw :size="16" />{{ Math.round(zoom * 100) }}%</button
      ><button @click="run(() => copyImage(current.asset, signal), t('复制成功'))">
        <Copy :size="16" />{{ t('复制') }}</button
      ><button
        @click="
          run(() =>
            download(
              '/api/assets/' + current.asset,
              current.mime ? current.asset + '.' + extensionForMime(current.mime) : current.asset,
              signal,
            ),
          )
        "
      >
        <Download :size="16" />{{ t('下载原图') }}
      </button>
      <button
        v-if="canUseAsReference"
        type="button"
        @click="emit('useAsReference', current.asset)"
      >
        <ImagePlus :size="16" />{{ t('作为参考图') }}
      </button>
      <button
        v-if="canFavorite"
        type="button"
        :class="{ 'is-favorited': isFavorite?.(current.asset) }"
        :aria-pressed="Boolean(isFavorite?.(current.asset))"
        @click="emit('toggleFavorite', current.asset)"
      >
        <Star :size="16" :class="{ 'star-filled': isFavorite?.(current.asset) }" />{{ t(isFavorite?.(current.asset) ? '已收藏' : '收藏') }}
      </button>
      <span v-if="gallery.length > 1" class="preview-counter">{{ index + 1 }} / {{ gallery.length }}</span>
    </div>
    <div
      ref="stage"
      class="lightbox-stage"
      :data-zoomed="zoom > 1.05 || undefined"
      @dblclick="toggleZoom"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
    >
      <img
        v-if="imageState === 'loading' && previewThumb"
        :src="previewThumb"
        alt=""
        aria-hidden="true"
        class="lightbox-placeholder"
        :style="{ transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }"
      />
      <AssetImage
        ref="assetImage"
        :asset="current.asset"
        :signal="signal"
        :alt="t('预览原图')"
        original
        :style="{
          transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
        }"
        @state="imageState = $event"
      />
      <div v-if="imageState === 'loading'" class="lightbox-status" role="status" :aria-label="t('加载中…')">
        <LoaderCircle class="spinner" :size="18" aria-hidden="true" />
      </div>
      <div v-else-if="imageState === 'error'" class="lightbox-error" role="alert">
        <span>{{ t('图片加载失败，请重试') }}</span>
        <button type="button" @click="assetImage?.retry()">{{ t('重试') }}</button>
      </div>
      <template v-if="gallery.length > 1">
        <button type="button" class="icon-button lightbox-nav prev" :aria-label="t('上一张')" @click.stop="step(-1)">
          <ChevronLeft :size="20" />
        </button>
        <button type="button" class="icon-button lightbox-nav next" :aria-label="t('下一张')" @click.stop="step(1)">
          <ChevronRight :size="20" />
        </button>
      </template>
    </div>
    <p class="muted preview-help">
      {{ t('滚轮或双指缩放 · 拖动查看 · Esc 关闭') }}
    </p></Modal
  >
</template>
