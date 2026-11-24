<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, toRaw, nextTick } from "vue";
import {
  Sparkles,
  WandSparkles,
  Settings as SettingsIcon,
  LogOut,
  Moon,
  Sun,
  Image,
  ArrowUp,
  ArrowUpRight,
  X,
  Search,
  UsersRound,
  Star,
} from "lucide-vue-next";
import Composer from "./Composer.vue";
import ToastNotice, { type Notice, type NoticeType } from './ToastNotice.vue';
import JobCard from "./JobCard.vue";
import QuickPrompt from "./QuickPrompt.vue";
import SettingsPanel from "./SettingsPanel.vue";
import UserManagement from "./UserManagement.vue";
import FavoritesView from "./FavoritesView.vue";
import AgentView from "./AgentView.vue";
import LanguageSwitch from './LanguageSwitch.vue';
import VersionModal from './VersionModal.vue';
import { version as appVersion } from '../../package.json';
import { t } from '../i18n';
import { assetCache } from "../composables/assetCache";
import { useHistory } from "../composables/useHistory";
import { resolveTextDefaults } from "../composables/textDefaults";
import { emptyForm, restoreForm, jobPayload, resolveChoice, MAX_REFERENCES } from "../domain";
import type {
  Site,
  Identity,
  Provider,
  Job,
  GenerationForm,
  Settings,
  Api,
  Run,
  VersionSnapshot,
  FavoriteItem,
  RepairResult,
} from "../types";
const props = defineProps<{
  site: Site;
  identity: Identity;
  api: Api;
  signal: AbortSignal;
  theme: string;
}>();
const emit = defineEmits<{
  theme: [];
  logout: [];
  site: [site: Site];
}>();
const page = ref<"agent" | "studio" | "favorites" | "users" | "settings">("studio"),
  providers = ref<Provider[]>([]),
  favorites = ref<FavoriteItem[]>([]),
  favoritesLoading = ref(false),
  cancellingJobs = ref(new Set<string>()),
  historyHeading = ref<HTMLElement>(),
  settings = ref<Settings>({}),
  form = ref<GenerationForm>(emptyForm()),
  notice = ref<Notice | null>(null),
  quick = ref(false),
  versionOpen = ref(false),
  versionTrigger = ref<HTMLButtonElement | null>(null),
  versionSnapshot = ref<VersionSnapshot | null>(null),
  busy = ref(false),
  loading = ref(true),
  showBackToTop = ref(false);
const isAdmin = computed(() => props.identity.role === "admin");
const displayVersion = computed(() => (isAdmin.value && versionSnapshot.value?.current) || appVersion);
const pageTitle = computed(() => t(({ agent: "Agent 创作", studio: "图像工作台", favorites: "收藏夹", users: "用户管理", settings: "系统设置" })[page.value]));
const pageContext = computed(() => t(({ agent: "对话构思、批量出图与自动视觉验收。", studio: "让想法，成为画面。", favorites: "精选画面与完整创作记录。", users: "管理登录账号与图像请求权限。", settings: "连接服务，整理创作偏好。" })[page.value]));
const favoriteAssets = computed(() => new Set(favorites.value.map((item) => item.asset)));
const pageOrder: Record<"agent" | "studio" | "favorites" | "users" | "settings", number> = {
  agent: 0,
  studio: 1,
  favorites: 2,
  users: 3,
  settings: 4,
};
const pageTransition = ref<"page-forward" | "page-backward">("page-forward");
let pendingScrollReset = false;
watch(page, (current, previous) => {
  if (current === previous) return;
  pageTransition.value = pageOrder[current] >= pageOrder[previous] ? "page-forward" : "page-backward";
  pendingScrollReset = true;
});
function updateBackToTop() {
  showBackToTop.value = page.value === "studio" && !loading.value && window.scrollY > 360;
}
function scrollToTop() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
}
watch([page, loading], updateBackToTop);
onMounted(() => {
  window.addEventListener("scroll", updateBackToTop, { passive: true });
  window.addEventListener("resize", updateBackToTop, { passive: true });
  updateBackToTop();
});
function onPageAfterLeave() {
  if (!pendingScrollReset) return;
  pendingScrollReset = false;
  window.scrollTo({ top: 0, behavior: "instant" });
  updateBackToTop();
}
watch(isAdmin, (allowed) => {
  if (!allowed) {
    versionOpen.value = false;
    versionSnapshot.value = null;
  }
});
let active = true,
  draftVersion = 0,
  saveTimer: ReturnType<typeof setTimeout> | undefined,
  noticeTimer: ReturnType<typeof setTimeout> | undefined,
  saveQueue = Promise.resolve();
const available = computed(() =>
  providers.value.filter((p) => p.owner === props.identity.id || p.shared),
);
const history = useHistory(props.api, props.signal, missing => {
  const retained = new Set(form.value.references);
  if (form.value.mask) retained.add(form.value.mask);
  for (const job of history.jobs.value) {
    for (const id of job.form.references) retained.add(id);
    if (job.form.mask) retained.add(job.form.mask);
    for (const task of job.tasks) if (task.asset) retained.add(task.asset);
  }
  for (const fav of favorites.value) {
    retained.add(fav.asset);
    for (const id of fav.form.references || []) retained.add(id);
    if (fav.form.mask) retained.add(fav.form.mask);
  }
  const cache = assetCache(props.signal);
  for (const job of missing) for (const task of job.tasks)
    if (task.asset && !retained.has(task.asset)) cache.evict(task.asset);
});
const { jobs, query: historyQuery, total: historyTotal, hasMore, loadingMore, searching } = history;
const refreshHistory = history.refresh;
const noticeParams = ref<Record<string, string | number>>({});
const translatedNotice = computed(() => notice.value && { ...notice.value, message: t(notice.value.message, noticeParams.value) });
function notify(message: string, type: NoticeType, options: Pick<Notice, 'action' | 'shape'> = {}) {
  noticeParams.value = {};
  notice.value = { message, type, ...options };
  clearTimeout(noticeTimer);
  if (message) noticeTimer = setTimeout(() => (notice.value = null), 6000);
}
const run: Run = async (fn, success) => {
  try {
    const result = await fn();
    props.signal.throwIfAborted();
    if (active && success) notify(success, 'success');
    return result;
  } catch (e) {
    if (active && (e as Error).name !== "AbortError")
      notify((e as Error).message, 'error');
  }
};
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const captured = JSON.parse(
      JSON.stringify({ ...settings.value, form: form.value }),
    ) as Settings;
    saveQueue = saveQueue
      .catch(() => {})
      .then(async () => {
        if (!active) return;
        await props.api("/settings", captured, "PUT");
      })
      .catch((e) => {
        if (active && (e as Error).name !== "AbortError")
          notify("草稿同步失败，请检查网络", 'error');
      });
  }, 600);
}
function change(next: GenerationForm) {
  draftVersion++;
  form.value = next;
  // SettingsPanel saves the whole settings object, so never leave its form stale.
  settings.value = { ...settings.value, form: next };
  persist();
}
function patchSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  persist();
}
function restorePartialForm(patch: Partial<GenerationForm>) {
  restoreFromForm({ ...emptyForm(), ...form.value, ...patch });
}
async function refresh() {
  const [p] = await Promise.all([
    props.api<Provider[]>("/providers"),
    refreshHistory(),
  ]);
  if (!active) return;
  providers.value = p;
  resolveDefaults();
}
function resolveDefaults() {
  const image = resolveChoice(
    available.value,
    "image",
    form.value.providerId,
    form.value.model,
    {
      providerId: settings.value.imageProvider,
      model: settings.value.imageModel,
    },
  );
  form.value = { ...form.value, ...image };
  settings.value = resolveTextDefaults(available.value, settings.value);
}
async function loadFavorites() {
  favoritesLoading.value = true;
  try {
    const res = await props.api<{ items: FavoriteItem[] }>("/favorites", undefined, "GET", props.signal);
    if (active && !props.signal.aborted) {
      favorites.value = res.items;
    }
  } catch {
    /* Non-fatal: favorites can be retried when opening the Favorites tab */
  } finally {
    favoritesLoading.value = false;
  }
}
onMounted(async () => {
  await run(async () => {
    const [p, , s] = await Promise.all([
      props.api<Provider[]>("/providers"),
      refreshHistory(),
      props.api<Settings>("/settings"),
      loadFavorites(),
    ]);
    if (!active) return;
    providers.value = p;
    settings.value = s;
    form.value = s.form
      ? restoreForm(s.form)
      : {
          ...emptyForm(),
          providerId: s.imageProvider || "",
          model: s.imageModel || "",
        };
    resolveDefaults();
  });
  loading.value = false;
  if (active) {
    history.start();
    if (isAdmin.value) {
      void props.api<VersionSnapshot>("/admin/version/check", { force: false }, "POST", props.signal)
        .then((snapshot) => {
          if (active && isAdmin.value && !props.signal.aborted) versionSnapshot.value = snapshot;
        })
        .catch(() => {});
    }
  }
});
onBeforeUnmount(() => {
  active = false;
  window.removeEventListener("scroll", updateBackToTop);
  window.removeEventListener("resize", updateBackToTop);
  clearTimeout(saveTimer);
  clearTimeout(noticeTimer);
  providers.value = [];
  jobs.value = [];
  cancellingJobs.value.clear();
  form.value = emptyForm();
  settings.value = {};
  historyQuery.value = '';
  notice.value = null;
});
watch(
  [pageTitle, () => props.site.title],
  () =>
    (document.title = `${props.site.title || "Bimage"} | ${pageTitle.value}`),
  { immediate: true },
);
async function generate() {
  if (busy.value) return;
  if (!form.value.providerId || !form.value.model) {
    notify("请先在设置中添加供应商并选择图像模型", 'warning', { action: 'settings' });
    return;
  }
  if (!form.value.prompt.trim()) {
    notify("请先填写提示词", 'warning');
    return;
  }
  busy.value = true;
  const captured = JSON.parse(JSON.stringify(form.value)) as GenerationForm,
    version = draftVersion;
  try {
    const accepted = await run(async () => {
      await props.api<Job>("/jobs", jobPayload(captured));
      props.signal.throwIfAborted();
      if (draftVersion === version)
        change({ ...form.value, prompt: "", references: [], mask: undefined });
      await refresh();
      return true;
    });
    if (accepted && active) notify("已将请求加入队列。", 'success', { shape: 'pill' });
  } finally {
    busy.value = false;
  }
}
function focusComposer() {
  void nextTick(() => {
    const field = document.getElementById("composer-prompt");
    field?.scrollIntoView({ behavior: "smooth", block: "center" });
    field?.focus({ preventScroll: true });
  });
}
function restore(job: Job) {
  restoreFromForm(job.form);
}
function restoreFromForm(sourceForm: GenerationForm) {
  change(restoreForm(toRaw(sourceForm)));
  page.value = "studio";
  focusComposer();
  notify("完整参数和参考图已恢复；点击生成才会提交任务", 'success');
}
function addAsReference(assetId: string) {
  if (form.value.references.includes(assetId)) {
    if (page.value !== "studio") page.value = "studio";
    focusComposer();
    notify("该图片已在参考图列表中", "warning");
    return;
  }
  if (form.value.references.length >= MAX_REFERENCES) {
    notify("参考图最多16张，请减少后重试", "warning");
    return;
  }
  change({
    ...form.value,
    references: [...form.value.references, assetId],
  });
  if (page.value !== "studio") page.value = "studio";
  focusComposer();
  notify("已添加到参考图", "success", { shape: "pill" });
}
async function toggleFavorite(jobId: string, taskId: string, assetId: string) {
  if (favoriteAssets.value.has(assetId)) {
    await unfavorite(assetId);
    return;
  }
  const item = await run(() =>
    props.api<FavoriteItem>("/favorites", { jobId, taskId }, "POST", props.signal),
  );
  if (!item || !active || props.signal.aborted) return;
  if (!favorites.value.some((existing) => existing.asset === item.asset)) {
    favorites.value = [item, ...favorites.value];
  }
  notify("已加入收藏夹", "success", { shape: "pill" });
}
async function unfavorite(assetId: string) {
  const result = await run(() =>
    props.api<{ ok: boolean; asset: string; deletedAssetIds: string[] }>(
      "/favorites/" + encodeURIComponent(assetId),
      undefined,
      "DELETE",
      props.signal,
    ),
  );
  if (!result || !active || props.signal.aborted) return;
  favorites.value = favorites.value.filter((item) => item.asset !== assetId);
  const cache = assetCache(props.signal);
  for (const id of result.deletedAssetIds || []) cache.evict(id);
  notify("已取消收藏", "success", { shape: "pill" });
}
async function cancelQueued(id: string) {
  if (cancellingJobs.value.has(id) ||
      !jobs.value.find(job => job.id === id)?.tasks.some(task => task.status === "queued")) return;
  cancellingJobs.value.add(id);
  history.beginMutation(id);
  try {
    const result = await run(() => props.api<Job & { cancelledCount: number }>(
      "/jobs/" + encodeURIComponent(id) + "/cancel", {},
    ));
    if (!result || !active || props.signal.aborted) return;
    const { cancelledCount, ...job } = result;
    // Apply the mutation's snapshot directly; an older poll must not restore queued slots.
    history.endMutation(id, job);
    if (cancelledCount > 0) {
      notify('已取消 {count} 项排队任务。', "success");
      noticeParams.value = { count: cancelledCount };
    }
    else notify("没有可取消的排队任务。", "warning");
  } finally {
    cancellingJobs.value.delete(id);
    history.endMutation(id);
  }
}
async function removeJob(id: string) {
  const result = await run(() => props.api<{ deletedAssetIds: string[] }>(
    "/jobs/" + encodeURIComponent(id), undefined, "DELETE",
  ));
  if (!result || !active || props.signal.aborted) return;
  // Responses from polls started before deletion must not restore the card.
  const cache = assetCache(props.signal);
  const removed = new Set(result.deletedAssetIds);
  for (const asset of removed) cache.evict(asset);
  const nextRefs = form.value.references.filter(asset => !removed.has(asset));
  const nextMask = form.value.mask && removed.has(form.value.mask) ? undefined : form.value.mask;
  if (nextRefs.length !== form.value.references.length || nextMask !== form.value.mask) {
    change({ ...form.value, references: nextRefs, mask: nextRefs.length ? nextMask : undefined });
  }
  history.remove(id);
  await nextTick();
  if (active && !props.signal.aborted) {
    historyHeading.value?.focus({ preventScroll: true });
    notify("任务已删除。", "success");
  }
}
function repair(job: Job, result: RepairResult) {
  if (result.mode === "mask") {
    change({
      ...restoreForm(toRaw(job.form)),
      count: 1,
      prompt: result.prompt,
      references: [result.imageId],
      mask: result.maskId,
    });
    focusComposer();
    notify("像素蒙版重绘已回填；点击生成才会提交任务", "success");
    return;
  }
  change({
    ...restoreForm(toRaw(job.form)),
    count: 1,
    prompt: result.prompt,
    references: [result.imageId],
    mask: undefined,
  });
  focusComposer();
  notify("局部修复已回填；点击生成才会提交任务", "success");
}
function defaultsSaved(value: Settings) {
  settings.value = value;
  if (!form.value.model && value.imageModel)
    form.value = {
      ...form.value,
      providerId: value.imageProvider || "",
      model: value.imageModel,
    };
  resolveDefaults();
}
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <img :src="site.icon || '/Bimage.png'" :alt="t('站点图标')" />
        <div class="sidebar-tools">
          <button
            v-if="isAdmin"
            ref="versionTrigger"
            type="button"
            class="version-pill"
            :class="{ 'has-update': versionSnapshot?.hasUpdate, open: versionOpen }"
            :aria-label="t('版本信息')"
            aria-haspopup="dialog"
            :aria-expanded="versionOpen"
            :title="versionSnapshot?.hasUpdate && versionSnapshot.latest ? t('发现新版本 {tag}', { tag: versionSnapshot.latest.tag }) : t('查看版本与更新')"
            @click="versionOpen = !versionOpen"
          >
            <span>v{{ displayVersion }}</span>
            <span v-if="versionSnapshot?.hasUpdate" class="version-dot" aria-hidden="true" />
          </button>
          <span v-else class="version-pill version-pill-static">v{{ appVersion }}</span>
          <div class="appearance-controls">
            <LanguageSwitch />
            <button type="button" class="icon-button theme-toggle" :aria-label="t('切换主题')" :title="t('切换浅色 / 暗色')" @click="emit('theme')">
              <Moon v-if="theme === 'light'" :size="18" aria-hidden="true" /><Sun v-else :size="18" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      <nav :aria-label="t('主导航')">
        <button
          type="button"
          :aria-label="t('Agent 创作')"
          :aria-current="page === 'agent' ? 'page' : undefined"
          :class="{ selected: page === 'agent' }"
          @click="page = 'agent'"
        >
          <Sparkles :size="18" /><span>{{ t('Agent 创作') }}</span>
        </button>
        <button
          type="button"
          :aria-label="t('图像工作台')"
          :aria-current="page === 'studio' ? 'page' : undefined"
          :class="{ selected: page === 'studio' }"
          @click="page = 'studio'"
        >
          <WandSparkles :size="18" /><span>{{ t('图像工作台') }}</span>
        </button>
        <button
          type="button"
          :aria-label="t('收藏夹')"
          :aria-current="page === 'favorites' ? 'page' : undefined"
          :class="{ selected: page === 'favorites' }"
          @click="page = 'favorites'"
        >
          <Star :size="18" /><span>{{ t('收藏夹') }}</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button
          v-if="identity.role === 'admin'"
          type="button"
          :aria-label="t('用户管理')"
          :aria-current="page === 'users' ? 'page' : undefined"
          :class="{ selected: page === 'users' }"
          @click="page = 'users'"
        >
          <UsersRound :size="18" /><span>{{ t('用户管理') }}</span>
        </button>
        <button
          type="button"
          :aria-label="t('系统设置')"
          :aria-current="page === 'settings' ? 'page' : undefined"
          :class="{ selected: page === 'settings' }"
          @click="page = 'settings'"
        >
          <SettingsIcon :size="18" /><span>{{ t('系统设置') }}</span></button
        ><button :aria-label="t('退出登录')" @click="emit('logout')">
          <LogOut :size="18" /><span>{{ t('退出登录') }}</span>
        </button>
      </div>
    </aside>
    <main class="main-content">
      <header class="page-header">
        <Transition :name="pageTransition" mode="out-in">
          <div :key="page" class="page-header-copy">
            <h1>{{ pageTitle }}</h1>
            <span class="page-context">{{ pageContext }}</span>
          </div>
        </Transition>
      </header>
      <ToastNotice :notice="translatedNotice" @close="notice = null" @settings="page = 'settings'; notice = null" />
      <Transition :name="pageTransition" mode="out-in" @after-leave="onPageAfterLeave">
        <UserManagement v-if="page === 'users' && identity.role === 'admin'" key="users" :api="api" @created="notify('用户已创建。', 'success')" />
        <FavoritesView
          v-else-if="page === 'favorites'"
          key="favorites"
          :favorites="favorites"
          :loading="favoritesLoading || loading"
          :signal="signal"
          :run="run"
          @unfavorite="unfavorite"
          @use-as-reference="addAsReference"
          @restore="restoreFromForm"
          @go-studio="page = 'studio'"
        />
        <div v-else-if="loading" key="loading" class="loading-layout" :aria-label="t('载入工作台')">
          <div />
          <div />
        </div>
        <AgentView
          v-else-if="page === 'agent'"
          key="agent"
          :providers="available"
          :settings="settings"
          :form="form"
          :favorite-assets="favoriteAssets"
          :api="api"
          :signal="signal"
          :run="run"
          @update:settings="patchSettings"
          @restore-form="restorePartialForm"
          @toggle-favorite="(payload) => toggleFavorite(payload.jobId, payload.taskId, payload.asset)"
          @jobs-changed="void refreshHistory()"
          @go-settings="page = 'settings'"
          @notify="(message, type) => notify(message, type)"
        />
        <div v-else-if="page === 'studio'" key="studio" class="workspace">
        <Composer
          :form="form"
          :providers="available"
          :signal="signal"
          :api="api"
          :run="run"
          :busy="busy"
          :settings="settings"
          @update:form="change"
          @generate="generate"
          @quick="quick = true"
        />
        <section class="history" :class="{ 'history-searching': searching }">
          <div class="section-head history-head">
            <div class="history-heading">
              <h2 ref="historyHeading" tabindex="-1">{{ t('任务记录') }}</h2>
              <span class="history-count" role="status">{{ historyTotal === 1 ? t('1 个记录') : t('{count} 个记录', { count: historyTotal }) }}</span>
            </div>
            <div class="history-search"><Search :size="15" aria-hidden="true" /><input v-model="historyQuery" type="search" :aria-label="t('搜索任务提示词')" :placeholder="t('搜索提示词')" @keydown.escape="historyQuery = ''" /><button v-if="historyQuery" type="button" class="icon-button" :aria-label="t('清除搜索')" @click="historyQuery = ''"><X :size="14" /></button></div>
          </div>

          <div v-if="!jobs.length && !historyQuery && !searching" class="empty-history">
            <Image :size="38" :stroke-width="1.3" />
            <h3>{{ t('暂无任务记录') }}</h3>
            <p>{{ t('从一句描述开始，创作会保存在这里。') }}</p>
            <button v-if="!available.length" @click="page = 'settings'">
              {{ t('去配置供应商') }}<ArrowUpRight :size="15" />
            </button>
          </div>
          <div v-else-if="!jobs.length && !searching" class="empty-history"><Search :size="32" /><h3>{{ t('没有匹配的任务') }}</h3><p>{{ t('试试其他提示词，或清除搜索查看全部记录。') }}</p><button type="button" @click="historyQuery = ''">{{ t('清除搜索') }}</button></div>
          <JobCard
            v-for="job in jobs"
            :key="job.id"
            :job="job"
            :api="api"
            :signal="signal"
            :run="run"
            :cancelling="cancellingJobs.has(job.id)"
            :remove="removeJob"
            :favorite-assets="favoriteAssets"
            @cancel="cancelQueued(job.id)"
            @restore="restore(job)"
            @repair="(result) => repair(job, result)"
            @use-as-reference="addAsReference"
            @toggle-favorite="toggleFavorite"
          />
          <button v-if="hasMore" type="button" class="history-load-more" :disabled="loadingMore" @click="run(history.loadMore)">{{ t(loadingMore ? '加载中…' : '加载更多') }}</button>
        </section>
      </div>
        <SettingsPanel
          v-else
          key="settings"
          :signal="signal"
          :providers="providers"
          :settings="settings"
          :site="site"
          :identity="identity"
          :api="api"
          :run="run"
          @refresh="run(refresh)"
          @settings="defaultsSaved"
          @site="(s) => emit('site', s)"
          @cleared="notify('图片缓存已清除', 'success')"
        />
      </Transition><QuickPrompt
        v-if="quick"
        :form="form"
        :settings="settings"
        :api="api"
        :signal="signal"
        :run="run"
        @close="quick = false"
        @apply="(prompt, references) => change({ ...form, prompt, references })"
      /><VersionModal
        v-if="isAdmin && versionOpen"
        :api="api"
        :signal="signal"
        :anchor="versionTrigger"
        :snapshot="versionSnapshot"
        :fallback-version="appVersion"
        @close="versionOpen = false"
        @update="(s) => (versionSnapshot = s)"
        @notice="(msg, type) => notify(msg, type)"
      />
      <Transition name="back-to-top">
        <button
          v-if="showBackToTop"
          type="button"
          class="back-to-top"
          :aria-label="t('回到顶部')"
          :title="t('回到顶部')"
          @click="scrollToTop"
        >
          <ArrowUp :size="18" aria-hidden="true" />
        </button>
      </Transition>
    </main>
  </div>
</template>
