<script setup lang="ts">
import { ref, onMounted } from "vue";
import { ZoomIn, ZoomOut, RotateCcw, Download, Copy } from "lucide-vue-next";
import Modal from "./Modal.vue";
import AssetImage from "./AssetImage.vue";
import { download, copyImage } from "../composables/assetCache";
import type { Run, Point } from "../types";
const props = defineProps<{
  asset: string;
  signal: AbortSignal;
  run: Run;
  mime?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const zoom = ref(1),
  pan = ref<Point>({ x: 0, y: 0 }),
  stage = ref<HTMLDivElement>();
const pointers = new Map<number, Point>();
let drag: Point | null = null,
  pinch: { distance: number; zoom: number } | null = null;
function scale(z: number) {
  zoom.value = Math.max(0.25, Math.min(8, z));
}
function reset() {
  zoom.value = 1;
  pan.value = { x: 0, y: 0 };
}
onMounted(() =>
  stage.value?.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      scale(zoom.value * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false },
  ),
);
function down(e: PointerEvent) {
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
  <Modal title="图片预览" wide @close="emit('close')"
    ><div class="preview-toolbar">
      <button class="icon-button" aria-label="缩小" @click="scale(zoom / 1.25)">
        <ZoomOut :size="18" /></button
      ><button
        class="icon-button"
        aria-label="放大"
        @click="scale(zoom * 1.25)"
      >
        <ZoomIn :size="18" /></button
      ><button aria-label="复位" @click="reset">
        <RotateCcw :size="16" />{{ Math.round(zoom * 100) }}%</button
      ><button @click="run(() => copyImage(asset, signal), '复制成功')">
        <Copy :size="16" />复制</button
      ><button
        @click="
          run(() =>
            download(
              '/api/assets/' + asset,
              asset + '.' + (mime?.split('/')[1] || 'png'),
              signal,
            ),
          )
        "
      >
        <Download :size="16" />下载原图
      </button>
    </div>
    <div
      ref="stage"
      class="lightbox-stage"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
    >
      <AssetImage
        :asset="asset"
        :signal="signal"
        alt="预览原图"
        original
        :style="{
          transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
        }"
      />
    </div>
    <p class="muted preview-help">
      滚轮或双指缩放 · 拖动查看 · Esc 关闭
    </p></Modal
  >
</template>
