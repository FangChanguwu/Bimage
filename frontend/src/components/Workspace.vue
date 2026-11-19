<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, toRaw, nextTick } from "vue";
import {
  WandSparkles,
  Settings as SettingsIcon,
  LogOut,
  Moon,
  Sun,
  Image,
  ArrowUpRight,
  X,
  Search,
} from "lucide-vue-next";
import Composer from "./Composer.vue";
import ToastNotice, { type Notice, type NoticeType } from './ToastNotice.vue';
import JobCard from "./JobCard.vue";
import QuickPrompt from "./QuickPrompt.vue";
import SettingsPanel from "./SettingsPanel.vue";
import { assetCache } from "../composables/assetCache";
import { emptyForm, restoreForm, jobPayload, resolveChoice } from "../domain";
import type {
  Site,
  Identity,
  Provider,
  Job,
  GenerationForm,
  Settings,
  Api,
  Run,
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
  csrf: [token: string];
}>();
const page = ref("studio"),
  providers = ref<Provider[]>([]),
  jobs = ref<Job[]>([]),
  cancellingJobs = ref(new Set<string>()),
  historyHeading = ref<HTMLElement>(),
  settings = ref<Settings>({}),
  form = ref<GenerationForm>(emptyForm()),
  notice = ref<Notice | null>(null),
  quick = ref(false),
  busy = ref(false),
  loading = ref(true);
let active = true,
  draftVersion = 0,
  historyRevision = 0,
  historyRequest = 0,
  appliedHistoryRequest = 0,
  saveTimer: ReturnType<typeof setTimeout> | undefined,
  pollTimer: ReturnType<typeof setTimeout> | undefined,
  noticeTimer: ReturnType<typeof setTimeout> | undefined,
  saveQueue = Promise.resolve();
const available = computed(() =>
  providers.value.filter((p) => p.owner === props.identity.id || p.shared),
);
const historyQuery = ref('');
const matchedJobs = computed(() => {
  const query = historyQuery.value.toLocaleLowerCase();
  return query ? jobs.value.filter(job => job.form.prompt.toLocaleLowerCase().includes(query)) : jobs.value;
});
function notify(message: string, type: NoticeType, options: Pick<Notice, 'action' | 'shape'> = {}) {
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
function replaceHistory(next: Job[]) {
  const ids = new Set(next.map(job => job.id));
  const missing = jobs.value.filter(job => !ids.has(job.id));
  if (missing.length) {
    // Other tabs/devices discover removals on poll. Evict the old previews
    // unless the asset is still displayed by another record or local draft.
    const retained = new Set(form.value.references);
    for (const job of next) {
      for (const id of job.form.references) retained.add(id);
      for (const task of job.tasks) if (task.asset) retained.add(task.asset);
    }
    const cache = assetCache(props.signal);
    for (const job of missing) {
      for (const task of job.tasks) {
        if (task.asset && !retained.has(task.asset)) cache.evict(task.asset);
      }
    }
  }
  const pending = cancellingJobs.value;
  const previous = new Map(jobs.value.filter(job => pending.has(job.id)).map(job => [job.id, job]));
  jobs.value = next.map(job => previous.get(job.id) ?? job);
}
async function refreshHistory() {
  const revision = historyRevision, request = ++historyRequest;
  const next = await props.api<Job[]>("/jobs");
  if (!active || props.signal.aborted || revision !== historyRevision || request <= appliedHistoryRequest) return;
  appliedHistoryRequest = request;
  replaceHistory(next);
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
  const text = resolveChoice(
    available.value,
    "text",
    settings.value.textProvider,
    settings.value.textModel,
  );
  settings.value = {
    ...settings.value,
    textProvider: text.providerId,
    textModel: text.model,
  };
}
async function poll() {
  if (!active) return;
  try {
    await refreshHistory();
  } catch {
  } finally {
    if (active) pollTimer = setTimeout(poll, document.hidden ? 8000 : 2200);
  }
}
onMounted(async () => {
  await run(async () => {
    const [p, j, s] = await Promise.all([
      props.api<Provider[]>("/providers"),
      props.api<Job[]>("/jobs"),
      props.api<Settings>("/settings"),
    ]);
    if (!active) return;
    providers.value = p;
    jobs.value = j;
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
  if (active) pollTimer = setTimeout(poll, 2200);
});
onBeforeUnmount(() => {
  active = false;
  clearTimeout(saveTimer);
  clearTimeout(pollTimer);
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
  [page, () => props.site.title],
  () =>
    (document.title = `${props.site.title || "Bimage"} | ${page.value === "studio" ? "图像工作台" : "设置"}`),
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
        change({ ...form.value, prompt: "", references: [] });
      await refresh();
      return true;
    });
    if (accepted && active) notify("已将请求加入队列。", 'success', { shape: 'pill' });
  } finally {
    busy.value = false;
  }
}
function restore(job: Job) {
  change(restoreForm(toRaw(job.form)));
  page.value = "studio";
  notify("完整参数和参考图已恢复；点击生成才会提交任务", 'success');
}
async function cancelQueued(id: string) {
  if (cancellingJobs.value.has(id) ||
      !jobs.value.find(job => job.id === id)?.tasks.some(task => task.status === "queued")) return;
  cancellingJobs.value.add(id);
  try {
    const result = await run(() => props.api<Job & { cancelledCount: number }>(
      "/jobs/" + encodeURIComponent(id) + "/cancel", {},
    ));
    if (!result || !active || props.signal.aborted) return;
    const { cancelledCount, ...job } = result;
    // Apply the mutation's snapshot directly; an older poll must not restore queued slots.
    historyRevision++;
    jobs.value = jobs.value.map(current => current.id === id ? job : current);
    if (cancelledCount > 0) notify(`已取消 ${cancelledCount} 项排队任务。`, "success");
    else notify("没有可取消的排队任务。", "warning");
  } finally {
    cancellingJobs.value.delete(id);
  }
}
async function removeJob(id: string) {
  const result = await run(() => props.api<{ deletedAssetIds: string[] }>(
    "/jobs/" + encodeURIComponent(id), undefined, "DELETE",
  ));
  if (!result || !active || props.signal.aborted) return;
  // Responses from polls started before deletion must not restore the card.
  historyRevision++;
  const cache = assetCache(props.signal);
  const removed = new Set(result.deletedAssetIds);
  for (const asset of removed) cache.evict(asset);
  if (form.value.references.some(asset => removed.has(asset))) {
    change({ ...form.value, references: form.value.references.filter(asset => !removed.has(asset)) });
  }
  jobs.value = jobs.value.filter(job => job.id !== id);
  await nextTick();
  if (active && !props.signal.aborted) {
    historyHeading.value?.focus({ preventScroll: true });
    notify("任务已删除。", "success");
  }
}
function repair(job: Job, id: string, prompt: string) {
  change({
    ...restoreForm(toRaw(job.form)),
    count: 1,
    prompt,
    references: [id],
  });
  notify("局部修复已回填；点击生成才会提交任务", 'success');
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
        <img :src="site.icon || '/Bimage.png'" alt="站点图标" /><button
          class="icon-button theme-toggle"
          aria-label="切换主题"
          title="切换浅色 / 暗色"
          @click="emit('theme')"
        >
          <Moon v-if="theme === 'light'" :size="18" /><Sun v-else :size="18" />
        </button>
      </div>
      <nav aria-label="主导航">
        <button
          aria-label="图像工作台"
          :class="{ selected: page === 'studio' }"
          @click="page = 'studio'"
        >
          <WandSparkles :size="18" /><span>图像工作台</span>
        </button>
      </nav>
      <div class="sidebar-bottom">
        <button
          aria-label="设置"
          :class="{ selected: page === 'settings' }"
          @click="page = 'settings'"
        >
          <SettingsIcon :size="18" /><span>设置</span></button
        ><button aria-label="退出登录" @click="emit('logout')">
          <LogOut :size="18" /><span>退出登录</span>
        </button>
      </div>
    </aside>
    <main class="main-content">
      <header class="page-header">
        <h1>{{ page === "studio" ? "图像工作台" : "设置" }}</h1>
        <span class="page-context">{{
          page === "studio" ? "让想法，成为画面。" : "连接服务，整理创作偏好。"
        }}</span>
      </header>
      <ToastNotice :notice="notice" @close="notice = null" @settings="page = 'settings'; notice = null" />
      <div v-if="loading" class="loading-layout" aria-label="载入工作台">
        <div />
        <div />
      </div>
      <div v-else-if="page === 'studio'" class="workspace">
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
        <section class="history">
          <div class="section-head history-head">
            <div class="history-heading">
              <h2 ref="historyHeading" tabindex="-1">任务记录</h2>
              <span class="history-count" role="status">{{ matchedJobs.length }} 个记录</span>
            </div>
            <div class="history-search"><Search :size="15" aria-hidden="true" /><input v-model="historyQuery" type="search" aria-label="搜索任务提示词" placeholder="搜索提示词" /><button v-if="historyQuery" type="button" class="icon-button" aria-label="清除搜索" @click="historyQuery = ''"><X :size="14" /></button></div>
          </div>

          <div v-if="!jobs.length" class="empty-history">
            <Image :size="38" :stroke-width="1.3" />
            <h3>暂无任务记录</h3>
            <p>从一句描述开始，创作会保存在这里。</p>
            <button v-if="!available.length" @click="page = 'settings'">
              去配置供应商<ArrowUpRight :size="15" />
            </button>
          </div>
          <div v-else-if="!matchedJobs.length" class="empty-history"><Search :size="32" /><h3>没有匹配的任务</h3><p>试试其他提示词，或清除搜索查看全部记录。</p><button type="button" @click="historyQuery = ''">清除搜索</button></div>
          <JobCard
            v-for="job in matchedJobs"
            :key="job.id"
            :job="job"
            :api="api"
            :signal="signal"
            :run="run"
            :cancelling="cancellingJobs.has(job.id)"
            :remove="removeJob"
            @cancel="cancelQueued(job.id)"
            @restore="restore(job)"
            @repair="(id, prompt) => repair(job, id, prompt)"
          />
        </section>
      </div>
      <SettingsPanel
        v-else
        :providers="providers"
        :settings="settings"
        :site="site"
        :identity="identity"
        :api="api"
        :run="run"
        @refresh="run(refresh)"
        @settings="defaultsSaved"
        @site="(s) => emit('site', s)"
        @csrf="(t) => emit('csrf', t)"
      /><QuickPrompt
        v-if="quick"
        :form="form"
        :settings="settings"
        :api="api"
        :signal="signal"
        :run="run"
        @close="quick = false"
        @apply="(prompt, references) => change({ ...form, prompt, references })"
      />
    </main>
  </div>
</template>
