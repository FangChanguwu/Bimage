<script setup lang="ts">
import { ref, onBeforeUnmount } from "vue";
import { ImagePlus, WandSparkles } from "lucide-vue-next";
import Modal from "./Modal.vue";
import ReferenceImages from "./ReferenceImages.vue";
import { useReferences } from "../composables/useReferences";
import { rewritePrompt } from "../composables/promptRewrite";
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
const intent = ref(props.form.prompt),
  references = ref([...props.form.references]),
  result = ref(""),
  busy = ref(false),
  file = ref<HTMLInputElement>();
const controller = new AbortController();
const signal = AbortSignal.any([props.signal, controller.signal]);
onBeforeUnmount(() => controller.abort());
const refs = useReferences(
  () => references.value,
  (ids) => (references.value = ids),
  props.api,
  signal,
);
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
function paste(event: ClipboardEvent) {
  if (!busy.value && !refs.pending.value) void props.run(() => refs.paste(event));
}
function removeReference(id: string) {
  if (busy.value) return;
  refs.invalidate();
  references.value = references.value.filter((reference) => reference !== id);
}
function apply() {
  if (busy.value || refs.pending.value || !result.value.trim()) return;
  emit("apply", result.value, [...references.value]);
  close();
}
async function generate() {
  if (busy.value || refs.pending.value || !intent.value.trim()) return;
  busy.value = true;
  try {
    await props.run(async () => {
      result.value = await rewritePrompt(props.api, props.settings, intent.value, references.value, signal);
    });
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <Modal title="快速生成提示词" :locked="busy" @close="close"
    ><p class="muted">
      用默认文本模型补写提示词，不会直接生成图片。参考图需要模型支持视觉输入。
    </p>
    <label
      >简短意图<textarea
        v-model="intent"
        aria-label="简短意图"
        rows="4"
        :disabled="busy"
        placeholder="例如：雨夜街头的一只猫，电影感光影"
        @paste="paste"
      /></label
    ><input
      ref="file"
      class="visually-hidden"
      aria-label="快速提示词参考图"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple
      tabindex="-1"
      :disabled="busy || refs.pending.value"
      @change="selectFiles"
    /><button
      class="upload-zone"
      :disabled="busy || refs.pending.value"
      @click="file?.click()"
    >
      <ImagePlus :size="18" />添加参考图 · 或粘贴图片</button
    ><ReferenceImages
      :references="references"
      :disabled="busy"
      :signal="signal"
      :run="run"
      @remove="removeReference"
    />
    <p class="muted">
      {{
        settings.textModel
          ? "默认文本模型 · " + settings.textModel
          : "请先在设置中配置默认文本模型"
      }}
    </p>
    <button
      :disabled="
        busy ||
        refs.pending.value ||
        !intent.trim() ||
        !settings.textProvider ||
        !settings.textModel
      "
      @click="generate"
    >
      <WandSparkles :size="16" />{{ busy ? "补写中…" : "生成提示词" }}</button
    >
    <span class="visually-hidden" role="status">{{ busy ? "正在补写提示词，请稍候。" : "" }}</span>
    <label v-if="result"
      >生成结果<textarea v-model="result" aria-label="生成结果" rows="7" :disabled="busy" />
    </label>
    <footer class="form-footer">
      <button :disabled="busy" @click="close">取消</button
      ><button
        class="primary"
        :disabled="!result.trim() || busy || refs.pending.value"
        @click="apply"
      >
        填入提示词
      </button>
    </footer></Modal
  >
</template>

<style scoped>
textarea:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}
</style>
