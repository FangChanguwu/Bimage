<script setup lang="ts">
import SelectControl from "./SelectControl.vue";
import { computed, ref, watch, nextTick, onBeforeUnmount } from "vue";
import { Undo2, Redo2, Eraser, Trash2, Contrast } from "lucide-vue-next";
import Modal from "./Modal.vue";
import { assetCache } from "../composables/assetCache";
import { repairPrompt, fileData } from "../domain";
import type { Job, Shape, Tool, MaskTool, RepairMode, RepairResult, Point, Api } from "../types";
import { t } from "../i18n";

type MaskOp =
  | { kind: "stroke"; tool: MaskTool; width: number; points: Point[] }
  | { kind: "invert" };

const props = defineProps<{
  job?: Job;
  sourceAsset?: string;
  initialMode?: RepairMode;
  initialPrompt?: string;
  signal: AbortSignal;
  api: Api;
}>();
const emit = defineEmits<{ close: []; apply: [result: RepairResult] }>();

const assetOptions = computed(() => {
  if (props.job) {
    return props.job.tasks
      .filter((task) => task.asset)
      .map((task, i) => ({
        value: task.asset!,
        label: t("图片 {number}", { number: i + 1 }),
      }));
  }
  return props.sourceAsset ? [{ value: props.sourceAsset, label: t("参考图 1") }] : [];
});

const mode = ref<RepairMode>(props.initialMode ?? "mask");
const asset = ref(assetOptions.value[0]?.value || "");

// Annotation mode state
const tool = ref<Tool>("pen");
const color = ref("#EF4444");
const width = ref(8);
const shapes = ref<Shape[]>([]);
const redo = ref<Shape[]>([]);

// Pixel mask mode state
const maskTool = ref<MaskTool>("brush");
const maskWidth = ref(42);
const maskOps = ref<MaskOp[]>([]);
const maskRedo = ref<MaskOp[]>([]);

const need = ref(props.initialPrompt ?? "");
const error = ref("");
const busy = ref(false);
const ready = ref(false);
const canvas = ref<HTMLCanvasElement>();

const colors = [
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#3B82F6",
  "#A855F7",
  "#FFFFFF",
  "#111827",
];
const names: Record<Tool, string> = {
  pen: "画笔",
  rect: "矩形",
  ellipse: "圆形",
  arrow: "箭头",
};
const maskToolNames: Record<MaskTool, string> = {
  brush: "涂抹蒙版",
  eraser: "擦除蒙版",
  rect: "矩形",
  ellipse: "圆形",
};

let bitmap: ImageBitmap | null = null;
let maskCanvas: HTMLCanvasElement | null = null;
let tintCanvas: HTMLCanvasElement | null = null;
let currentShape: Shape | null = null;
let currentMaskOp: (MaskOp & { kind: "stroke" }) | null = null;
let version = 0;

const controller = new AbortController();
const signal = AbortSignal.any([props.signal, controller.signal]);

onBeforeUnmount(() => {
  controller.abort();
  bitmap?.close();
  maskCanvas = null;
  tintCanvas = null;
  version++;
});

watch(
  asset,
  async (id) => {
    if (!id) return;
    const v = ++version;
    ready.value = false;
    shapes.value = [];
    redo.value = [];
    maskOps.value = [];
    maskRedo.value = [];
    error.value = "";
    const cache = assetCache(props.signal);
    try {
      const entry = await cache.acquire(id);
      const image = await createImageBitmap(entry.blob);
      if (v !== version || signal.aborted) {
        image.close();
        return;
      }
      bitmap?.close();
      bitmap = image;
      maskCanvas = document.createElement("canvas");
      maskCanvas.width = image.width;
      maskCanvas.height = image.height;
      tintCanvas = document.createElement("canvas");
      tintCanvas.width = image.width;
      tintCanvas.height = image.height;
      maskWidth.value = Math.round(Math.max(16, Math.min(96, Math.max(image.width, image.height) * 0.045)));
      await nextTick();
      if (!canvas.value) return;
      canvas.value.width = image.width;
      canvas.value.height = image.height;
      ready.value = true;
      redraw();
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        error.value = (e as Error).message;
    } finally {
      cache.release(id);
    }
  },
  { immediate: true },
);

function paintAnnotation(ctx: CanvasRenderingContext2D, s: Shape) {
  const a = s.points[0];
  const b = s.points.at(-1)!;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (s.tool === "rect")
    ctx.rect(
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.abs(b.x - a.x),
      Math.abs(b.y - a.y),
    );
  else if (s.tool === "ellipse")
    ctx.ellipse(
      (a.x + b.x) / 2,
      (a.y + b.y) / 2,
      Math.abs(b.x - a.x) / 2,
      Math.abs(b.y - a.y) / 2,
      0,
      0,
      Math.PI * 2,
    );
  else {
    ctx.moveTo(a.x, a.y);
    for (const p of s.points.slice(1)) ctx.lineTo(p.x, p.y);
    if (s.tool === "arrow") {
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = Math.max(12, s.width * 4);
      ctx.moveTo(
        b.x - head * Math.cos(angle - 0.5),
        b.y - head * Math.sin(angle - 0.5),
      );
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(
        b.x - head * Math.cos(angle + 0.5),
        b.y - head * Math.sin(angle + 0.5),
      );
    }
  }
  ctx.stroke();
}

function renderMaskLayer(ops: MaskOp[]) {
  if (!maskCanvas) return;
  const ctx = maskCanvas.getContext("2d")!;
  ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  for (const op of ops) {
    if (op.kind === "invert") {
      ctx.save();
      ctx.globalCompositeOperation = "xor";
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
      ctx.restore();
      continue;
    }
    const a = op.points[0];
    const b = op.points.at(-1)!;
    ctx.save();
    ctx.globalCompositeOperation = op.tool === "eraser" ? "destination-out" : "source-over";
    ctx.fillStyle = "#000000";
    ctx.strokeStyle = "#000000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = op.width;
    ctx.beginPath();
    if (op.tool === "rect") {
      ctx.fillRect(
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.abs(b.x - a.x),
        Math.abs(b.y - a.y),
      );
    } else if (op.tool === "ellipse") {
      const rx = Math.abs(b.x - a.x) / 2;
      const ry = Math.abs(b.y - a.y) / 2;
      if (rx > 0.5 && ry > 0.5) {
        ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (op.points.length === 1) {
      ctx.arc(a.x, a.y, op.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(a.x, a.y);
      for (const p of op.points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function redraw(extraAnnotation?: Shape, extraMask?: MaskOp) {
  const c = canvas.value;
  if (!c || !bitmap) return;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0);
  if (mode.value === "annotation") {
    const items = extraAnnotation ? [...shapes.value, extraAnnotation] : shapes.value;
    for (const shape of items) paintAnnotation(ctx, shape);
  } else if (maskCanvas && tintCanvas) {
    const ops = extraMask ? [...maskOps.value, extraMask] : maskOps.value;
    renderMaskLayer(ops);
    const tctx = tintCanvas.getContext("2d")!;
    tctx.clearRect(0, 0, tintCanvas.width, tintCanvas.height);
    tctx.drawImage(maskCanvas, 0, 0);
    tctx.save();
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = "rgba(124, 77, 255, 0.52)";
    tctx.fillRect(0, 0, tintCanvas.width, tintCanvas.height);
    tctx.restore();
    ctx.drawImage(tintCanvas, 0, 0);
  }
}

watch([mode, shapes, maskOps], () => redraw(), { deep: true });

function switchMode(next: RepairMode) {
  if (busy.value || mode.value === next) return;
  mode.value = next;
  error.value = "";
}

function point(e: PointerEvent): Point {
  const c = canvas.value!;
  const r = c.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(c.width, ((e.clientX - r.left) * c.width) / r.width)),
    y: Math.max(0, Math.min(c.height, ((e.clientY - r.top) * c.height) / r.height)),
  };
}

function down(e: PointerEvent) {
  if (!ready.value || busy.value || currentShape || currentMaskOp) return;
  e.preventDefault();
  canvas.value!.setPointerCapture(e.pointerId);
  const pt = point(e);
  if (mode.value === "annotation") {
    currentShape = {
      tool: tool.value,
      color: color.value,
      width: width.value,
      points: [pt],
    };
  } else {
    currentMaskOp = {
      kind: "stroke",
      tool: maskTool.value,
      width: maskWidth.value,
      points: [pt],
    };
    redraw(undefined, currentMaskOp);
  }
}

function move(e: PointerEvent) {
  if (currentShape) {
    if (currentShape.tool === "pen") currentShape.points.push(point(e));
    else currentShape.points = [currentShape.points[0], point(e)];
    redraw(currentShape);
  } else if (currentMaskOp) {
    if (currentMaskOp.tool === "brush" || currentMaskOp.tool === "eraser") {
      currentMaskOp.points.push(point(e));
    } else {
      currentMaskOp.points = [currentMaskOp.points[0], point(e)];
    }
    redraw(undefined, currentMaskOp);
  }
}

function finish(e: PointerEvent) {
  if (currentShape) {
    const shape = currentShape;
    currentShape = null;
    if (e.type !== "pointercancel") {
      shape.points.push(point(e));
      if (
        shape.points.some(
          (p) => Math.hypot(p.x - shape.points[0].x, p.y - shape.points[0].y) >= 1,
        )
      ) {
        shapes.value = [...shapes.value, shape];
        redo.value = [];
        error.value = "";
      }
    }
    redraw();
  } else if (currentMaskOp) {
    const op = currentMaskOp;
    currentMaskOp = null;
    if (e.type !== "pointercancel") {
      const end = point(e);
      if (op.tool === "brush" || op.tool === "eraser") {
        op.points.push(end);
        maskOps.value = [...maskOps.value, op];
        maskRedo.value = [];
        error.value = "";
      } else {
        op.points = [op.points[0], end];
        if (Math.hypot(end.x - op.points[0].x, end.y - op.points[0].y) >= 2) {
          maskOps.value = [...maskOps.value, op];
          maskRedo.value = [];
          error.value = "";
        }
      }
    }
    redraw();
  }
}

function invertMask() {
  if (busy.value || !ready.value) return;
  maskOps.value = [...maskOps.value, { kind: "invert" }];
  maskRedo.value = [];
  error.value = "";
}

function undoStep() {
  if (busy.value) return;
  if (mode.value === "mask") {
    const last = maskOps.value.pop();
    if (last) maskRedo.value.push(last);
  } else {
    const last = shapes.value.pop();
    if (last) redo.value.push(last);
  }
}

function redoStep() {
  if (busy.value) return;
  if (mode.value === "mask") {
    const next = maskRedo.value.pop();
    if (next) maskOps.value.push(next);
  } else {
    const next = redo.value.pop();
    if (next) shapes.value.push(next);
  }
}

function clearCanvas() {
  if (busy.value) return;
  if (mode.value === "mask") {
    maskOps.value = [];
    maskRedo.value = [];
  } else {
    shapes.value = [];
    redo.value = [];
  }
}

const canUndo = computed(() =>
  mode.value === "mask" ? maskOps.value.length > 0 : shapes.value.length > 0,
);
const canRedo = computed(() =>
  mode.value === "mask" ? maskRedo.value.length > 0 : redo.value.length > 0,
);
const strokeCount = computed(() =>
  mode.value === "mask" ? maskOps.value.length : shapes.value.length,
);

function hasPaintedMaskPixels(): boolean {
  if (!maskCanvas) return false;
  const ctx = maskCanvas.getContext("2d")!;
  const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

async function apply() {
  if (busy.value) return;
  if (mode.value === "mask") {
    renderMaskLayer(maskOps.value);
    if (!hasPaintedMaskPixels()) {
      error.value = "请先涂抹需要重绘的蒙版区域";
      return;
    }
    if (!need.value.trim()) {
      error.value = "请填写修改需求";
      return;
    }
    if (need.value.trim().length > 16000) {
      error.value = "修改需求过长，请简化";
      return;
    }
    busy.value = true;
    error.value = "";
    try {
      // Build OpenAI /images/edits spec mask: opaque = preserve, alpha 0 = repaint.
      const out = document.createElement("canvas");
      out.width = maskCanvas!.width;
      out.height = maskCanvas!.height;
      const octx = out.getContext("2d")!;
      octx.fillStyle = "#000000";
      octx.fillRect(0, 0, out.width, out.height);
      octx.globalCompositeOperation = "destination-out";
      octx.drawImage(maskCanvas!, 0, 0);

      const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
      if (!blob || blob.size > 8 * 1024 * 1024)
        throw Error("蒙版图超过8MB，请选择较小原图");
      signal.throwIfAborted();
      const data = await fileData(blob);
      const result = await props.api<{ id: string }>(
        "/assets",
        { mime: "image/png", data: data.split(",")[1] },
        undefined,
        signal,
      );
      signal.throwIfAborted();
      emit("apply", {
        mode: "mask",
        imageId: asset.value,
        maskId: result.id,
        prompt: need.value.trim(),
      });
      emit("close");
    } catch (e) {
      if ((e as Error).name !== "AbortError") error.value = (e as Error).message;
    } finally {
      busy.value = false;
    }
    return;
  }

  // Annotation mode
  if (!shapes.value.length) {
    error.value = "请先在图内添加标注";
    return;
  }
  if (!need.value.trim()) {
    error.value = "请填写修改需求";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    redraw();
    const blob = await new Promise<Blob | null>((r) =>
      canvas.value!.toBlob(r, "image/png"),
    );
    if (!blob || blob.size > 8 * 1024 * 1024)
      throw Error("标注图超过8MB，请选择较小原图");
    const prompt = repairPrompt(shapes.value, need.value);
    if (prompt.length > 16000) throw Error("修改需求过长，请简化");
    signal.throwIfAborted();
    const data = await fileData(blob);
    const result = await props.api<{ id: string }>(
      "/assets",
      { mime: "image/png", data: data.split(",")[1] },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    emit("apply", {
      mode: "annotation",
      imageId: result.id,
      prompt,
    });
    emit("close");
  } catch (e) {
    if ((e as Error).name !== "AbortError") error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal :title="t('局部修复')" wide @close="emit('close')">
    <div class="repair-mode-switch" role="tablist" :aria-label="t('修复模式')">
      <button
        type="button"
        role="tab"
        :aria-selected="mode === 'mask'"
        :class="{ active: mode === 'mask' }"
        :disabled="busy"
        @click="switchMode('mask')"
      >
        {{ t("像素蒙版重绘") }}
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="mode === 'annotation'"
        :class="{ active: mode === 'annotation' }"
        :disabled="busy"
        @click="switchMode('annotation')"
      >
        {{ t("涂鸦标注提示") }}
      </button>
    </div>

    <p class="muted repair-mode-hint">
      {{
        mode === "mask"
          ? t("紫色涂抹区域将生成透明像素蒙版，随原图作为 mask 参数提交重绘。确认只回填草稿，不会生成或扣费。")
          : t("标注作为参考图提示，不是像素蒙版硬约束。确认只回填草稿，不会生成或扣费。")
      }}
    </p>

    <label v-if="assetOptions.length > 1">
      {{ t("选择输出图片") }}
      <SelectControl v-model="asset" :label="t('修复图片')" :options="assetOptions" />
    </label>

    <div v-if="mode === 'mask'" class="repair-toolbar">
      <button
        v-for="(name, id) in maskToolNames"
        :key="id"
        type="button"
        :aria-pressed="maskTool === id"
        @click="maskTool = id"
      >
        <Eraser v-if="id === 'eraser'" :size="15" aria-hidden="true" />
        {{ t(name) }}
      </button>
      <label class="repair-width">
        {{ t("笔宽") }}
        <input v-model.number="maskWidth" type="range" min="4" max="160" />
        <output>{{ maskWidth }}px</output>
      </label>
      <button
        type="button"
        :title="t('反选蒙版')"
        :aria-label="t('反选蒙版')"
        :disabled="!ready || busy"
        @click="invertMask"
      >
        <Contrast :size="15" aria-hidden="true" />{{ t("反选") }}
      </button>
      <button type="button" :aria-label="t('撤销')" :disabled="!canUndo || busy" @click="undoStep">
        <Undo2 :size="16" />
      </button>
      <button type="button" :aria-label="t('重做')" :disabled="!canRedo || busy" @click="redoStep">
        <Redo2 :size="16" />
      </button>
      <button type="button" :aria-label="t('清空')" :disabled="!canUndo || busy" @click="clearCanvas">
        <Trash2 :size="16" />
      </button>
    </div>

    <template v-else>
      <div class="repair-toolbar">
        <button
          v-for="(name, id) in names"
          :key="id"
          type="button"
          :aria-pressed="tool === id"
          @click="tool = id"
        >
          {{ t(name) }}
        </button>
        <label class="repair-width">
          {{ t("笔宽") }}
          <input v-model.number="width" type="range" min="2" max="48" />
          <output>{{ width }}px</output>
        </label>
        <button type="button" :aria-label="t('撤销')" :disabled="!canUndo || busy" @click="undoStep">
          <Undo2 :size="16" />
        </button>
        <button type="button" :aria-label="t('重做')" :disabled="!canRedo || busy" @click="redoStep">
          <Redo2 :size="16" />
        </button>
        <button type="button" :aria-label="t('清空')" :disabled="!canUndo || busy" @click="clearCanvas">
          <Trash2 :size="16" />
        </button>
      </div>
      <div class="repair-colors">
        <button
          v-for="c in colors"
          :key="c"
          type="button"
          :aria-label="c"
          :aria-pressed="color === c"
          :style="{ background: c }"
          @click="color = c"
        />
        <code>{{ color }}</code>
        <input v-model="color" type="color" :aria-label="t('自定义颜色')" />
      </div>
    </template>

    <div class="repair-stage" :data-mode="mode" :data-annotation-count="strokeCount">
      <canvas
        ref="canvas"
        :aria-label="mode === 'mask' ? t('蒙版画布') : t('标注画布')"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="finish"
        @pointercancel="finish"
      />
    </div>

    <label>
      {{ t("修改需求") }}
      <textarea
        v-model="need"
        rows="3"
        :placeholder="
          mode === 'mask'
            ? t('描述蒙版区域希望重绘成什么内容，例如：将背景替换为雨夜霓虹街道…')
            : t('说明标注范围内需要如何修改，支持多行…')
        "
      />
    </label>
    <p v-if="error" role="alert" class="error-message">{{ t(error) }}</p>
    <footer class="form-footer">
      <button type="button" @click="emit('close')">{{ t("取消") }}</button>
      <button type="button" class="primary" :disabled="busy || !ready" @click="apply">
        {{ t(busy ? "正在保存…" : "确认回填") }}
      </button>
    </footer>
  </Modal>
</template>
