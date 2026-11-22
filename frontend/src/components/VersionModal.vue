<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RefreshCw, Download, ExternalLink, RotateCcw, Copy, Check, X } from "lucide-vue-next";
import SelectControl from "./SelectControl.vue";
import { t, locale } from "../i18n";
import type { Api, ReleaseInfo, RollbackResult, VersionSnapshot } from "../types";
import type { NoticeType } from "./ToastNotice.vue";

const props = defineProps<{
  api: Api;
  signal: AbortSignal;
  anchor: HTMLElement | null;
  snapshot: VersionSnapshot | null;
  fallbackVersion: string;
}>();

const emit = defineEmits<{
  close: [];
  update: [snapshot: VersionSnapshot];
  notice: [message: string, type: NoticeType];
}>();

const popoverRef = ref<HTMLDivElement | null>(null);
const positionStyle = ref<Record<string, string>>({});
const closing = ref(false);
const data = ref<VersionSnapshot | null>(props.snapshot);
const checking = ref(false);
const checkError = ref("");
const activePanel = ref<"none" | "update" | "rollback">(props.snapshot?.hasUpdate ? "update" : "none");
const targetTag = ref("");
const updating = ref(false);
const updateError = ref("");
const updateSuccess = ref("");
const rollingBack = ref(false);
const rollbackError = ref("");
const rollbackSuccess = ref("");
const copiedCmd = ref<"" | "update" | "rollback">("");
const busy = computed(() => rollingBack.value || updating.value);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
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

const updateCommand = computed(() =>
  data.value?.git.available
    ? "git pull --ff-only && npm run build"
    : "git pull --ff-only && docker compose build && docker compose up -d --force-recreate --wait",
);

const rollbackCommand = computed(() => {
  const tag = targetTag.value || "v0.3.4";
  return data.value?.git.available
    ? `git fetch --tags && git checkout ${tag} && npm run build`
    : `git fetch --tags && git checkout ${tag} && docker compose build && docker compose up -d --force-recreate --wait`;
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
      "/admin/version/check",
      { force },
      "POST",
      props.signal,
    );
    data.value = next;
    emit("update", next);
    if (next.hasUpdate && activePanel.value === "none") {
      activePanel.value = "update";
    }
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

async function togglePanel(panel: "update" | "rollback") {
  activePanel.value = activePanel.value === panel ? "none" : panel;
  updateError.value = "";
  updateSuccess.value = "";
  rollbackError.value = "";
  rollbackSuccess.value = "";
  if (activePanel.value !== "none" && !releases.value.length && !checking.value) {
    await checkUpdates(false);
  }
}

async function copyCommand(kind: "update" | "rollback") {
  try {
    const text = kind === "update" ? updateCommand.value : rollbackCommand.value;
    await navigator.clipboard.writeText(text);
    copiedCmd.value = kind;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedCmd.value = "";
    }, 1800);
  } catch {
    emit("notice", t("复制失败"), "warning");
  }
}

async function refreshLocalSnapshot() {
  const refreshed = await props.api<VersionSnapshot>("/admin/version", undefined, "GET", props.signal).catch(() => null);
  if (refreshed) {
    data.value = {
      ...refreshed,
      releases: refreshed.releases.length ? refreshed.releases : (data.value?.releases ?? []),
    };
    emit("update", data.value);
  }
}

async function executeUpdate() {
  if (busy.value || !data.value?.hasUpdate || !data.value.latest) return;
  updating.value = true;
  updateError.value = "";
  updateSuccess.value = "";
  try {
    const result = await props.api<RollbackResult>(
      "/admin/version/update",
      {},
      "POST",
      props.signal,
    );
    updateSuccess.value = result.message;
    emit("notice", result.message, "success");
    await refreshLocalSnapshot();
  } catch (error) {
    updateError.value = error instanceof Error ? error.message : t("更新版本失败");
  } finally {
    updating.value = false;
  }
}

async function executeRollback() {
  if (!targetTag.value || busy.value) return;
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
    await refreshLocalSnapshot();
  } catch (error) {
    rollbackError.value = error instanceof Error ? error.message : t("回退版本失败");
  } finally {
    rollingBack.value = false;
  }
}

function place() {
  const el = props.anchor;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const sidebar = el.closest(".sidebar")?.getBoundingClientRect();
  const margin = 12;
  const popWidth = Math.min(324, Math.max(240, window.innerWidth - margin * 2));
  const anchorCenter = r.left + r.width / 2;
  const centeredLeft = anchorCenter - popWidth / 2;
  const minLeft = sidebar && window.innerWidth > 900 ? Math.max(margin, sidebar.left) : margin;
  const left = Math.max(minLeft, Math.min(centeredLeft, window.innerWidth - popWidth - margin));
  const top = Math.max(margin, r.bottom + 8);
  const maxHeight = Math.max(200, window.innerHeight - top - 16);
  const caretX = Math.max(18, Math.min(popWidth - 18, anchorCenter - left));
  positionStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    width: `${Math.round(popWidth)}px`,
    maxHeight: `${Math.round(maxHeight)}px`,
    "--version-caret-x": `${Math.round(caretX)}px`,
    transformOrigin: `${Math.round(caretX)}px top`,
  };
}

function close() {
  if (closing.value || busy.value) return;
  closing.value = true;
  const delay = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 110;
  closeTimer = setTimeout(() => emit("close"), delay);
}

function onPointerDownOutside(e: Event) {
  if (busy.value) return;
  const target = e.target as Node | null;
  if (!target) return;
  if (popoverRef.value?.contains(target)) return;
  if (props.anchor?.contains(target)) return;
  if (target instanceof Element && target.closest(".select-menu")) return;
  close();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && !busy.value && !document.querySelector(".select-menu")) {
    e.preventDefault();
    close();
    props.anchor?.focus();
  }
}

function onViewportScroll(e: Event) {
  const target = e.target as Node | null;
  if (target && popoverRef.value?.contains(target)) return;
  place();
}

watch(() => props.anchor, place);

onBeforeUnmount(() => {
  clearTimeout(copyTimer);
  clearTimeout(closeTimer);
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  document.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", onViewportScroll, true);
});

onMounted(async () => {
  place();
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", onViewportScroll, true);
  try {
    const local = await props.api<VersionSnapshot>("/admin/version", undefined, "GET", props.signal);
    data.value = local;
    emit("update", local);
    if (local.hasUpdate && activePanel.value === "none") {
      activePanel.value = "update";
    }
    if (!local.checkedAt) {
      await checkUpdates(false);
    }
  } catch {
    await checkUpdates(false);
  }
});
</script>

<template>
  <Teleport to="body">
    <div
      ref="popoverRef"
      role="dialog"
      :aria-label="t('版本信息')"
      class="version-popover"
      :class="{ closing }"
      :style="positionStyle"
    >
      <div class="version-modal">
        <div class="version-summary">
          <div class="version-current">
            <div class="version-number-row">
              <strong class="version-number">v{{ currentVersion }}</strong>
              <span v-if="data?.git.commit" class="version-commit">{{ data.git.commit }}</span>
              <span class="status version-status" :class="statusClass">
                <span class="status-dot" aria-hidden="true" />
                {{ statusText }}
              </span>
            </div>
            <p class="version-meta">
              GitHub · {{ repoName }}
              <template v-if="data?.checkedAt">
                · {{ t("上次检测 {time}", { time: formatDateTime(data.checkedAt) }) }}
              </template>
            </p>
          </div>
          <button
            type="button"
            class="icon-button version-close"
            :aria-label="t('关闭弹窗')"
            :disabled="busy"
            @click="close"
          >
            <X :size="14" aria-hidden="true" />
          </button>
        </div>

        <div class="version-actions">
          <button
            type="button"
            :class="{ primary: !data?.hasUpdate }"
            :disabled="checking || busy"
            @click="checkUpdates(true)"
          >
            <RefreshCw :size="13" :class="{ spinner: checking }" aria-hidden="true" />
            {{ t(checking ? "正在检测…" : "检测更新") }}
          </button>
          <button
            type="button"
            :class="{ primary: data?.hasUpdate, active: activePanel === 'update' && !data?.hasUpdate }"
            :disabled="busy"
            @click="togglePanel('update')"
          >
            <Download :size="13" aria-hidden="true" />
            {{ t("更新版本") }}
          </button>
          <a
            class="version-link-btn"
            :href="viewReleaseUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink :size="13" aria-hidden="true" />
            {{ t("查看发布") }}
          </a>
          <button
            type="button"
            :class="{ active: activePanel === 'rollback' }"
            :disabled="busy"
            @click="togglePanel('rollback')"
          >
            <RotateCcw :size="13" aria-hidden="true" />
            {{ t("回退版本") }}
          </button>
        </div>

      <p v-if="checkError" class="error-message version-feedback" role="alert">{{ checkError }}</p>

      <section v-if="activePanel === 'update'" class="version-panel version-update" :aria-label="t('更新版本')">
        <div class="version-panel-head">
          <h3>
            {{ t("更新到最新版本") }}
            <span v-if="data?.latest" class="version-date">{{ data.latest.tag }}</span>
          </h3>
          <a
            v-if="data?.latest"
            class="version-inline-link"
            :href="data.latest.url"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ t("查看发布") }}
            <ExternalLink :size="12" aria-hidden="true" />
          </a>
        </div>

        <div class="version-cmd-box">
          <code>{{ updateCommand }}</code>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('复制命令')"
            :title="t('复制命令')"
            @click="copyCommand('update')"
          >
            <Check v-if="copiedCmd === 'update'" :size="14" aria-hidden="true" />
            <Copy v-else :size="14" aria-hidden="true" />
          </button>
        </div>

        <p v-if="updateError" class="error-message version-feedback" role="alert">{{ updateError }}</p>
        <p v-else-if="updateSuccess" class="version-success version-feedback" role="status">{{ updateSuccess }}</p>
        <p v-else-if="data?.checkedAt && !data?.hasUpdate" class="muted version-hint">{{ t("当前已是最新版本，无需更新。") }}</p>
        <p v-else-if="!data?.git.available" class="muted version-hint">{{ t("当前非 Git 源码部署环境，请复制上方命令在宿主机更新并重建。") }}</p>
        <p v-else-if="data?.git.dirty" class="muted version-hint">{{ t("检测到工作区有未提交修改；执行更新前请先提交或暂存本地改动。") }}</p>

        <div v-if="data?.git.available" class="version-rollback-footer">
          <button
            type="button"
            class="primary"
            :disabled="busy || !data?.hasUpdate || !data?.latest"
            @click="executeUpdate"
          >
            <Download :size="14" :class="{ spinner: updating }" aria-hidden="true" />
            {{
              updating
                ? t("正在更新…")
                : data?.hasUpdate && data?.latest
                  ? t("更新到 {tag}", { tag: data.latest.tag })
                  : t("已是最新版本")
            }}
          </button>
        </div>
      </section>

      <section v-if="activePanel === 'rollback'" class="version-panel version-rollback" :aria-label="t('回退版本')">
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
              :disabled="busy"
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
              @click="copyCommand('rollback')"
            >
              <Check v-if="copiedCmd === 'rollback'" :size="14" aria-hidden="true" />
              <Copy v-else :size="14" aria-hidden="true" />
            </button>
          </div>

          <p v-if="rollbackError" class="error-message version-feedback" role="alert">{{ rollbackError }}</p>
          <p v-else-if="rollbackSuccess" class="version-success version-feedback" role="status">{{ rollbackSuccess }}</p>
          <p v-else-if="!data?.git.available" class="muted version-hint">{{ t("当前非 Git 源码部署环境，请复制上方命令在宿主机回退并重建。") }}</p>
          <p v-else-if="data?.git.dirty" class="muted version-hint">{{ t("检测到工作区有未提交修改；执行回退前请先提交或暂存本地改动。") }}</p>

          <div v-if="data?.git.available" class="version-rollback-footer">
            <button
              type="button"
              class="delete-confirm"
              :disabled="busy || !targetTag || selectedRelease?.version === currentVersion"
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
    </div>
  </Teleport>
</template>
