<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RefreshCw, ExternalLink, RotateCcw, Copy, Check } from "lucide-vue-next";
import Modal from "./Modal.vue";
import SelectControl from "./SelectControl.vue";
import { t, locale } from "../i18n";
import type { Api, ReleaseInfo, RollbackResult, VersionSnapshot } from "../types";
import type { NoticeType } from "./ToastNotice.vue";

const props = defineProps<{
  api: Api;
  signal: AbortSignal;
  isAdmin: boolean;
  snapshot: VersionSnapshot | null;
  fallbackVersion: string;
}>();

const emit = defineEmits<{
  close: [];
  update: [snapshot: VersionSnapshot];
  notice: [message: string, type: NoticeType];
}>();

const data = ref<VersionSnapshot | null>(props.snapshot);
const checking = ref(false);
const checkError = ref("");
const rollbackOpen = ref(false);
const targetTag = ref("");
const rollingBack = ref(false);
const rollbackError = ref("");
const rollbackSuccess = ref("");
const copiedCmd = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const currentVersion = computed(() => data.value?.current || props.fallbackVersion);
const repoName = computed(() => data.value?.repo || "FangChanguwu/Bimage");
const releasesUrl = computed(
  () => data.value?.releasesUrl || `https://github.com/${repoName.value}/releases`,
);
const viewReleaseUrl = computed(() => data.value?.latest?.url || releasesUrl.value);
const releases = computed<ReleaseInfo[]>(() => data.value?.releases ?? []);

const rollbackOptions = computed(() =>
  releases.value.map((rel) => {
    const date = rel.publishedAt ? formatDate(rel.publishedAt) : "";
    const isCurrent = rel.version === currentVersion.value;
    const secondary = [date, isCurrent ? t("当前版本") : ""].filter(Boolean).join(" · ");
    return {
      value: rel.tag,
      label: rel.tag,
      secondary: secondary || undefined,
    };
  }),
);

const selectedRelease = computed(
  () => releases.value.find((rel) => rel.tag === targetTag.value) ?? null,
);

const rollbackCommand = computed(() => {
  const tag = targetTag.value || "v0.3.2";
  return `git fetch --tags && git checkout ${tag} && npm run build`;
});

const statusClass = computed(() => {
  if (checkError.value) return "failed";
  if (checking.value) return "running";
  if (!data.value?.checkedAt) return "";
  return data.value.hasUpdate ? "running" : "succeeded";
});

const statusText = computed(() => {
  if (checking.value) return t("检测中…");
  if (checkError.value) return t("检测失败");
  if (!data.value?.checkedAt) return t("尚未检测");
  if (data.value.hasUpdate && data.value.latest)
    return t("发现新版本 {tag}", { tag: data.value.latest.tag });
  return t("已是最新版本");
});

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString(locale.value === "en" ? "en-US" : "zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleString(locale.value === "en" ? "en-US" : "zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function syncDefaultTarget(list: ReleaseInfo[]) {
  if (targetTag.value && list.some((r) => r.tag === targetTag.value)) return;
  const older = list.find((r) => r.version !== currentVersion.value);
  targetTag.value = older?.tag || list[0]?.tag || "";
}

watch(releases, syncDefaultTarget, { immediate: true });

async function checkUpdates(force: boolean) {
  if (checking.value) return;
  checking.value = true;
  checkError.value = "";
  try {
    const next = await props.api<VersionSnapshot>(
      "/version/check",
      { force },
      "POST",
      props.signal,
    );
    data.value = next;
    emit("update", next);
    if (force) {
      emit(
        "notice",
        next.hasUpdate && next.latest
          ? t("发现新版本 {tag}", { tag: next.latest.tag })
          : t("当前已是最新版本"),
        "success",
      );
    }
  } catch (error) {
    checkError.value = error instanceof Error ? error.message : t("检测更新失败");
  } finally {
    checking.value = false;
  }
}

async function toggleRollback() {
  rollbackOpen.value = !rollbackOpen.value;
  rollbackError.value = "";
  rollbackSuccess.value = "";
  if (rollbackOpen.value && !releases.value.length && !checking.value) {
    await checkUpdates(false);
  }
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText(rollbackCommand.value);
    copiedCmd.value = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedCmd.value = false;
    }, 1800);
  } catch {
    emit("notice", t("复制失败"), "warning");
  }
}

async function executeRollback() {
  if (!targetTag.value || rollingBack.value) return;
  rollingBack.value = true;
  rollbackError.value = "";
  rollbackSuccess.value = "";
  try {
    const result = await props.api<RollbackResult>(
      "/admin/version/rollback",
      { tag: targetTag.value },
      "POST",
      props.signal,
    );
    rollbackSuccess.value = result.message;
    emit("notice", result.message, "success");
    const refreshed = await props.api<VersionSnapshot>("/version", undefined, "GET", props.signal).catch(() => null);
    if (refreshed) {
      data.value = { ...refreshed, releases: data.value?.releases ?? refreshed.releases };
      emit("update", data.value);
    }
  } catch (error) {
    rollbackError.value = error instanceof Error ? error.message : t("回退版本失败");
  } finally {
    rollingBack.value = false;
  }
}

onBeforeUnmount(() => clearTimeout(copyTimer));

onMounted(async () => {
  try {
    const local = await props.api<VersionSnapshot>("/version", undefined, "GET", props.signal);
    data.value = local;
    emit("update", local);
    if (!local.checkedAt) {
      await checkUpdates(false);
    }
  } catch {
    await checkUpdates(false);
  }
});
</script>

<template>
  <Modal :title="t('版本信息')" :locked="rollingBack" @close="emit('close')">
    <div class="version-modal">
      <div class="version-summary">
        <div class="version-current">
          <div class="version-number-row">
            <strong class="version-number">v{{ currentVersion }}</strong>
            <span v-if="data?.git.commit" class="version-commit">{{ data.git.commit }}</span>
          </div>
          <p class="version-meta">
            GitHub · {{ repoName }}
            <template v-if="data?.checkedAt">
              · {{ t("上次检测 {time}", { time: formatDateTime(data.checkedAt) }) }}
            </template>
          </p>
        </div>
        <span class="status" :class="statusClass">
          <span class="status-dot" aria-hidden="true" />
          {{ statusText }}
        </span>
      </div>

      <div class="version-actions">
        <button type="button" class="primary" :disabled="checking || rollingBack" @click="checkUpdates(true)">
          <RefreshCw :size="15" :class="{ spinner: checking }" aria-hidden="true" />
          {{ t(checking ? "正在检测…" : "检测更新") }}
        </button>
        <a
          class="version-link-btn"
          :href="viewReleaseUrl"
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink :size="15" aria-hidden="true" />
          {{ t("查看发布") }}
        </a>
        <button
          type="button"
          :class="{ active: rollbackOpen }"
          :disabled="rollingBack"
          @click="toggleRollback"
        >
          <RotateCcw :size="15" aria-hidden="true" />
          {{ t("回退版本") }}
        </button>
      </div>

      <p v-if="checkError" class="error-message version-feedback" role="alert">{{ checkError }}</p>

      <section v-if="rollbackOpen" class="version-panel version-rollback" :aria-label="t('回退版本')">
        <div class="version-panel-head">
          <h3>{{ t("回退到历史版本") }}</h3>
          <a
            v-if="selectedRelease"
            class="version-inline-link"
            :href="selectedRelease.url"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t("查看发布") }}
            <ExternalLink :size="12" aria-hidden="true" />
          </a>
        </div>

        <template v-if="rollbackOptions.length">
          <label class="version-select-label">
            {{ t("目标版本") }}
            <SelectControl
              v-model="targetTag"
              :options="rollbackOptions"
              :disabled="rollingBack"
              :label="t('目标版本')"
            />
          </label>

          <div class="version-cmd-box">
            <code>{{ rollbackCommand }}</code>
            <button
              type="button"
              class="icon-button"
              :aria-label="t('复制命令')"
              :title="t('复制命令')"
              @click="copyCommand"
            >
              <Check v-if="copiedCmd" :size="14" aria-hidden="true" />
              <Copy v-else :size="14" aria-hidden="true" />
            </button>
          </div>

          <p v-if="rollbackError" class="error-message version-feedback" role="alert">{{ rollbackError }}</p>
          <p v-else-if="rollbackSuccess" class="version-success version-feedback" role="status">{{ rollbackSuccess }}</p>
          <p v-else-if="!isAdmin" class="muted version-hint">{{ t("仅管理员可执行在线回退，或复制上方命令手动切换。") }}</p>
          <p v-else-if="!data?.git.available" class="muted version-hint">{{ t("当前非 Git 源码部署环境，请复制上方命令在宿主机回退并重建。") }}</p>
          <p v-else-if="data?.git.dirty" class="muted version-hint">{{ t("检测到工作区有未提交修改；执行回退前请先提交或暂存本地改动。") }}</p>

          <div v-if="isAdmin && data?.git.available" class="version-rollback-footer">
            <button
              type="button"
              class="delete-confirm"
              :disabled="rollingBack || !targetTag || selectedRelease?.version === currentVersion"
              @click="executeRollback"
            >
              <RotateCcw :size="14" :class="{ spinner: rollingBack }" aria-hidden="true" />
              {{ t(rollingBack ? "正在回退…" : "确认回退到 {tag}", { tag: targetTag }) }}
            </button>
          </div>
        </template>
        <p v-else class="muted version-hint">
          {{ t(checking ? "正在获取 GitHub 发布列表…" : "暂无可用的历史发布版本。") }}
        </p>
      </section>

      <section v-if="data?.latest" class="version-panel version-release-notes">
        <div class="version-panel-head">
          <h3>
            {{ data.latest.name }}
            <span v-if="data.latest.publishedAt" class="version-date">{{ formatDate(data.latest.publishedAt) }}</span>
          </h3>
          <a
            class="version-inline-link"
            :href="releasesUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t("全部发布") }}
            <ExternalLink :size="12" aria-hidden="true" />
          </a>
        </div>
        <div v-if="data.latest.body" class="version-notes-body">{{ data.latest.body }}</div>
      </section>
    </div>
  </Modal>
</template>
