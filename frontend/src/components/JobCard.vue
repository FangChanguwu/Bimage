<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import {
  Download,
  Copy,
  RotateCcw,
  Paintbrush,
  LoaderCircle,
  Trash2,
  Star,
  ImagePlus,
} from "lucide-vue-next";
import AssetImage from "./AssetImage.vue";
import Modal from "./Modal.vue";
import Lightbox from "./Lightbox.vue";
import RepairEditor from "./RepairEditor.vue";
import ReferenceImages from "./ReferenceImages.vue";
import { download, copyImage } from "../composables/assetCache";
import { statusLabel } from "../domain";
import type { Job, Task, Api, Run, RepairResult } from "../types";
import { t, formatDate } from "../i18n";
const detailLabels: Record<string, string> = {
  model: '模型', count: '张数', size: '尺寸', autoSize: '自动尺寸',
  resolution: '分辨率', ratio: '比例', quality: '质量',
  output_format: '输出格式', aspect_ratio: '宽高比',
};
const props = defineProps<{
  job: Job;
  api: Api;
  signal: AbortSignal;
  run: Run;
  cancelling: boolean;
  remove: (id: string) => Promise<void>;
  favoriteAssets: Set<string>;
}>();
const emit = defineEmits<{
  restore: [];
  cancel: [];
  repair: [result: RepairResult];
  useAsReference: [asset: string];
  toggleFavorite: [jobId: string, taskId: string, asset: string];
}>();
const details = ref(false),
  previewIndex = ref<number | null>(null),
  repairing = ref(false),
  confirmingDelete = ref(false),
  deleting = ref(false),
  now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
function stopTimer() {
  if (timer !== undefined) { clearInterval(timer); timer = undefined; }
}
watch(
  () => Boolean(props.job.startedAt && !props.job.finishedAt),
  (active) => {
    stopTimer();
    if (active) {
      now.value = Date.now();
      timer = setInterval(() => (now.value = Date.now()), 200);
    }
  },
  { immediate: true },
);
onBeforeUnmount(stopTimer);
const success = computed(() => props.job.tasks.filter((t) => t.asset));
const galleryItems = computed(() =>
  success.value.map((task) => ({ asset: task.asset!, mime: task.mime })),
);
function openPreview(task: Task) {
  const idx = success.value.findIndex((item) => item.id === task.id);
  if (idx >= 0) previewIndex.value = idx;
}
function toggleFavoriteByAsset(assetId: string) {
  const task = success.value.find((item) => item.asset === assetId);
  if (task && task.asset) emit("toggleFavorite", props.job.id, task.id, task.asset);
}
const canCancel = computed(() => props.job.tasks.some(t => t.status === "queued"));
const canDelete = computed(() => !["queued", "running"].includes(props.job.status));
const duration = computed(() =>
  props.job.startedAt
    ? Math.max(
        0,
        ((props.job.finishedAt ? Date.parse(props.job.finishedAt) : now.value) -
          Date.parse(props.job.startedAt)) /
          1000,
      ).toFixed(2)
    : "",
);
async function deleteJob() {
  if (deleting.value || !canDelete.value) return;
  deleting.value = true;
  try {
    await props.remove(props.job.id);
  } finally {
    deleting.value = false;
  }
}
</script>
<template>
  <article class="job">
    <div class="job-head">
      <span :class="['status', job.status]"
        ><LoaderCircle
          v-if="job.status === 'running'"
          class="spinner"
          :size="13"
        /><span v-else class="status-dot" aria-hidden="true" />{{ t(statusLabel[job.status] || job.status)
        }}<small v-if="duration"> · {{ t('用时 {duration}秒', { duration }) }}</small></span
      ><time :datetime="job.created">{{
        formatDate(job.created)
      }}</time>
    </div>
    <button
      class="prompt-summary"
      :title="t('查看完整提示词')"
      @click="details = true"
    >
      {{ job.form.prompt.replace(/\s+/g, " ").trim() }}
    </button>
    <p class="job-meta">
      {{ job.form.model
      }}<span>{{ t('{completed} / {count} 张', { completed: success.length, count: job.form.count }) }}</span>
    </p>
    <div class="result-images">
      <div v-for="(task, i) in job.tasks" :key="task.id" class="result-image">
        <template v-if="task.asset">
          <button
            type="button"
            class="image-open"
            :style="{
              '--preview-ratio':
                task.width && task.height && task.width > 0 && task.height > 0
                  ? task.width / task.height
                  : undefined,
            }"
            :aria-label="t('查看图片')"
            @click="openPreview(task)"
          >
            <AssetImage
              :asset="task.asset"
              :signal="signal"
              :alt="t('生成图片 {number}', { number: i + 1 })"
            />
          </button>
          <div class="result-caption">
            <small class="actual-spec">{{
              task.width && task.height
                ? `${task.width} × ${task.height}`
                : t('规格未知')
            }}</small>
            <div class="image-tools">
              <button
                type="button"
                class="icon-button"
                :class="{ 'is-favorited': favoriteAssets.has(task.asset) }"
                :aria-label="t(favoriteAssets.has(task.asset) ? '取消收藏' : '收藏图片')"
                :title="t(favoriteAssets.has(task.asset) ? '取消收藏' : '收藏图片')"
                :aria-pressed="favoriteAssets.has(task.asset)"
                @click="emit('toggleFavorite', job.id, task.id, task.asset)"
              >
                <Star :size="15" :class="{ 'star-filled': favoriteAssets.has(task.asset) }" />
              </button>
              <button
                type="button"
                class="icon-button"
                :aria-label="t('作为参考图')"
                :title="t('作为参考图')"
                @click="emit('useAsReference', task.asset)"
              >
                <ImagePlus :size="15" />
              </button>
              <button
                type="button"
                class="icon-button"
                :aria-label="t('下载图片')"
                :title="t('下载图片')"
                @click="
                  run(() =>
                    download(
                      '/api/assets/' + task.asset,
                      task.asset + '.' + (task.mime?.split('/')[1] || 'png'),
                      signal,
                    ),
                  )
                "
              >
                <Download :size="15" />
              </button>
              <button
                type="button"
                class="icon-button"
                :aria-label="t('复制图片')"
                :title="t('复制图片')"
                @click="run(() => copyImage(task.asset!, signal), t('复制成功'))"
              >
                <Copy :size="15" />
              </button>
            </div>
          </div>
        </template>
        <div v-else class="result-placeholder">
          <LoaderCircle
            v-if="task.status === 'running'"
            class="spinner"
            :size="23"
          /><span>{{ t(statusLabel[task.status] || task.status) }}</span
          ><small v-if="task.error" class="task-error">{{ t(task.error) }}</small>
        </div>
      </div>
    </div>
    <footer class="job-actions">
      <button
        :disabled="!success.length"
        @click="
          run(() =>
            download(
              '/api/jobs/' + job.id + '/download',
              'images-' + job.id + '.zip',
              signal,
            ),
          )
        "
      >
        <Download :size="15" />{{ t('下载') }}</button
      ><button :title="t('仅恢复完整参数，不自动生成')" @click="emit('restore')">
        <RotateCcw :size="15" />{{ t('重试') }}</button
      ><button :disabled="!success.length" @click="repairing = true">
        <Paintbrush :size="15" />{{ t('局部修复') }}</button
      ><button
        v-if="canCancel || cancelling"
        type="button"
        :title="t('只取消排队中的任务，已开始生成的图片不受影响')"
        :disabled="cancelling"
        @click="emit('cancel')"
      >
        {{ t(cancelling ? '取消中…' : '取消排队') }}
      </button>
      <button v-if="canDelete" type="button" class="delete-job" @click="confirmingDelete = true">
        <Trash2 :size="15" />{{ t('删除') }}
      </button>
    </footer>
    <Modal v-if="confirmingDelete" :title="t('删除任务')" :locked="deleting" @close="confirmingDelete = false">
      <p class="delete-description">{{ t('任务记录和未被其他任务或草稿引用的生成图片将永久删除。此操作无法撤销。') }}</p>
      <p class="delete-prompt">{{ job.form.prompt }}</p>
      <footer class="form-footer">
        <button type="button" autofocus :disabled="deleting" @click="confirmingDelete = false">{{ t('取消') }}</button>
        <button type="button" class="delete-confirm" :disabled="deleting || !canDelete" @click="deleteJob">
          {{ t(deleting ? '删除中…' : '永久删除') }}
        </button>
      </footer>
    </Modal>
    <Modal v-if="details" :title="t('任务详情')" @close="details = false"
      ><p class="detail-prompt">{{ job.form.prompt }}</p>
      <dl class="job-details">
        <template v-for="(value, key) in job.form" :key="key"
          ><template
            v-if="
              !['prompt', 'references', 'mask', 'providerId', 'manualSize'].includes(
                key,
              )
            "
            ><dt>{{ t(detailLabels[key] || key) }}</dt>
            <dd>{{ value }}</dd></template
          ></template
        >
      </dl>
      <h3>{{ t('实际规格') }}</h3>
      <p v-for="task in job.tasks" :key="task.id">
        {{ t(statusLabel[task.status] || task.status) }} ·
        {{
          task.width && task.height
            ? `${task.width} × ${task.height}`
            : t('规格未知')
        }}<span v-if="task.error" class="error-message">{{ t(task.error) }}</span>
      </p>
      <h3>{{ t('参考图') }}</h3>
      <ReferenceImages
        :references="job.form.references"
        :signal="signal"
        :run="run"
        readonly
      />
      <template v-if="job.form.mask">
        <h3>{{ t('像素蒙版') }}</h3>
        <div class="detail-mask-preview mask-checker">
          <AssetImage :asset="job.form.mask" :signal="signal" :alt="t('像素蒙版')" />
        </div>
      </template></Modal
    ><Lightbox
      v-if="previewIndex !== null && galleryItems[previewIndex]"
      :asset="galleryItems[previewIndex].asset"
      :mime="galleryItems[previewIndex].mime"
      :items="galleryItems"
      :initial-index="previewIndex"
      :signal="signal"
      :run="run"
      can-favorite
      can-use-as-reference
      :is-favorite="(id) => favoriteAssets.has(id)"
      @toggle-favorite="toggleFavoriteByAsset"
      @use-as-reference="(id) => emit('useAsReference', id)"
      @close="previewIndex = null"
    /><RepairEditor
      v-if="repairing"
      :job="job"
      :api="api"
      :signal="signal"
      @close="repairing = false"
      @apply="(result) => emit('repair', result)"
    />
  </article>
</template>

<style scoped>
.delete-job, .delete-confirm { color: var(--danger); }
.delete-confirm { border-color: currentColor; }
.delete-confirm:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 9%, var(--surface));
  border-color: currentColor;
}
.delete-description, .delete-prompt { overflow-wrap: anywhere; }
.delete-prompt {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--muted);
  margin-block: 12px 18px;
}
</style>
