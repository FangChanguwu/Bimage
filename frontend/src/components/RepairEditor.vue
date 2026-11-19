<script setup lang="ts">
import SelectControl from "./SelectControl.vue";
import { ref, watch, nextTick, onBeforeUnmount } from "vue";
import { Undo2, Redo2, Eraser } from "lucide-vue-next";
import Modal from "./Modal.vue";
import { assetCache } from "../composables/assetCache";
import { repairPrompt, fileData } from "../domain";
import type { Job, Shape, Tool, Point, Api } from "../types";
const props = defineProps<{ job: Job; signal: AbortSignal; api: Api }>();
const emit = defineEmits<{ close: []; apply: [id: string, prompt: string] }>();
const tasks = props.job.tasks.filter((t) => t.asset),
  asset = ref(tasks[0]?.asset || ""),
  tool = ref<Tool>("pen"),
  color = ref("#EF4444"),
  width = ref(8),
  shapes = ref<Shape[]>([]),
  redo = ref<Shape[]>([]),
  need = ref(""),
  error = ref(""),
  busy = ref(false),
  ready = ref(false),
  canvas = ref<HTMLCanvasElement>();
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
let bitmap: ImageBitmap | null = null,
  current: Shape | null = null,
  version = 0;
const controller = new AbortController();
const signal = AbortSignal.any([props.signal, controller.signal]);
onBeforeUnmount(() => {
  controller.abort();
  bitmap?.close();
  version++;
});
watch(
  asset,
  async (id) => {
    const v = ++version;
    ready.value = false;
    shapes.value = [];
    redo.value = [];
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
function paint(ctx: CanvasRenderingContext2D, s: Shape) {
  const a = s.points[0],
    b = s.points.at(-1)!;
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
      const angle = Math.atan2(b.y - a.y, b.x - a.x),
        head = Math.max(12, s.width * 4);
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
function redraw(items = shapes.value) {
  const c = canvas.value;
  if (!c || !bitmap) return;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(bitmap, 0, 0);
  for (const shape of items) paint(ctx, shape);
}
watch(shapes, () => redraw(), { deep: true });
function point(e: PointerEvent): Point {
  const c = canvas.value!,
    r = c.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(c.width, ((e.clientX - r.left) * c.width) / r.width),
    ),
    y: Math.max(
      0,
      Math.min(c.height, ((e.clientY - r.top) * c.height) / r.height),
    ),
  };
}
function down(e: PointerEvent) {
  if (!ready.value || busy.value || current) return;
  e.preventDefault();
  canvas.value!.setPointerCapture(e.pointerId);
  current = {
    tool: tool.value,
    color: color.value,
    width: width.value,
    points: [point(e)],
  };
}
function move(e: PointerEvent) {
  if (!current) return;
  if (current.tool === "pen") current.points.push(point(e));
  else current.points = [current.points[0], point(e)];
  redraw([...shapes.value, current]);
}
function finish(e: PointerEvent) {
  if (!current) return;
  const shape = current;
  current = null;
  if (e.type !== "pointercancel") {
    shape.points.push(point(e));
    if (
      shape.points.some(
        (p) =>
          Math.hypot(p.x - shape.points[0].x, p.y - shape.points[0].y) >= 1,
      )
    ) {
      shapes.value = [...shapes.value, shape];
      redo.value = [];
      error.value = "";
    }
  }
  redraw();
}
async function apply() {
  if (busy.value) return;
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
    emit("apply", result.id, prompt);
    emit("close");
  } catch (e) {
    if ((e as Error).name !== "AbortError") error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal title="局部修复" wide @close="emit('close')"
    ><p class="muted">
      标注作为参考图提示，不是像素蒙版硬约束。确认只回填草稿，不会生成或扣费。
    </p>
    <label v-if="tasks.length > 1"
      >选择输出图片<SelectControl v-model="asset" label="修复图片"
        :options="tasks.map((task, i) => ({value: task.asset || '', label: `图片 ${i + 1}`}))" /></label
    >
    <div class="repair-toolbar">
      <button
        v-for="(name, id) in names"
        :key="id"
        :aria-pressed="tool === id"
        @click="tool = id"
      >
        {{ name }}</button
      ><label class="repair-width"
        >笔宽<input
          v-model.number="width"
          aria-label="笔宽"
          type="range"
          min="1"
          max="40"
        /><output>{{ width }}px</output></label
      ><button
        aria-label="撤销"
        :disabled="!shapes.length || busy"
        @click="redo.push(shapes.pop()!)"
      >
        <Undo2 :size="16" /></button
      ><button
        aria-label="重做"
        :disabled="!redo.length || busy"
        @click="shapes.push(redo.pop()!)"
      >
        <Redo2 :size="16" /></button
      ><button
        :disabled="!shapes.length || busy"
        @click="
          shapes = [];
          redo = [];
        "
      >
        <Eraser :size="16" />清空
      </button>
    </div>
    <div class="repair-colors">
      <button
        v-for="c in colors"
        :key="c"
        :aria-label="c"
        :aria-pressed="color === c"
        :style="{ background: c }"
        @click="color = c"
      /><code>{{ color }}</code
      ><input v-model="color" type="color" aria-label="自定义颜色" />
    </div>
    <div class="repair-stage" :data-annotation-count="shapes.length">
      <canvas
        ref="canvas"
        aria-label="标注画布"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="finish"
        @pointercancel="finish"
      />
    </div>
    <label
      >修改需求<textarea
        v-model="need"
        aria-label="修改需求"
        rows="3"
        maxlength="8000"
        placeholder="说明标注范围内需要如何修改，支持多行…"
      />
    </label>
    <p v-if="error" role="alert" class="error-message">{{ error }}</p>
    <footer class="form-footer">
      <button @click="emit('close')">取消</button
      ><button class="primary" :disabled="busy || !ready" @click="apply">
        {{ busy ? "正在保存…" : "确认回填" }}
      </button>
    </footer></Modal
  >
</template>
