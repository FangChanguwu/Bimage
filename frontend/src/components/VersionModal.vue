<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RefreshCw, Download, ExternalLink, RotateCcw, X, LoaderCircle } from "lucide-vue-next";
import SelectControl from "./SelectControl.vue";
import { t, locale } from "../i18n";
import { renderMarkdown } from "../markdown";
import type {
  Api,
  ReleaseInfo,
  UpdateOperationState,
  VersionActionResult,
  VersionSnapshot,
  VersionStatusResult,
} from "../types";
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
  busy: [busy: boolean];
}>();

const popoverRef = ref<HTMLDivElement | null>(null);
const positionStyle = ref<Record<string, string>>({});
const closing = ref(false);
const data = ref<VersionSnapshot | null>(props.snapshot);
const checking = ref(false);
const checkError = ref("");
const activePanel = ref<"none" | "update" | "rollback">(props.snapshot?.hasUpdate ? "update" : "none");
const targetTag = ref("");
const opState = ref<UpdateOperationState | null>(props.snapshot?.operation ?? null);
const actionError = ref("");
const actionSuccess = ref("");
const waitingRestart = ref(false);
const submitting = ref(false);
const needsManualRefresh = ref(false);

const busy = computed(() => {
  if (submitting.value || waitingRestart.value) return true;
  const p = opState.value?.phase;
  return Boolean(p && !["idle", "done", "failed"].includes(p));
});

watch(busy, (val) => emit("busy", val), { immediate: true });

let closeTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let unmounted = false;

const currentVersion = computed(() => data.value?.current || props.fallbackVersion);
const repoName = computed(() => data.value?.repo || "FangChanguwu/Bimage");
const releasesUrl = computed(
  () => data.value?.releasesUrl || `https://github.com/${repoName.value}/releases`,
);
const viewReleaseUrl = computed(() => data.value?.latest?.url || releasesUrl.value);
const releases = computed<ReleaseInfo[]>(() => data.value?.releases ?? []);
const capabilities = computed(() => data.value?.capabilities ?? null);
const releaseNotesHtml = computed(() => renderMarkdown(data.value?.latest?.body ?? ""));

function parseSemver(raw: string): { nums: number[]; pre: string } | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  if (!cleaned) return null;
  const [core, ...preParts] = cleaned.split("-");
  const nums = core.split(".").map((part) => Number(part));
  if (!nums.length || nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  while (nums.length < 3) nums.push(0);
  return { nums, pre: preParts.join("-") };
}

function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

function normalizeVer(raw: string): string {
  return raw.trim().replace(/^v/i, "");
}

const rollbackReleases = computed<ReleaseInfo[]>(() =>
  releases.value.filter((rel) => compareVersions(rel.version, currentVersion.value) < 0),
);

const rollbackOptions = computed(() =>
  rollbackReleases.value.map((rel) => {
    const date = rel.publishedAt ? formatDate(rel.publishedAt) : "";
    const tagHint = rel.cached ? t("本地缓存") : "";
    const secondary = [date, tagHint].filter(Boolean).join(" · ");
    return {
      value: rel.tag,
      label: rel.tag,
      secondary: secondary || undefined,
    };
  }),
);

const selectedRelease = computed(
  () => rollbackReleases.value.find((rel) => rel.tag === targetTag.value) ?? null,
);

const canInstallLatest = computed(() => {
  if (!data.value?.hasUpdate || !data.value.latest) return false;
  return data.value.latest.canInstall !== false;
});

const canInstallSelected = computed(() => {
  if (!targetTag.value || !selectedRelease.value) return false;
  if (selectedRelease.value.version === currentVersion.value) return false;
  return selectedRelease.value.canInstall !== false;
});

const statusClass = computed(() => {
  if (checkError.value || opState.value?.phase === "failed") return "failed";
  if (checking.value || busy.value) return "running";
  if (!data.value?.checkedAt) return "";
  return data.value.hasUpdate ? "running" : "succeeded";
});

const statusText = computed(() => {
  if (busy.value) {
    return opState.value?.action === "rollback" ? t("正在回退…") : t("正在更新…");
  }
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
  targetTag.value = list[0]?.tag || "";
}

watch(rollbackReleases, syncDefaultTarget, { immediate: true });
watch(
  () => props.snapshot,
  (next) => {
    if (next) {
      data.value = next;
      if (next.operation) opState.value = next.operation;
    }
  },
);

async function checkUpdates(force = true) {
  if (checking.value || busy.value) return;
  checking.value = true;
  checkError.value = "";
  try {
    const result = await props.api<VersionSnapshot>(
      "/admin/version/check",
      { force },
      "POST",
      props.signal,
    );
    data.value = result;
    if (result.operation) opState.value = result.operation;
    emit("update", result);
    if (result.hasUpdate && activePanel.value === "none") {
      activePanel.value = "update";
    }
    if (force) {
      emit(
        "notice",
        result.hasUpdate && result.latest
          ? t("发现新版本 {tag}", { tag: result.latest.tag })
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

function togglePanel(panel: "update" | "rollback") {
  if (busy.value) return;
  actionError.value = "";
  actionSuccess.value = "";
  needsManualRefresh.value = false;
  activePanel.value = activePanel.value === panel ? "none" : panel;
  if (activePanel.value !== "none" && !releases.value.length && !checking.value) {
    void checkUpdates(false);
  }
}

function reloadPage() {
  window.location.reload();
}

async function waitForServiceRecovery(expectedVersion: string, previousVersion: string) {
  waitingRestart.value = true;
  needsManualRefresh.value = false;
  const target = normalizeVer(expectedVersion);
  const prev = normalizeVer(previousVersion);
  opState.value = {
    id: opState.value?.id || "restart",
    action: opState.value?.action || "update",
    targetTag: opState.value?.targetTag || (target ? `v${target}` : ""),
    phase: "restarting",
    progress: 97,
    message: t("等待新版本服务启动…"),
    startedAt: opState.value?.startedAt || new Date().toISOString(),
  };

  const deadline = Date.now() + 60_000;
  let sawDisconnect = false;

  while (!unmounted && Date.now() < deadline) {
    await new Promise((r) => {
      pollTimer = setTimeout(r, 800);
    });
    if (unmounted) return;
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (!res.ok) {
        sawDisconnect = true;
        continue;
      }
      const body = (await res.json()) as { ok?: boolean; version?: string };
      if (!body.ok) continue;
      const reported = normalizeVer(body.version || "");
      if (!reported) continue;
      const matchedTarget = target ? reported === target : reported !== prev;
      if (matchedTarget) {
        waitingRestart.value = false;
        opState.value = {
          ...opState.value!,
          phase: "done",
          progress: 100,
          message: t("已切换至 v{version}，正在刷新页面…", { version: reported }),
        };
        actionSuccess.value = opState.value.message;
        emit("notice", opState.value.message, "success");
        await new Promise((r) => {
          pollTimer = setTimeout(r, 600);
        });
        if (!unmounted) window.location.reload();
        return;
      }
      if (sawDisconnect) {
        waitingRestart.value = false;
        needsManualRefresh.value = true;
        const msg =
          reported === prev
            ? t("服务已重启，但仍运行在旧版本 v{version}，请检查日志或重试。", { version: reported })
            : t("服务已恢复为 v{actual}，与目标版本 v{expected} 不一致，请刷新页面确认。", {
                actual: reported,
                expected: target || prev,
              });
        opState.value = {
          ...opState.value!,
          phase: "failed",
          message: msg,
          error: msg,
        };
        actionError.value = msg;
        emit("notice", msg, "error");
        return;
      }
    } catch {
      sawDisconnect = true;
    }
  }

  waitingRestart.value = false;
  if (!unmounted) {
    needsManualRefresh.value = true;
    const msg = t("等待服务重启超时，请手动刷新页面确认当前版本。");
    opState.value = opState.value
      ? { ...opState.value, phase: "failed", message: msg, error: msg }
      : null;
    actionError.value = msg;
  }
}

async function pollOperationUntilRestart(expectedVersion: string, previousVersion: string) {
  while (!unmounted) {
    await new Promise((r) => {
      pollTimer = setTimeout(r, 600);
    });
    if (unmounted) return;
    try {
      const status = await props.api<VersionStatusResult>(
        "/admin/version/status",
        undefined,
        "GET",
        props.signal,
      );
      if (status.operation) {
        opState.value = status.operation;
        if (status.operation.phase === "failed") {
          actionError.value = status.operation.error || status.operation.message;
          return;
        }
        if (status.operation.phase === "restarting") {
          await waitForServiceRecovery(expectedVersion, previousVersion);
          return;
        }
        if (status.operation.phase === "done") {
          actionSuccess.value = status.operation.message;
          emit("notice", status.operation.message, "success");
          return;
        }
      } else if (status.current && status.current !== previousVersion) {
        await waitForServiceRecovery(expectedVersion, previousVersion);
        return;
      }
    } catch {
      // Connection dropped because the backend already entered restart shutdown
      await waitForServiceRecovery(expectedVersion, previousVersion);
      return;
    }
  }
}

async function executeUpdate() {
  if (busy.value || !data.value?.hasUpdate || !data.value.latest) return;
  submitting.value = true;
  actionError.value = "";
  actionSuccess.value = "";
  needsManualRefresh.value = false;
  const previousVersion = currentVersion.value;
  const expectedVersion = data.value.latest.version;
  try {
    const result = await props.api<VersionActionResult>(
      "/admin/version/update",
      {},
      "POST",
      props.signal,
    );
    opState.value = result.operation;
    submitting.value = false;
    await pollOperationUntilRestart(expectedVersion, previousVersion);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : t("更新版本失败");
  } finally {
    submitting.value = false;
  }
}

async function executeRollback(explicitTag?: string) {
  if (busy.value) return;
  submitting.value = true;
  actionError.value = "";
  actionSuccess.value = "";
  needsManualRefresh.value = false;
  const previousVersion = currentVersion.value;
  const tagToUse = explicitTag === undefined ? targetTag.value : explicitTag;
  const expectedVersion = tagToUse
    ? tagToUse.replace(/^v/i, "")
    : capabilities.value?.backupVersion || "";
  try {
    const result = await props.api<VersionActionResult>(
      "/admin/version/rollback",
      tagToUse ? { tag: tagToUse } : {},
      "POST",
      props.signal,
    );
    opState.value = result.operation;
    submitting.value = false;
    await pollOperationUntilRestart(expectedVersion, previousVersion);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : t("回退版本失败");
  } finally {
    submitting.value = false;
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
  closeTimer = setTimeout(() => {
    emit("close");
    props.anchor?.focus();
  }, delay);
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
  unmounted = true;
  emit("busy", false);
  clearTimeout(closeTimer);
  clearTimeout(pollTimer);
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  document.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("resize", place);
  window.removeEventListener("scroll", onViewportScroll, true);
});

onMounted(async () => {
  place();
  void nextTick(() => popoverRef.value?.focus({ preventScroll: true }));
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", place);
  window.addEventListener("scroll", onViewportScroll, true);
  try {
    const local = await props.api<VersionSnapshot>("/admin/version", undefined, "GET", props.signal);
    data.value = local;
    emit("update", local);
    if (local.operation && !["idle", "done", "failed"].includes(local.operation.phase)) {
      opState.value = local.operation;
      activePanel.value = local.operation.action === "rollback" ? "rollback" : "update";
      const targetVer = local.operation.targetTag?.replace(/^v/i, "") || "";
      void pollOperationUntilRestart(targetVer, local.current);
      return;
    }
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
      tabindex="-1"
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
            <p v-if="data?.checkedAt" class="version-meta">
              {{ t("上次检测 {time}", { time: formatDateTime(data.checkedAt) }) }}
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
        <div v-if="actionError" class="version-feedback-box">
          <p class="error-message version-feedback" role="alert">{{ actionError }}</p>
          <div v-if="needsManualRefresh" class="version-recovery-actions">
            <button type="button" :disabled="checking || busy" @click="checkUpdates(true)">{{ t("重新检测状态") }}</button>
            <button type="button" class="primary" @click="reloadPage">{{ t("刷新页面") }}</button>
          </div>
        </div>
        <p v-else-if="actionSuccess" class="version-success version-feedback" role="status">{{ actionSuccess }}</p>

        <div v-if="busy && opState" class="version-progress" role="status" aria-live="polite">
          <div class="version-progress-head">
            <span>{{ opState.message }}</span>
            <span class="version-progress-pct">{{ Math.round(opState.progress) }}%</span>
          </div>
          <div class="version-progress-track">
            <div class="version-progress-bar" :style="{ width: `${Math.min(100, Math.max(4, opState.progress))}%` }" />
          </div>
        </div>
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

          <p v-if="data?.checkedAt && !data?.hasUpdate" class="muted version-hint">
            {{ t("当前已是最新版本，无需更新。") }}
          </p>
          <p v-else-if="data?.hasUpdate && !canInstallLatest && data?.git.dirty" class="muted version-hint">
            {{ t("检测到工作区有未提交修改；执行更新前请先提交或暂存本地改动。") }}
          </p>
          <p v-else-if="data?.hasUpdate && !canInstallLatest" class="muted version-hint">
            {{ t("该版本未附带在线更新包，无法在当前环境自动安装。") }}
          </p>
          <p v-else-if="data?.hasUpdate" class="muted version-hint">
            {{ t("点击后将自动下载更新包、校验完整性并重启服务，完成后页面会自动刷新。") }}
          </p>

          <div v-if="data?.hasUpdate && data?.latest" class="version-rollback-footer">
            <button
              type="button"
              class="primary"
              :disabled="busy || !canInstallLatest"
              @click="executeUpdate"
            >
              <LoaderCircle v-if="busy" :size="14" class="spinner" aria-hidden="true" />
              <Download v-else :size="14" aria-hidden="true" />
              {{
                busy
                  ? t("正在更新…")
                  : t("立即更新到 {tag}", { tag: data.latest.tag })
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

          <div
            v-if="capabilities?.hasLocalBackup && capabilities.backupTag"
            class="version-backup-box"
          >
            <span class="version-backup-label">{{ t("本地备份") }} · {{ capabilities.backupTag }}</span>
            <button
              type="button"
              :disabled="busy"
              @click="executeRollback('')"
            >
              <RotateCcw :size="13" aria-hidden="true" />
              {{ t("一键恢复上一版本 {tag}", { tag: capabilities.backupTag }) }}
            </button>
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

            <p v-if="selectedRelease && selectedRelease.version !== currentVersion && !canInstallSelected && data?.git.dirty" class="muted version-hint">
              {{ t("检测到工作区有未提交修改；执行回退前请先提交或暂存本地改动。") }}
            </p>
            <p v-else-if="selectedRelease && selectedRelease.version !== currentVersion && !canInstallSelected" class="muted version-hint">
              {{ t("该历史版本未附带在线更新包，无法在当前环境自动回退。") }}
            </p>

            <div class="version-rollback-footer">
              <button
                type="button"
                class="delete-confirm"
                :disabled="busy || !canInstallSelected"
                @click="executeRollback()"
              >
                <LoaderCircle v-if="busy" :size="14" class="spinner" aria-hidden="true" />
                <RotateCcw v-else :size="14" aria-hidden="true" />
                {{ t(busy ? "正在回退…" : "确认回退到 {tag}", { tag: targetTag }) }}
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
          <div v-if="releaseNotesHtml" class="version-notes-body" v-html="releaseNotesHtml" />
        </section>
      </div>
    </div>
  </Teleport>
</template>
