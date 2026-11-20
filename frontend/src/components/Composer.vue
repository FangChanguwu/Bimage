<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  WandSparkles,
  Eraser,
  ImagePlus,
  Plus,
  Minus,
  ArrowRight,
  LoaderCircle,
} from "lucide-vue-next";
import ModelSelect from "./ModelSelect.vue";
import SelectControl from "./SelectControl.vue";
import ReferenceImages from "./ReferenceImages.vue";
import { useReferences } from "../composables/useReferences";
import { comparePrompts, composePrompt, editPromptReview, PROMPT_LIMIT, reviewText, rewritePrompt, type PromptRun } from "../composables/promptRewrite";
import { dimensions } from "../domain";
import { resolveTextDefaults } from "../composables/textDefaults";
import type { GenerationForm, Provider, Api, Run, Settings } from "../types";
const props = defineProps<{
  form: GenerationForm;
  providers: Provider[];
  signal: AbortSignal;
  api: Api;
  run: Run;
  busy: boolean;
  settings: Settings;
}>();
const emit = defineEmits<{
  "update:form": [form: GenerationForm];
  generate: [];
  quick: [];
}>();
const file = ref<HTMLInputElement>();
const promptInput = ref<HTMLTextAreaElement>();
const highlight = ref<HTMLElement>();
const optimizing = ref(false);
const textDefaults = computed(() => resolveTextDefaults(props.providers, props.settings));
const review = ref<readonly PromptRun[] | null>(null);
const reviewValue = computed(() => review.value ? reviewText(review.value) : "");
const revisedPrompt = computed(() => review.value ? composePrompt(review.value) : "");
const canApply = computed(() => !!revisedPrompt.value.trim() && revisedPrompt.value.length <= PROMPT_LIMIT);
const reviewHistory = new Map<string, readonly PromptRun[]>();
let inputRange: { start: number; end: number; type: string } | undefined;
let request: AbortController | undefined;
function setReview(runs: readonly PromptRun[] | null) {
  reviewHistory.clear();
  inputRange = undefined;
  review.value = runs;
  if (runs) reviewHistory.set(reviewText(runs), runs);
}
function rememberRange(event: InputEvent) {
  if (!review.value) return;
  const field = event.target as HTMLTextAreaElement;
  inputRange = { start: field.selectionStart, end: field.selectionEnd, type: event.inputType };
}
function editPrompt(event: Event) {
  if (optimizing.value) return;
  const value = (event.target as HTMLTextAreaElement).value;
  if (!review.value) {
    change("prompt", value);
    return;
  }
  const type = (event as InputEvent).inputType;
  const undo = type === "historyUndo" || type === "historyRedo";
  const runs = (undo ? reviewHistory.get(value) : undefined)
    ?? editPromptReview(review.value, value, inputRange);
  inputRange = undefined;
  review.value = runs;
  reviewHistory.set(value, runs);
  if (reviewHistory.size > 64) reviewHistory.delete(reviewHistory.keys().next().value!);
}
function syncHighlight() {
  if (highlight.value && promptInput.value) {
    highlight.value.scrollTop = promptInput.value.scrollTop;
    highlight.value.scrollLeft = promptInput.value.scrollLeft;
  }
}
watch(review, syncHighlight, { flush: "post" });
function change<K extends keyof GenerationForm>(
  key: K,
  value: GenerationForm[K],
) {
  emit("update:form", { ...props.form, [key]: value });
}
const refs = useReferences(
  () => props.form.references,
  (ids) => change("references", ids),
  props.api,
  props.signal,
);
function clear() {
  if (optimizing.value) return;
  setReview(null);
  refs.invalidate();
  emit("update:form", { ...props.form, prompt: "", references: [] });
}
function manual(key: "ratio" | "resolution", value: string) {
  const next = { ...props.form, [key]: value };
  if (next.ratio === "custom") next.ratio = "1:1";
  next.size = dimensions(next.ratio, next.resolution || "1K");
  emit("update:form", next);
}
function upload(e: Event) {
  const target = e.target as HTMLInputElement;
  const files = Array.from(target.files || []);
  target.value = "";
  if (!optimizing.value && !refs.pending.value && files.length)
    void props.run(() => refs.upload(files));
}
function paste(event: ClipboardEvent) {
  if (optimizing.value) event.preventDefault();
  else if (!refs.pending.value) void props.run(() => refs.paste(event));
}
function removeReference(id: string) {
  if (optimizing.value) return;
  refs.invalidate();
  change("references", props.form.references.filter(reference => reference !== id));
}
function abortOptimization() {
  request?.abort();
  request = undefined;
  optimizing.value = false;
}
watch(() => props.form.prompt, () => {
  abortOptimization();
  setReview(null);
});
watch(() => JSON.stringify(props.form.references), () => {
  if (optimizing.value) abortOptimization();
});
onBeforeUnmount(abortOptimization);
async function optimize() {
  const original = props.form.prompt;
  if (optimizing.value || review.value || props.busy || refs.pending.value || !original.trim()) return;
  const controller = new AbortController();
  const signal = AbortSignal.any([props.signal, controller.signal]);
  request = controller;
  optimizing.value = true;
  try {
    await props.run(async () => {
      const text = await rewritePrompt(props.api, textDefaults.value, original, props.form.references, signal);
      if (request === controller) setReview(comparePrompts(original, text));
    });
  } finally {
    if (request === controller) {
      request = undefined;
      optimizing.value = false;
      await nextTick();
      if (!signal.aborted && (document.activeElement === document.body || document.activeElement === promptInput.value))
        promptInput.value?.focus({ preventScroll: true });
    }
  }
}
async function finishReview(apply: boolean) {
  if (!review.value || (apply && !canApply.value)) return;
  if (apply) change("prompt", revisedPrompt.value);
  setReview(null);
  await nextTick();
  if (!props.signal.aborted) promptInput.value?.focus();
}
function submit() {
  if (!optimizing.value && !review.value && !props.busy && !refs.pending.value) emit("generate");
}
</script>
<template>
  <section class="composer" aria-labelledby="composer-title">
    <div class="section-head">
      <h2 id="composer-title">创作参数</h2>
      <div class="actions">
        <button
          type="button"
          class="icon-button"
          title="快速生成提示词"
          aria-label="快速生成提示词"
          :disabled="optimizing || !!review"
          @click="emit('quick')"
        >
          <WandSparkles :size="18" /></button
        ><button
          type="button"
          class="icon-button"
          title="清空提示词和参考图"
          aria-label="清空提示词和参考图"
          :disabled="optimizing"
          @click="clear"
        >
          <Eraser :size="18" />
        </button>
      </div>
    </div>
    <form class="panel" @submit.prevent="submit">
      <div class="prompt-field">
        <label class="prompt-label" for="composer-prompt">提示词</label>
        <div class="prompt-box" :class="{ 'prompt-locked': optimizing, 'prompt-review': review }">
          <pre v-if="review" ref="highlight" class="prompt-input prompt-highlight" aria-hidden="true"><span v-for="(run, index) in review" :key="index" :class="`prompt-diff-${run.kind}`">{{ run.text }}</span>{{ reviewValue.endsWith('\n') ? '\u200b' : '' }}</pre>
          <textarea
            id="composer-prompt"
            ref="promptInput"
            class="prompt-input"
            :value="review ? reviewValue : form.prompt"
            rows="7"
            required
            :maxlength="review ? 2 * PROMPT_LIMIT : PROMPT_LIMIT"
            :disabled="optimizing"
            :aria-describedby="review ? 'prompt-review-hint' : undefined"
            :spellcheck="review ? false : undefined"
            placeholder="描述你想看见的画面，主体、光线与细节…"
            @beforeinput="rememberRange"
            @input="editPrompt"
            @scroll="syncHighlight"
            @paste="paste"
          />
          <div v-if="review || optimizing || form.prompt.trim()" class="prompt-tools">
            <template v-if="review">
              <span id="prompt-review-hint" class="visually-hidden">绿色为新增文字，红色划线为将移除的原文。应用时保留未变更和新增文字。</span>
              <button type="button" @click="finishReview(false)">取消</button>
              <button type="button" class="prompt-apply" :disabled="!canApply" @click="finishReview(true)">应用</button>
              <span v-if="revisedPrompt.length > PROMPT_LIMIT" class="prompt-limit" role="status">提示词最多 {{ PROMPT_LIMIT }} 字符</span>
            </template>
            <button v-else-if="!optimizing" type="button" class="prompt-optimize" :disabled="busy || refs.pending.value" @click="optimize">
              <WandSparkles :size="15" aria-hidden="true" />优化
            </button>
            <span class="prompt-progress" role="status"><template v-if="optimizing"><LoaderCircle class="spinner" :size="16" aria-hidden="true" />正在优化提示词中，请耐心等待...</template></span>
          </div>
        </div>
      </div>
      <label
        >图像模型<ModelSelect
          :providers="providers"
          kind="image"
          :provider-id="form.providerId"
          :model="form.model"
          label="图像模型"
          @change="
            (p, m) => emit('update:form', { ...form, providerId: p, model: m })
          "
      /></label>
      <div class="reference-field" :class="{ 'reference-locked': optimizing }">
        <div class="field-heading">
          <span class="field-label">参考图</span
          ><small>{{ form.references.length }} / 16</small>
        </div>
        <input
          ref="file"
          class="visually-hidden"
          aria-label="参考图"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          tabindex="-1"
          :disabled="optimizing || refs.pending.value"
          @change="upload"
        /><button
          type="button"
          class="upload-zone"
          :disabled="optimizing || refs.pending.value"
          @click="file?.click()"
        >
          <ImagePlus :size="19" />{{
            refs.pending.value ? "正在上传…" : "添加参考图 · 或粘贴图片"
          }}</button
        ><ReferenceImages
          :references="form.references"
          :signal="signal"
          :run="run"
          :disabled="optimizing"
          @remove="removeReference"
        />
      </div>
      <div class="output-settings">
        <label class="check auto-check"
          ><input
            type="checkbox"
            aria-label="自动规格"
            :checked="form.autoSize"
            @change="
              change('autoSize', ($event.target as HTMLInputElement).checked)
            "
          />自动规格<span class="muted">由模型决定比例与分辨率</span></label
        >
        <div class="field-grid">
          <label
            >比例<SelectControl
              label="比例"
              :disabled="form.autoSize"
              :model-value="form.autoSize ? 'auto' : form.ratio"
              :options="[...(form.autoSize ? [{ value: 'auto', label: '自动' }] : []), ...['1:1', '3:2', '2:3', '16:9', '9:16'].map(value => ({value, label: value})), ...(form.ratio === 'custom' ? [{value: 'custom', label: '兼容自定义'}] : [])]"
              @update:model-value="manual('ratio', $event)"
            /></label
          ><label
            >分辨率<SelectControl
              label="分辨率"
              :disabled="form.autoSize"
              :model-value="form.autoSize ? 'auto' : form.resolution || 'custom'"
              :options="[...(form.autoSize ? [{value: 'auto', label: '自动'}] : []), ...['1K', '2K', '4K'].map(value => ({value, label: value})), ...(!form.resolution ? [{value: 'custom', label: '兼容历史尺寸'}] : [])]"
              @update:model-value="manual('resolution', $event)"
            /></label
          >
        </div>
        <small v-if="!form.autoSize" class="dimensions"
          >{{ form.size }} · 实际输出以模型返回为准</small
        >
        <div class="field-grid">
          <label
            >张数
            <div class="stepper">
              <button
                type="button"
                aria-label="减少张数"
                :disabled="form.count <= 1"
                @click="change('count', form.count - 1)"
              >
                <Minus :size="16" /></button
              ><input
                aria-label="张数"
                inputmode="numeric"
                type="number"
                min="1"
                max="16"
                :value="form.count"
                @input="
                  change(
                    'count',
                    Math.max(
                      1,
                      Math.min(
                        16,
                        Number(($event.target as HTMLInputElement).value) || 1,
                      ),
                    ),
                  )
                "
              /><button
                type="button"
                aria-label="增加张数"
                :disabled="form.count >= 16"
                @click="change('count', form.count + 1)"
              >
                <Plus :size="16" />
              </button></div></label
          ><label
            >质量<SelectControl label="质量" :model-value="form.quality"
              :options="['auto', 'low', 'medium', 'high', 'standard', 'hd'].map(value => ({value, label: value}))"
              @update:model-value="change('quality', $event)" /></label
          ><label
            >输出格式<SelectControl label="输出格式" :model-value="form.output_format"
              :options="['png', 'jpeg', 'webp'].map(value => ({value, label: value}))"
              @update:model-value="change('output_format', $event)" /></label
          >
        </div>
      </div>
      <footer class="generate-footer">
        <button
          type="submit"
          class="primary generate-button"
          :disabled="busy || refs.pending.value || optimizing || !!review"
        >
          {{ busy ? "正在提交…" : `生成 ${form.count} 张图片`
          }}<ArrowRight :size="18" /></button
        >
      </footer>
    </form>
  </section>
</template>
