<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { ImagePlus, WandSparkles, Undo2, TriangleAlert } from "lucide-vue-next";
import Modal from "./Modal.vue";
import ReferenceImages from "./ReferenceImages.vue";
import { useReferences } from "../composables/useReferences";
import { rewritePrompt } from "../composables/promptRewrite";
import { t } from "../i18n";
import type { GenerationForm, Settings, Api, Run } from "../types";
const props = defineProps<{
  form: GenerationForm;
  settings: Settings;
  api: Api;
  signal: AbortSignal;
  run: Run;
}>();
const emit = defineEmits<{
  close: [];
  apply: [prompt: string, references: string[]];
}>();
const modalRef = ref<InstanceType<typeof Modal> | null>(null);
const intent = ref(props.form.prompt),
  references = ref([...props.form.references]),
  result = ref(""),
  previousResult = ref<string | null>(null),
  generatedFor = ref<{ intent: string; refsKey: string } | null>(null),
  allowStaleApply = ref(false),
  busy = ref(false),
  dragging = ref(false),
  file = ref<HTMLInputElement>();
let dragDepth = 0;
const initialRefsKey = JSON.stringify(props.form.references);
const controller = new AbortController();
const signal = AbortSignal.any([props.signal, controller.signal]);
onBeforeUnmount(() => controller.abort());
const refs = useReferences(
  () => references.value,
  (ids) => (references.value = ids),
  props.api,
  signal,
);
const currentRefsKey = computed(() => JSON.stringify(references.value));
const isStale = computed(() =>
  Boolean(
    result.value.trim() &&
    generatedFor.value &&
    (intent.value !== generatedFor.value.intent || currentRefsKey.value !== generatedFor.value.refsKey),
  ),
);
const dirty = computed(
  () =>
    intent.value !== props.form.prompt ||
    currentRefsKey.value !== initialRefsKey ||
    Boolean(result.value.trim()),
);
watch([intent, currentRefsKey], () => {
  allowStaleApply.value = false;
});
function close() {
  if (busy.value) return;
  controller.abort();
  emit("close");
}
function selectFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!busy.value && !refs.pending.value && files.length)
    void props.run(() => refs.upload(files));
}
function onDragEnter(e: DragEvent) {
  if (busy.value || refs.pending.value || !e.dataTransfer?.types.includes("Files")) return;
  dragDepth++;
  dragging.value = true;
}
function onDragOver(e: DragEvent) {
  if (busy.value || refs.pending.value) return;
  if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}
function onDrop(e: DragEvent) {
  e.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith("image/"));
  if (!busy.value && !refs.pending.value && files.length) void props.run(() => refs.upload(files));
}
function intentKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); void generate(); }
}
function paste(event: ClipboardEvent) {
  if (!busy.value && !refs.pending.value) void props.run(() => refs.paste(event));
}
function removeReference(id: string) {
  if (busy.value) return;
  references.value = references.value.filter((reference) => reference !== id);
}
function restorePreviousResult() {
  if (previousResult.value === null) return;
  const current = result.value;
  result.value = previousResult.value;
  previousResult.value = current || null;
}
function apply() {
  if (busy.value || refs.pending.value || !result.value.trim()) return;
  if (isStale.value && !allowStaleApply.value) return;
  emit("apply", result.value, [...references.value]);
  modalRef.value?.forceClose();
}
async function generate() {
  if (busy.value || refs.pending.value || !intent.value.trim()) return;
  busy.value = true;
  const snapshotIntent = intent.value;
  const snapshotRefs = [...references.value];
  const snapshotRefsKey = JSON.stringify(snapshotRefs);
  try {
    await props.run(async () => {
      const next = await rewritePrompt(props.api, props.settings, snapshotIntent, snapshotRefs, signal, "quick");
      if (result.value.trim() && result.value !== next) {
        previousResult.value = result.value;
      }
      result.value = next;
      generatedFor.value = { intent: snapshotIntent, refsKey: snapshotRefsKey };
      allowStaleApply.value = false;
    });
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal ref="modalRef" :title="t('快速生成提示词')" :locked="busy" :dirty="dirty" @close="close"
    ><p class="muted">
      {{ t('用快速提示词模型补写提示词，不会直接生成图片。参考图需要模型支持视觉输入。') }}
    </p>
    <label
      >{{ t('简短意图') }}<textarea
        v-model="intent"
        :aria-label="t('简短意图')"
        rows="4"
        :disabled="busy"
        :placeholder="t('例如：雨夜街头的一只猫，电影感光影')"
        @keydown="intentKeydown"
        @paste="paste"
      /></label
    ><input
      ref="file"
      class="visually-hidden"
      :aria-label="t('快速提示词参考图')"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      tabindex="-1"
      :disabled="busy || refs.pending.value"
      @change="selectFiles"
    /><button
      type="button"
      class="upload-zone"
      :class="{ dragging }"
      :disabled="busy || refs.pending.value"
      @click="file?.click()"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <ImagePlus :size="18" />{{ t('添加参考图 · 或粘贴图片') }}</button
    ><ReferenceImages
      :references="references"
      :disabled="busy"
      :signal="signal"
      :run="run"
      @remove="removeReference"
    />
    <p class="muted">
      {{
        settings.quickModel
          ? t('快速提示词模型 · {model}', { model: settings.quickModel })
          : t('请先在供应商设置中配置快速提示词模型')
      }}
    </p>
    <button
      :disabled="
        busy ||
        refs.pending.value ||
        !intent.trim() ||
        !settings.quickProvider ||
        !settings.quickModel
      "
      @click="generate"
    >
      <WandSparkles :size="16" />{{ busy ? t('补写中…') : t('生成提示词') }}</button
    >
    <span class="visually-hidden" role="status">{{ busy ? t('正在补写提示词，请稍候。') : '' }}</span>
    <div v-if="result" class="quick-result-group">
      <div class="quick-result-head">
        <label for="quick-prompt-result">{{ t('生成结果') }}</label>
        <button v-if="previousResult !== null" type="button" class="text-button" :disabled="busy" @click="restorePreviousResult">
          <Undo2 :size="14" />{{ t('恢复上一版结果') }}
        </button>
      </div>
      <div v-if="isStale" class="quick-stale-banner" role="alert">
        <TriangleAlert :size="15" aria-hidden="true" />
        <div class="quick-stale-copy">
          <span>{{ t('简短意图或参考图已在生成后修改，当前结果可能与最新输入不一致。建议重新生成。') }}</span>
          <label class="inline-check">
            <input v-model="allowStaleApply" type="checkbox" :disabled="busy" />
            <span>{{ t('我已知晓，仍填入此结果') }}</span>
          </label>
        </div>
      </div>
      <textarea id="quick-prompt-result" v-model="result" :aria-label="t('生成结果')" rows="7" :disabled="busy" />
    </div>
    <footer class="form-footer">
      <button type="button" :disabled="busy" @click="modalRef?.requestClose()">{{ t('取消') }}</button
      ><button
        type="button"
        class="primary"
        :disabled="!result.trim() || busy || refs.pending.value || (isStale && !allowStaleApply)"
        @click="apply"
      >
        {{ t('填入提示词') }}
      </button>
    </footer></Modal
  >
</template>

<style scoped>
textarea:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}
.quick-result-group { display: grid; gap: 8px; margin-top: 12px; }
.quick-result-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.quick-result-head label { margin: 0; font-size: 13px; font-weight: 550; }
.quick-stale-banner { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid #d6b46d; background: #fff6e3; color: #795016; font-size: 12px; line-height: 1.45; }
[data-theme="dark"] .quick-stale-banner { border-color: #9b7a43; background: #3b3020; color: #f4d296; }
.quick-stale-banner svg { flex: none; margin-top: 2px; }
.quick-stale-copy { display: grid; gap: 6px; }
.inline-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; margin: 0; font-size: 12px; color: inherit; }
.inline-check input { width: auto; min-height: auto; margin: 0; }
</style>
