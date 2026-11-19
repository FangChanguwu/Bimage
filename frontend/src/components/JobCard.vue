<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import {
  Download,
  Copy,
  RotateCcw,
  Paintbrush,
  LoaderCircle,
  Trash2,
} from "lucide-vue-next";
import AssetImage from "./AssetImage.vue";
import Modal from "./Modal.vue";
import Lightbox from "./Lightbox.vue";
import RepairEditor from "./RepairEditor.vue";
import ReferenceImages from "./ReferenceImages.vue";
import { download, copyImage } from "../composables/assetCache";
import { statusLabel } from "../domain";
import type { Job, Task, Api, Run } from "../types";
const props = defineProps<{
  job: Job;
  api: Api;
  signal: AbortSignal;
  run: Run;
  cancelling: boolean;
  remove: (id: string) => Promise<void>;
}>();
const emit = defineEmits<{
  restore: [];
  cancel: [];
  repair: [id: string, prompt: string];
}>();
const details = ref(false),
  preview = ref<Task | null>(null),
  repairing = ref(false),
  confirmingDelete = ref(false),
  deleting = ref(false),
  now = ref(Date.now());
let timer: ReturnType<typeof setInterval>;
onMounted(() => (timer = setInterval(() => (now.value = Date.now()), 100)));
onBeforeUnmount(() => clearInterval(timer));
const success = computed(() => props.job.tasks.filter((t) => t.asset));
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
          :size="14"
        />{{ statusLabel[job.status] || job.status
        }}<small v-if="duration"> · 用时 {{ duration }}秒</small></span
      ><time :datetime="job.created">{{
        new Date(job.created).toLocaleString()
      }}</time>
    </div>
    <button
      class="prompt-summary"
      title="查看完整提示词"
      @click="details = true"
    >
      {{ job.form.prompt.replace(/\s+/g, " ").trim() }}
    </button>
    <p class="job-meta">
      {{ job.form.model
      }}<span>{{ success.length }} / {{ job.form.count }} 张</span>
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
            aria-label="查看图片"
            @click="preview = task"
          >
            <AssetImage
              :asset="task.asset"
              :signal="signal"
              :alt="'生成图片 ' + (i + 1)"
            />
          </button>
          <div class="result-caption">
            <small class="actual-spec">{{
              task.width && task.height
                ? `${task.width} × ${task.height}`
                : "规格未知"
            }}</small>
            <div class="image-tools">
              <button
                type="button"
                class="icon-button"
                aria-label="下载图片"
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
                aria-label="复制图片"
                @click="run(() => copyImage(task.asset!, signal), '复制成功')"
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
          /><span>{{ statusLabel[task.status] || task.status }}</span
          ><small v-if="task.error" class="task-error">{{ task.error }}</small>
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
        <Download :size="15" />下载</button
      ><button title="仅恢复完整参数，不自动生成" @click="emit('restore')">
        <RotateCcw :size="15" />重试</button
      ><button :disabled="!success.length" @click="repairing = true">
        <Paintbrush :size="15" />局部修复</button
      ><button
        v-if="canCancel || cancelling"
        type="button"
        title="只取消排队中的任务，已开始生成的图片不受影响"
        :disabled="cancelling"
        @click="emit('cancel')"
      >
        {{ cancelling ? "取消中…" : "取消排队" }}
      </button>
      <button v-if="canDelete" type="button" class="delete-job" @click="confirmingDelete = true">
        <Trash2 :size="15" />删除
      </button>
    </footer>
    <Modal v-if="confirmingDelete" title="删除任务" :locked="deleting" @close="confirmingDelete = false">
      <p class="delete-description">任务记录和未被其他任务或草稿引用的生成图片将永久删除。此操作无法撤销。</p>
      <p class="delete-prompt">{{ job.form.prompt }}</p>
      <footer class="form-footer">
        <button type="button" autofocus :disabled="deleting" @click="confirmingDelete = false">取消</button>
        <button type="button" class="delete-confirm" :disabled="deleting || !canDelete" @click="deleteJob">
          {{ deleting ? "删除中…" : "永久删除" }}
        </button>
      </footer>
    </Modal>
    <Modal v-if="details" title="任务详情" @close="details = false"
      ><p class="detail-prompt">{{ job.form.prompt }}</p>
      <dl class="job-details">
        <template v-for="(value, key) in job.form" :key="key"
          ><template
            v-if="
              !['prompt', 'references', 'providerId', 'manualSize'].includes(
                key,
              )
            "
            ><dt>{{ key }}</dt>
            <dd>{{ value }}</dd></template
          ></template
        >
      </dl>
      <h3>实际规格</h3>
      <p v-for="task in job.tasks" :key="task.id">
        {{ statusLabel[task.status] }} ·
        {{
          task.width && task.height
            ? `${task.width} × ${task.height}`
            : "规格未知"
        }}<span v-if="task.error" class="error-message">{{ task.error }}</span>
      </p>
      <h3>参考图</h3>
      <ReferenceImages
        :references="job.form.references"
        :signal="signal"
        :run="run"
        @remove="() => {}" /></Modal
    ><Lightbox
      v-if="preview?.asset"
      :asset="preview.asset"
      :mime="preview.mime"
      :signal="signal"
      :run="run"
      @close="preview = null"
    /><RepairEditor
      v-if="repairing"
      :job="job"
      :api="api"
      :signal="signal"
      @close="repairing = false"
      @apply="(id, prompt) => emit('repair', id, prompt)"
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
