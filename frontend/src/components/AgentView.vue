<script lang="ts">
import type { AgentDocumentRef as StoredDocument, AgentPlanItem as StoredPlanItem } from "../types";

interface SessionDraft {
  draft: string;
  attachments: string[];
  pendingDocuments: StoredDocument[];
  planDrafts: Record<string, StoredPlanItem[]>;
  revision: number;
}
const sessionDraftStore = new Map<string, SessionDraft>();
let lastSelectedSessionId = "";
let composerRevision = 0;
const draftStoreSignals = new WeakSet<AbortSignal>();
</script>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import {
  Sparkles,
  Plus,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
  ImagePlus,
  Paperclip,
  FileText,
  Send,
  Square,
  Check,
  X,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  LoaderCircle,
  Star,
  Download,
  ArrowUpRight,
  SlidersHorizontal,
  ChevronDown,
  Zap,
  Brain,
  ShieldCheck,
  WandSparkles,
  Copy,
} from "lucide-vue-next";
import ModelSelect from "./ModelSelect.vue";
import AssetImage from "./AssetImage.vue";
import Lightbox from "./Lightbox.vue";
import Modal from "./Modal.vue";
import { useReferences } from "../composables/useReferences";
import { resolveTextDefaults } from "../composables/textDefaults";
import { copyImage, download, extensionForMime } from "../composables/assetCache";
import { t, formatDate } from "../i18n";
import type {
  AgentBatchCard,
  AgentBatchItemView,
  AgentCard,
  AgentDeliverablesCard,
  AgentDocumentRef,
  AgentMessage,
  AgentPlanCard,
  AgentPlanItem,
  AgentRun,
  AgentSession,
  AgentSessionConfig,
  AgentSessionDetail,
  Api,
  ApprovalMode,
  GenerationForm,
  Provider,
  Run,
  Settings,
  SpeedTier,
  ThinkingEffort,
} from "../types";

const props = defineProps<{
  providers: Provider[];
  settings: Settings;
  form: GenerationForm;
  favoriteAssets: Set<string>;
  api: Api;
  signal: AbortSignal;
  run: Run;
}>();

const emit = defineEmits<{
  "update:settings": [patch: Partial<Settings>];
  "restore-form": [form: Partial<GenerationForm>];
  "toggle-favorite": [
    payload: {
      asset: string;
      jobId: string;
      taskId: string;
      form: GenerationForm;
      jobCreated: string;
    },
  ];
  "jobs-changed": [];
  "go-settings": [];
  notify: [message: string, type: "success" | "error" | "warning"];
}>();

const sessions = ref<AgentSession[]>([]);
const currentSessionId = ref<string>("");
const messages = ref<AgentMessage[]>([]);
const activeRun = ref<AgentRun | null>(null);
const loadingSessions = ref(true);
const loadingDetail = ref(false);
const detailError = ref("");
const controlsBlocked = computed(() => loadingSessions.value || loadingDetail.value || !!detailError.value);
const sseState = ref<"idle" | "connecting" | "open" | "reconnecting" | "disconnected">("idle");
const isNearBottom = ref(true);
const hasUnreadOutput = ref(false);
const sending = ref(false);
const approving = ref(false);
const sidebarOpen = ref(true);
const optionsOpen = ref(false);
const deleteTarget = ref<AgentSession | null>(null);

const draft = ref("");
const attachments = ref<string[]>([]);
const pendingDocuments = ref<AgentDocumentRef[]>([]);
const uploadingDocs = ref(false);
const MAX_DOCX_BYTES = 20 * 1024 * 1024;
const MAX_AGENT_DOCUMENTS = 4;
let queuedDocuments = 0;
let documentUploadQueue = Promise.resolve();
const dragging = ref(false);
let dragDepth = 0;

const fileInput = ref<HTMLInputElement>();
const textareaRef = ref<HTMLTextAreaElement>();
const threadRef = ref<HTMLElement>();

const lightboxItems = ref<Array<{ asset: string; mime?: string }>>([]);
const lightboxIndex = ref<number | null>(null);

// Editable plan drafts keyed by plan card id
const planDrafts = ref<Record<string, AgentPlanItem[]>>({});
let draftRevision = ++composerRevision;
let restoringDraft = false;

function saveSessionDraft(id = currentSessionId.value) {
  if (props.signal.aborted) return;
  sessionDraftStore.set(id, {
    draft: draft.value,
    attachments: [...attachments.value],
    pendingDocuments: JSON.parse(JSON.stringify(pendingDocuments.value)),
    planDrafts: JSON.parse(JSON.stringify(planDrafts.value)),
    revision: draftRevision,
  });
}

function restoreSessionDraft(id: string) {
  const saved = sessionDraftStore.get(id);
  restoringDraft = true;
  draft.value = saved?.draft ?? "";
  attachments.value = [...(saved?.attachments ?? [])];
  pendingDocuments.value = JSON.parse(JSON.stringify(saved?.pendingDocuments ?? []));
  planDrafts.value = JSON.parse(JSON.stringify(saved?.planDrafts ?? {}));
  draftRevision = saved?.revision ?? ++composerRevision;
  restoringDraft = false;
  resizeTextarea();
}

watch([draft, attachments, pendingDocuments], () => {
  if (restoringDraft) return;
  draftRevision = ++composerRevision;
  saveSessionDraft();
}, { deep: true, flush: "sync" });
watch(planDrafts, () => {
  if (!restoringDraft) saveSessionDraft();
}, { deep: true, flush: "sync" });

if (!draftStoreSignals.has(props.signal)) {
  draftStoreSignals.add(props.signal);
  props.signal.addEventListener("abort", () => {
    sessionDraftStore.clear();
    lastSelectedSessionId = "";
  }, { once: true });
}

function onAccountAbort() {
  closeEvents();
  stopReconciliation();
  clearTimeout(configSyncTimer);
  pendingConfigSave = undefined;
}
props.signal.addEventListener("abort", onAccountAbort, { once: true });

const textDefaults = computed(() =>
  resolveTextDefaults(props.providers, props.settings),
);

function buildDefaultConfig(): AgentSessionConfig {
  return {
    textProviderId:
      textDefaults.value.agentProvider ||
      textDefaults.value.textProvider ||
      "",
    textModel:
      textDefaults.value.agentModel || textDefaults.value.textModel || "",
    imageProviderId:
      props.form.providerId || props.settings.imageProvider || "",
    imageModel: props.form.model || props.settings.imageModel || "",
    thinkingEffort: props.settings.agentThinkingEffort || "medium",
    speed: props.settings.agentSpeed || "normal",
    approvalMode: props.settings.agentApprovalMode || "confirm",
    autoInspect: props.settings.agentAutoInspect ?? true,
    budgetImages: props.settings.agentBudgetImages ?? 8,
    maxRetries: props.settings.agentMaxRetries ?? 2,
    defaultAutoSize: props.form.autoSize ?? true,
    defaultSize: props.form.size || "1024x1024",
    defaultQuality: props.form.quality || "auto",
    defaultOutputFormat: props.form.output_format || "png",
  };
}

const config = ref<AgentSessionConfig>(buildDefaultConfig());

const isRunning = computed(() => activeRun.value?.status === "running");
const isWaitingApproval = computed(
  () => activeRun.value?.status === "waiting_approval",
);
const isRunActive = computed(() => isRunning.value || isWaitingApproval.value);
const remainingBudget = computed(() => Math.max(0,
  (activeRun.value?.budgetImages ?? config.value.budgetImages) - (activeRun.value?.usedImages ?? 0),
));
const plannedTotalImages = computed(() => messages.value.reduce((total, msg) =>
  total + msg.cards.reduce((sum, card) => sum + (card.type === "plan" && card.status === "pending"
    ? planTotalImages(card) : 0), 0), 0));
const hasProviders = computed(() => props.providers.length > 0);
const canSend = computed(
  () =>
    !sending.value &&
    !controlsBlocked.value &&
    !isRunning.value &&
    !refs.pending.value &&
    !uploadingDocs.value &&
    (draft.value.trim().length > 0 ||
      attachments.value.length > 0 ||
      pendingDocuments.value.length > 0),
);

const refs = useReferences(
  () => attachments.value,
  (ids) => {
    attachments.value = ids;
  },
  props.api,
  props.signal,
);

let eventSource: EventSource | null = null;
let configSyncTimer: ReturnType<typeof setTimeout> | undefined;
let pendingConfigSave: { sid: string; configSnapshot: AgentSessionConfig } | undefined;
let configSaveQueue = Promise.resolve();
const localConfigs = new Map<string, AgentSessionConfig>();
let selectionRevision = 0;
let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
let reconcileAttempts = 0;
const reconciliationExpired = ref(false);
let mounted = true;

function closeEvents() {
  sseState.value = "idle";
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function scrollToBottom(smooth = false, force = false) {
  if (!force && !isNearBottom.value) {
    hasUnreadOutput.value = true;
    return;
  }
  isNearBottom.value = true;
  hasUnreadOutput.value = false;
  void nextTick(() => {
    const el = threadRef.value;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "instant",
    });
  });
}

function onThreadScroll() {
  const el = threadRef.value;
  if (!el) return;
  isNearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (isNearBottom.value) hasUnreadOutput.value = false;
}

function hasActiveBatchTasks() {
  return messages.value.some((msg) => msg.cards.some((card) => card.type === "batch" &&
    card.items.some((item) => item.tasks.some((task) => task.status === "queued" || task.status === "running"))));
}

function stopReconciliation() {
  clearTimeout(reconcileTimer);
  reconcileTimer = undefined;
  reconcileAttempts = 0;
  reconciliationExpired.value = false;
}

function scheduleReconciliation() {
  if (reconcileTimer || !mounted || props.signal.aborted) return;
  if (activeRun.value?.status !== "cancelled" || !hasActiveBatchTasks()) return;
  if (reconcileAttempts >= 100) {
    reconciliationExpired.value = true;
    return;
  }
  const sid = currentSessionId.value;
  reconcileTimer = setTimeout(async () => {
    reconcileTimer = undefined;
    if (!mounted || currentSessionId.value !== sid) return;
    reconcileAttempts++;
    await refreshSessionDetail(sid);
    if (mounted && currentSessionId.value === sid) scheduleReconciliation();
  }, 3000);
}

function applySessionDetail(detail: AgentSessionDetail, includeConfig = false) {
  messages.value = detail.messages;
  activeRun.value = detail.run;
  syncPlanDraftsFromMessages(detail.messages);
  if (includeConfig) config.value = mergeSessionConfigWithDefaults(
    localConfigs.get(detail.session.id) ?? detail.session.config,
  );
  if (!hasActiveBatchTasks()) reconciliationExpired.value = false;
  scheduleReconciliation();
}

async function refreshSessionDetail(sid = currentSessionId.value) {
  const revision = selectionRevision;
  try {
    const detail = await props.api<AgentSessionDetail>(
      `/agent/sessions/${encodeURIComponent(sid)}`, undefined, "GET", props.signal,
    );
    if (!mounted || currentSessionId.value !== sid || revision !== selectionRevision) return;
    applySessionDetail(detail);
  } catch (error) {
    if (mounted && !props.signal.aborted && currentSessionId.value === sid) {
      emit("notify", t("刷新对话状态失败：{error}", { error: String(error) }), "error");
    }
  }
}

async function reconnectSession() {
  if (controlsBlocked.value || !currentSessionId.value) return;
  stopReconciliation();
  connectEvents(currentSessionId.value);
  await refreshSessionDetail();
}

function syncPlanDraftsFromMessages(list: AgentMessage[]) {
  for (const msg of list) {
    for (const card of msg.cards) {
      if (card.type === "plan" && card.status === "pending") {
        if (!planDrafts.value[card.id]) {
          planDrafts.value[card.id] = JSON.parse(
            JSON.stringify(card.items),
          ) as AgentPlanItem[];
        }
      }
    }
  }
}

function upsertMessage(incoming: AgentMessage) {
  const idx = messages.value.findIndex((m) => m.id === incoming.id);
  if (idx === -1) {
    messages.value.push(incoming);
  } else {
    messages.value[idx] = incoming;
  }
  syncPlanDraftsFromMessages([incoming]);
  scrollToBottom();
}

function upsertCard(messageId: string, card: AgentCard) {
  const msg = messages.value.find((m) => m.id === messageId);
  if (!msg) return;
  const idx = msg.cards.findIndex((c) => c.id === card.id);
  if (idx === -1) {
    msg.cards.push(card);
  } else {
    msg.cards[idx] = card;
  }
  if (card.type === "plan" && card.status === "pending" && !planDrafts.value[card.id]) {
    planDrafts.value[card.id] = JSON.parse(
      JSON.stringify(card.items),
    ) as AgentPlanItem[];
  }
  if (card.type === "batch") {
    emit("jobs-changed");
  }
  scrollToBottom();
}

function connectEvents(sessionId: string) {
  closeEvents();
  if (!sessionId) return;
  const es = new EventSource(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/events`,
  );
  eventSource = es;
  sseState.value = "connecting";
  let opened = false;
  es.onopen = () => {
    if (eventSource !== es || currentSessionId.value !== sessionId) return;
    const reconnecting = opened || sseState.value === "reconnecting";
    opened = true;
    sseState.value = "open";
    if (reconnecting) void refreshSessionDetail(sessionId);
  };
  es.onerror = (ev) => {
    if (eventSource !== es || currentSessionId.value !== sessionId || "data" in ev) return;
    sseState.value = es.readyState === EventSource.CLOSED ? "disconnected" : "reconnecting";
  };

  es.addEventListener("snapshot", (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as AgentSessionDetail;
      if (eventSource !== es || data.session.id !== currentSessionId.value) return;
      applySessionDetail(data);
      scrollToBottom();
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("message", (ev) => {
    if (eventSource !== es || currentSessionId.value !== sessionId) return;
    try {
      const msg = JSON.parse((ev as MessageEvent).data) as AgentMessage;
      if (msg.sessionId !== currentSessionId.value) return;
      upsertMessage(msg);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("delta", (ev) => {
    if (eventSource !== es || currentSessionId.value !== sessionId) return;
    try {
      const { messageId, delta } = JSON.parse(
        (ev as MessageEvent).data,
      ) as { messageId: string; delta: string };
      const msg = messages.value.find((m) => m.id === messageId);
      if (msg && delta) {
        msg.content += delta;
        scrollToBottom();
      }
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("reasoning_delta", (ev) => {
    if (eventSource !== es || currentSessionId.value !== sessionId) return;
    try {
      const { messageId, delta } = JSON.parse(
        (ev as MessageEvent).data,
      ) as { messageId: string; delta: string };
      const msg = messages.value.find((m) => m.id === messageId);
      if (msg && delta) {
        msg.reasoning += delta;
        scrollToBottom();
      }
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("card", (ev) => {
    if (eventSource !== es || currentSessionId.value !== sessionId) return;
    try {
      const { messageId, card } = JSON.parse(
        (ev as MessageEvent).data,
      ) as { messageId: string; card: AgentCard };
      upsertCard(messageId, card);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("run", (ev) => {
    if (eventSource !== es || currentSessionId.value !== sessionId) return;
    try {
      const run = JSON.parse((ev as MessageEvent).data) as AgentRun;
      if (run.sessionId !== currentSessionId.value) return;
      activeRun.value = run;
      scheduleReconciliation();
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("done", () => {
    if (eventSource !== es || currentSessionId.value !== sessionId) return;
    void refreshSessionDetail(sessionId);
    emit("jobs-changed");
    void loadSessionsList(false);
  });

  es.addEventListener("warning", (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as { warning?: string };
      if (data.warning) emit("notify", data.warning, "warning");
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("error", (ev) => {
    if ("data" in ev && typeof (ev as MessageEvent).data === "string") {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { error?: string };
        if (data.error) emit("notify", data.error, "error");
      } catch {
        /* ignore */
      }
    }
  });
}

function mergeSessionConfigWithDefaults(
  raw: AgentSessionConfig,
): AgentSessionConfig {
  const def = buildDefaultConfig();
  return {
    ...def,
    ...raw,
    textProviderId: raw.textProviderId || def.textProviderId,
    textModel: raw.textModel || def.textModel,
    imageProviderId: raw.imageProviderId || def.imageProviderId,
    imageModel: raw.imageModel || def.imageModel,
  };
}

async function loadSessionsList(selectFirst = true) {
  try {
    const list = await props.api<AgentSession[]>(
      "/agent/sessions",
      undefined,
      "GET",
      props.signal,
    );
    if (!mounted) return;
    sessions.value = list;
    if (selectFirst) {
      if (list.length) {
        const restored = list.find((item) => item.id === lastSelectedSessionId);
        await selectSession(restored?.id ?? list[0].id);
      } else {
        currentSessionId.value = "";
        messages.value = [];
        activeRun.value = null;
        config.value = buildDefaultConfig();
        closeEvents();
        lastSelectedSessionId = "";
        restoreSessionDraft("");
      }
    }
  } finally {
    if (mounted) loadingSessions.value = false;
  }
}

async function selectSession(id: string) {
  if (currentSessionId.value === id && (loadingDetail.value || (eventSource && !detailError.value))) return;
  saveSessionDraft();
  closeEvents();
  stopReconciliation();
  refs.invalidate();
  const outgoingSave = flushConfigSave();
  const revision = ++selectionRevision;
  currentSessionId.value = id;
  lastSelectedSessionId = id;
  loadingDetail.value = true;
  detailError.value = "";
  messages.value = [];
  activeRun.value = null;
  lightboxIndex.value = null;
  restoreSessionDraft(id);
  try {
    await outgoingSave;
    if (!mounted || selectionRevision !== revision) return;
    const detail = await props.api<AgentSessionDetail>(
      `/agent/sessions/${encodeURIComponent(id)}`, undefined, "GET", props.signal,
    );
    if (!mounted || currentSessionId.value !== id || selectionRevision !== revision) return;
    applySessionDetail(detail, true);
    connectEvents(id);
    scrollToBottom(false, true);
  } catch (error) {
    if (mounted && currentSessionId.value === id && selectionRevision === revision && !props.signal.aborted) {
      detailError.value = t("加载对话失败：{error}", { error: String(error) });
    }
  } finally {
    if (mounted && selectionRevision === revision) loadingDetail.value = false;
  }
}

async function createNewSession(preserveComposer = false): Promise<AgentSession | undefined> {
  if (controlsBlocked.value) return;
  saveSessionDraft();
  const originId = currentSessionId.value;
  const revision = selectionRevision;
  const configSnapshot = { ...config.value };
  const created = await props.run(() =>
    props.api<AgentSession>(
      "/agent/sessions",
      { config: configSnapshot },
      "POST",
      props.signal,
    ),
  );
  if (!created || !mounted) return;
  sessions.value = [created, ...sessions.value.filter((s) => s.id !== created.id)];
  if (preserveComposer) {
    const saved = sessionDraftStore.get(originId);
    if (saved) sessionDraftStore.set(created.id, { ...saved, planDrafts: {} });
  }
  if (currentSessionId.value === originId && selectionRevision === revision) {
    await selectSession(created.id);
    nextTick(() => textareaRef.value?.focus());
  }
  return created;
}

const deleteHasActiveRun = ref(false);
let deleteRequestRevision = 0;
async function requestDeleteSession(item: AgentSession) {
  const revision = ++deleteRequestRevision;
  const detail = await props.run(() => props.api<AgentSessionDetail>(
    `/agent/sessions/${encodeURIComponent(item.id)}`, undefined, "GET", props.signal,
  ));
  if (!detail || !mounted || revision !== deleteRequestRevision) return;
  deleteHasActiveRun.value = detail.run?.status === "running" || detail.run?.status === "waiting_approval";
  deleteTarget.value = item;
}

async function confirmDeleteSession() {
  const target = deleteTarget.value;
  if (!target) return;
  deleteTarget.value = null;
  await props.run(async () => {
    await flushConfigSave();
    await props.api(
      `/agent/sessions/${encodeURIComponent(target.id)}`,
      undefined,
      "DELETE",
      props.signal,
    );
    sessions.value = sessions.value.filter((s) => s.id !== target.id);
    sessionDraftStore.delete(target.id);
    localConfigs.delete(target.id);
    if (currentSessionId.value === target.id) {
      closeEvents();
      stopReconciliation();
      selectionRevision++;
      currentSessionId.value = "";
      lastSelectedSessionId = "";
      restoreSessionDraft("");
      detailError.value = "";
      loadingDetail.value = false;
      if (sessions.value.length) {
        await selectSession(sessions.value[0].id);
      } else {
        currentSessionId.value = "";
        messages.value = [];
        activeRun.value = null;
      }
    }
  });
}

function updateConfig<K extends keyof AgentSessionConfig>(
  key: K,
  value: AgentSessionConfig[K],
) {
  if (controlsBlocked.value) return;
  config.value = { ...config.value, [key]: value };
  // Persist user preferences into Settings
  const settingsPatch: Partial<Settings> = {};
  if (key === "textProviderId") settingsPatch.agentProvider = String(value);
  if (key === "textModel") settingsPatch.agentModel = String(value);
  if (key === "thinkingEffort")
    settingsPatch.agentThinkingEffort = value as ThinkingEffort;
  if (key === "speed") settingsPatch.agentSpeed = value as SpeedTier;
  if (key === "approvalMode")
    settingsPatch.agentApprovalMode = value as ApprovalMode;
  if (key === "autoInspect") settingsPatch.agentAutoInspect = Boolean(value);
  if (key === "budgetImages") settingsPatch.agentBudgetImages = Number(value);
  if (key === "maxRetries") settingsPatch.agentMaxRetries = Number(value);
  if (Object.keys(settingsPatch).length) {
    emit("update:settings", settingsPatch);
  }
  syncConfigToSession();
}

function onTextModelChange(providerId: string, model: string) {
  if (controlsBlocked.value) return;
  config.value = {
    ...config.value,
    textProviderId: providerId,
    textModel: model,
  };
  emit("update:settings", { agentProvider: providerId, agentModel: model });
  syncConfigToSession();
}

function onImageModelChange(providerId: string, model: string) {
  if (controlsBlocked.value) return;
  config.value = {
    ...config.value,
    imageProviderId: providerId,
    imageModel: model,
  };
  for (const msg of messages.value) {
    for (const card of msg.cards) {
      if (card.type !== "plan" || card.status !== "pending") continue;
      for (const item of getPlanItems(card)) {
        item.providerId = providerId;
        item.model = model;
      }
    }
  }
  syncConfigToSession();
}

function flushConfigSave(): Promise<void> {
  clearTimeout(configSyncTimer);
  configSyncTimer = undefined;
  const pending = pendingConfigSave;
  pendingConfigSave = undefined;
  if (pending) {
    configSaveQueue = configSaveQueue.then(async () => {
      try {
        await props.api(`/agent/sessions/${encodeURIComponent(pending.sid)}`,
          { config: pending.configSnapshot }, "PATCH", props.signal);
      } catch (error) {
        if (!props.signal.aborted) emit("notify", t("保存对话设置失败：{error}", { error: String(error) }), "error");
      }
    });
  }
  return configSaveQueue;
}

function syncConfigToSession() {
  if (!currentSessionId.value || controlsBlocked.value) return;
  const sid = currentSessionId.value;
  const configSnapshot = { ...config.value };
  localConfigs.set(sid, configSnapshot);
  if (pendingConfigSave && pendingConfigSave.sid !== sid) void flushConfigSave();
  clearTimeout(configSyncTimer);
  pendingConfigSave = { sid, configSnapshot };
  configSyncTimer = setTimeout(() => { void flushConfigSave(); }, 250);
}

async function sendMessage(overrideText?: string) {
  const text = (overrideText ?? draft.value).trim();
  const attached = overrideText ? [] : [...attachments.value];
  const documents = overrideText ? [] : pendingDocuments.value.map((doc) => doc.id);
  if (!text && !attached.length && !documents.length) return;
  if (controlsBlocked.value || sending.value || isRunning.value || refs.pending.value || uploadingDocs.value) return;

  if (!config.value.textProviderId || !config.value.textModel) {
    emit("notify", "请先在顶部选择一个对话文本模型", "warning");
    return;
  }

  const capturedRevision = draftRevision;
  const originComposerId = currentSessionId.value;
  const configSnapshot = { ...config.value };
  let targetSessionId = currentSessionId.value;
  scrollToBottom(false, true);
  sending.value = true;
  try {
    if (!targetSessionId) {
      const created = await createNewSession(true);
      if (!created) return;
      targetSessionId = created.id;
    }
    await flushConfigSave();
    const res = await props.run(() =>
      props.api<{ session: AgentSession; message: AgentMessage; run: AgentRun }>(
        `/agent/sessions/${encodeURIComponent(targetSessionId)}/messages`,
        {
          content: text,
          attachments: attached,
          documents,
          config: configSnapshot,
        },
        "POST",
        props.signal,
      ),
    );
    if (!res || props.signal.aborted) return;
    if (!originComposerId && sessionDraftStore.get("")?.revision === capturedRevision) {
      sessionDraftStore.delete("");
    }
    if (!overrideText) {
      if (mounted && currentSessionId.value === targetSessionId && draftRevision === capturedRevision) {
        draft.value = "";
        attachments.value = [];
        pendingDocuments.value = [];
        refs.invalidate();
        resizeTextarea();
      } else {
        const saved = sessionDraftStore.get(targetSessionId);
        if (saved?.revision === capturedRevision) {
          sessionDraftStore.set(targetSessionId, {
            ...saved, draft: "", attachments: [], pendingDocuments: [], revision: ++composerRevision,
          });
        }
      }
    }
    if (!mounted) return;
    const idx = sessions.value.findIndex((s) => s.id === res.session.id);
    if (idx !== -1) {
      sessions.value[idx] = res.session;
    } else {
      sessions.value.unshift(res.session);
    }
    if (currentSessionId.value === targetSessionId) {
      upsertMessage(res.message);
      if (!activeRun.value || activeRun.value.id !== res.run.id) activeRun.value = res.run;
      if (!eventSource) connectEvents(targetSessionId);
      scrollToBottom(false, true);
    }
  } finally {
    if (mounted) sending.value = false;
  }
}

function planBlockingReason(card: AgentPlanCard): string {
  const items = getPlanItems(card);
  if (!items.length || items.some((item) => !item.prompt.trim())) return t("请先填写所有组的提示词");
  if (plannedTotalImages.value > remainingBudget.value) return t("计划总张数超出本轮剩余预算");
  return "";
}

function canApprovePlan(card: AgentPlanCard): boolean {
  return !controlsBlocked.value && !planBlockingReason(card);
}

function planExecutionModel(item: AgentPlanItem) {
  const providerId = item.providerId || config.value.imageProviderId;
  const provider = props.providers.find((entry) => entry.id === providerId);
  return `${provider?.name || providerId} / ${item.model || config.value.imageModel}`;
}

async function handleApprove(card: AgentPlanCard, approved: boolean) {
  if (controlsBlocked.value || !currentSessionId.value || approving.value) return;
  if (approved && !canApprovePlan(card)) return;
  const editedItems = planDrafts.value[card.id] ?? card.items;
  const sid = currentSessionId.value;
  const revision = selectionRevision;
  await flushConfigSave();
  if (!mounted || currentSessionId.value !== sid || selectionRevision !== revision || controlsBlocked.value) return;
  approving.value = true;
  try {
    await props.run(() =>
      props.api(
        `/agent/sessions/${encodeURIComponent(sid)}/approve`,
        {
          runId: card.runId,
          approved,
          items: approved ? editedItems : undefined,
        },
        "POST",
        props.signal,
      ),
    );
  } finally {
    if (mounted) approving.value = false;
  }
}

async function stopRun() {
  if (controlsBlocked.value || !currentSessionId.value) return;
  const sid = currentSessionId.value;
  await props.run(async () => {
    await props.api(`/agent/sessions/${encodeURIComponent(sid)}/stop`, {}, "POST", props.signal);
    if (mounted && currentSessionId.value === sid) {
      stopReconciliation();
      await refreshSessionDetail(sid);
    }
  }, t("运行已停止：排队任务已取消，已开始的生图任务可能仍会在后台完成。"));
}

function getPlanItems(card: AgentPlanCard): AgentPlanItem[] {
  return card.status === "pending" && planDrafts.value[card.id]
    ? planDrafts.value[card.id]
    : card.items;
}

function planTotalImages(card: AgentPlanCard): number {
  return getPlanItems(card).reduce((sum, item) => sum + (item.count || 1), 0);
}

function adjustPlanCount(cardId: string, index: number, delta: number) {
  const list = planDrafts.value[cardId];
  if (!list || !list[index]) return;
  if (delta > 0 && plannedTotalImages.value >= remainingBudget.value) return;
  const next = Math.max(1, Math.min(8, (list[index].count || 1) + delta));
  list[index].count = next;
}

function removePlanItem(cardId: string, index: number) {
  const list = planDrafts.value[cardId];
  if (!list) return;
  if (list.length <= 1) {
    emit("notify", "计划至少保留一组", "warning");
    return;
  }
  list.splice(index, 1);
  emit("notify", "已移除该组", "success");
}

function onTextareaKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (canSend.value) void sendMessage();
  }
}

function resizeTextarea() {
  void nextTick(() => {
    const el = textareaRef.value;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(180, Math.max(44, el.scrollHeight)) + "px";
  });
}

function isDocxFile(file: File): boolean {
  return (
    file.name.toLowerCase().endsWith(".docx") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    reader.readAsDataURL(file);
  });
}

async function uploadDocuments(files: File[]) {
  const targetSessionId = currentSessionId.value;
  const available = Math.max(
    0,
    MAX_AGENT_DOCUMENTS - pendingDocuments.value.length - queuedDocuments,
  );
  if (files.length > available) {
    emit("notify", t("单次最多附带 {count} 个文档", { count: MAX_AGENT_DOCUMENTS }), "warning");
    files = files.slice(0, available);
  }
  if (!files.length) return;
  queuedDocuments += files.length;
  uploadingDocs.value = true;
  let remaining = files.length;
  documentUploadQueue = documentUploadQueue.then(async () => {
    try {
      for (const file of files) {
        if (!mounted || props.signal.aborted) break;
        if (file.size > MAX_DOCX_BYTES) {
          emit("notify", t("文档大小不能超过 20MB"), "warning");
          queuedDocuments--;
          remaining--;
          continue;
        }
        const doc = await props.run(async () => {
          const data = await fileToBase64(file);
          return props.api<AgentDocumentRef>(
            "/agent/documents",
            { name: file.name, data },
            "POST",
            props.signal,
          );
        });
        queuedDocuments--;
        remaining--;
        if (!mounted || props.signal.aborted) break;
        if (!doc) continue;
        if (currentSessionId.value === targetSessionId) {
          pendingDocuments.value.push(doc);
        } else {
          const saved = sessionDraftStore.get(targetSessionId);
          if (saved) sessionDraftStore.set(targetSessionId, {
            ...saved, pendingDocuments: [...saved.pendingDocuments, doc], revision: ++composerRevision,
          });
        }
        const warnings = [
          doc.truncated ? t("内容已截断") : "",
          doc.skippedImages ? t("跳过 {count} 张不支持格式", { count: doc.skippedImages }) : "",
        ].filter(Boolean);
        emit("notify", t("已解析文档：{name}（{chars} 字，{images} 张图）", {
          name: doc.name,
          chars: doc.charCount,
          images: doc.images.length,
        }) + (warnings.length ? ` · ${warnings.join(" · ")}` : ""), warnings.length ? "warning" : "success");
      }
    } finally {
      queuedDocuments -= remaining;
      uploadingDocs.value = queuedDocuments > 0;
    }
  });
  await documentUploadQueue;
}

function handleIncomingFiles(rawFiles: File[]) {
  if (controlsBlocked.value || sending.value || isRunning.value) return;
  const imageFiles = rawFiles.filter((file) => file.type.startsWith("image/"));
  const docxFiles = rawFiles.filter(isDocxFile);
  if (imageFiles.length) void props.run(() => refs.upload(imageFiles));
  if (docxFiles.length) void uploadDocuments(docxFiles);
  if (!imageFiles.length && !docxFiles.length && rawFiles.length) {
    emit("notify", t("仅支持图片或 Word (.docx) 文档"), "warning");
  }
}

function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.some((file) => file.type.startsWith("image/") || isDocxFile(file))) {
    e.preventDefault();
    handleIncomingFiles(files);
  }
}
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  handleIncomingFiles(files);
}


function onWindowDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  dragging.value = true;
}

function onWindowDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
}

function onWindowDragLeave(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dragging.value = false;
}

function onWindowDrop(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
  dragDepth = 0;
  dragging.value = false;
  if (isRunning.value) return;
  handleIncomingFiles(Array.from(e.dataTransfer.files || []));
}

function attachAssetToChat(assetId: string) {
  if (controlsBlocked.value) return;
  if (attachments.value.includes(assetId)) return;
  if (attachments.value.length >= 16) {
    emit("notify", "参考图最多16张，请减少后重试", "warning");
    return;
  }
  attachments.value = [...attachments.value, assetId];
  emit("notify", "已添加到对话附件", "success");
  nextTick(() => textareaRef.value?.focus());
}

function removeAttachment(assetId: string) {
  attachments.value = attachments.value.filter((id) => id !== assetId);
}

function removeDocument(docId: string) {
  pendingDocuments.value = pendingDocuments.value.filter((doc) => doc.id !== docId);
}

function openLightbox(assets: string[], startIndex: number) {
  lightboxItems.value = assets.map((asset) => ({ asset, mime: assetMime(asset) }));
  lightboxIndex.value = startIndex;
}

function assetMime(asset: string): string | undefined {
  for (const msg of messages.value) {
    for (const card of msg.cards) {
      if (card.type !== "batch") continue;
      for (const item of card.items) {
        const task = item.tasks.find((entry) => entry.asset === asset && entry.mime);
        if (task) return task.mime;
      }
    }
  }
}

function imageDownloadName(asset: string, mime = assetMime(asset)) {
  return mime ? `${asset}.${extensionForMime(mime)}` : asset;
}

function openBatchLightbox(card: AgentBatchCard, assetId: string) {
  const all = card.items.flatMap((it) =>
    it.tasks.filter((tk) => tk.asset).map((tk) => ({ asset: tk.asset!, mime: tk.mime })),
  );
  lightboxItems.value = all;
  lightboxIndex.value = Math.max(0, all.findIndex((item) => item.asset === assetId));
}

function restoreItemToStudio(item: AgentBatchItemView) {
  saveSessionDraft();
  emit("restore-form", {
    providerId: item.providerId,
    model: item.model,
    prompt: item.prompt,
    count: item.count,
    autoSize: item.autoSize ?? true,
    size: item.size || "1024x1024",
    references: [...(item.references || [])],
  });
}

function favoriteBatchTask(
  item: AgentBatchItemView,
  taskId: string,
  assetId: string,
) {
  emit("toggle-favorite", {
    asset: assetId,
    jobId: item.jobId,
    taskId,
    form: {
      providerId: item.providerId,
      model: item.model,
      prompt: item.prompt,
      count: item.count,
      size: item.size || "1024x1024",
      autoSize: item.autoSize ?? true,
      ratio: "1:1",
      quality: config.value.defaultQuality || "auto",
      output_format: config.value.defaultOutputFormat || "png",
      references: [...(item.references || [])],
      source: "agent",
    },
    jobCreated: new Date().toISOString(),
  });
}

function favoriteDeliverables(card: AgentDeliverablesCard) {
  for (const assetId of card.assetIds) {
    if (props.favoriteAssets.has(assetId)) continue;
    // Find matching batch item if available for metadata
    let matchedItem: AgentBatchItemView | undefined;
    let matchedTaskId = assetId;
    for (const msg of messages.value) {
      for (const c of msg.cards) {
        if (c.type !== "batch") continue;
        for (const it of c.items) {
          const tk = it.tasks.find((t) => t.asset === assetId);
          if (tk) {
            matchedItem = it;
            matchedTaskId = tk.id;
          }
        }
      }
    }
    emit("toggle-favorite", {
      asset: assetId,
      jobId: matchedItem?.jobId || card.jobIds[0] || card.id,
      taskId: matchedTaskId,
      form: {
        providerId: matchedItem?.providerId || config.value.imageProviderId,
        model: matchedItem?.model || config.value.imageModel,
        prompt: matchedItem?.prompt || card.summary || card.title,
        count: matchedItem?.count || 1,
        size: matchedItem?.size || "1024x1024",
        autoSize: matchedItem?.autoSize ?? true,
        ratio: "1:1",
        quality: config.value.defaultQuality || "auto",
        output_format: config.value.defaultOutputFormat || "png",
        references: matchedItem?.references || [],
        source: "agent",
      },
      jobCreated: new Date().toISOString(),
    });
  }
}

function batchStats(card: AgentBatchCard) {
  let total = 0;
  let done = 0;
  let failed = 0;
  for (const item of card.items) {
    total += item.count;
    for (const tk of item.tasks) {
      if (tk.status === "succeeded") done++;
      else if (tk.status === "failed" || tk.status === "cancelled") failed++;
    }
  }
  return { total, done, failed, active: done + failed < total };
}

const starters = computed(() => [
  {
    title: t("系列海报策划"),
    prompt: t(
      "帮我为一家新开的社区精品咖啡馆策划 3 张同风格季节海报（早春、盛夏、深秋），先聊聊视觉方向再决定出图。",
    ),
  },
  {
    title: t("角色一致性多场景"),
    prompt: t(
      "设计一位戴琥珀色圆框眼镜的插画师少女，保持同一人物形象与画风，批量生成 3 张不同场景（画室窗边、雨夜书店、海边写生）并帮我检查一致性。",
    ),
  },
  {
    title: t("精细构图与文字验收"),
    prompt: t(
      '生成一张极简瑞士网格风格的音乐节主视觉海报，画面包含清晰可辨的文字 "NOCTURNE 2026"，出图后请帮我检查文字拼写与版式平衡。',
    ),
  },
]);

watch(
  () => [props.providers, props.form.providerId, props.form.model],
  () => {
    if (!config.value.textProviderId || !config.value.textModel) {
      const def = buildDefaultConfig();
      config.value = {
        ...config.value,
        textProviderId: config.value.textProviderId || def.textProviderId,
        textModel: config.value.textModel || def.textModel,
      };
    }
    if (!config.value.imageProviderId || !config.value.imageModel) {
      const def = buildDefaultConfig();
      config.value = {
        ...config.value,
        imageProviderId: config.value.imageProviderId || def.imageProviderId,
        imageModel: config.value.imageModel || def.imageModel,
      };
    }
  },
  { deep: true },
);

onMounted(() => {
  restoreSessionDraft("");
  if (window.innerWidth <= 960) sidebarOpen.value = false;
  window.addEventListener("dragenter", onWindowDragEnter);
  window.addEventListener("dragover", onWindowDragOver);
  window.addEventListener("dragleave", onWindowDragLeave);
  window.addEventListener("drop", onWindowDrop);
  void loadSessionsList(true);
});

onBeforeUnmount(() => {
  saveSessionDraft();
  void flushConfigSave();
  stopReconciliation();
  mounted = false;
  selectionRevision++;
  props.signal.removeEventListener("abort", onAccountAbort);
  window.removeEventListener("dragenter", onWindowDragEnter);
  window.removeEventListener("dragover", onWindowDragOver);
  window.removeEventListener("dragleave", onWindowDragLeave);
  window.removeEventListener("drop", onWindowDrop);
  closeEvents();
});
</script>

<template>
  <div
    class="agent-shell"
    :class="{
      'agent-sidebar-collapsed': !sidebarOpen,
      'agent-dragging': dragging,
    }"
  >
    <div v-if="dragging && !isRunning" class="agent-drop-overlay" aria-hidden="true">
      <Paperclip :size="24" />
      <span>{{ t("松开以上传图片或 .docx 文档") }}</span>
    </div>

    <aside v-if="sidebarOpen" class="agent-sessions" :aria-label="t('对话列表')">
      <div class="agent-sessions-head">
        <span class="agent-sessions-title">{{ t("对话列表") }}</span>
        <div class="agent-sessions-actions">
          <button
            type="button"
            class="icon-button"
            :title="t('新建对话')"
            :aria-label="t('新建对话')"
            :disabled="controlsBlocked || sending"
            @click="createNewSession()"
          >
            <Plus :size="16" />
          </button>
          <button
            type="button"
            class="icon-button"
            :title="t('收起对话列表')"
            :aria-label="t('收起对话列表')"
            @click="sidebarOpen = false"
          >
            <PanelLeftClose :size="16" />
          </button>
        </div>
      </div>

      <div class="agent-session-list">
        <div v-if="loadingSessions" class="agent-session-empty">
          <LoaderCircle :size="16" class="spin" />
        </div>
        <div v-else-if="!sessions.length" class="agent-session-empty">
          <p>{{ t("暂无对话记录") }}</p>
        </div>
        <div
          v-for="item in sessions"
          :key="item.id"
          class="agent-session-item"
          :class="{ active: item.id === currentSessionId }"
        >
          <button
            type="button"
            class="agent-session-select agent-session-copy"
            :aria-current="currentSessionId === item.id ? 'true' : undefined"
            @click="selectSession(item.id)"
          >
            <span class="agent-session-name">{{ item.title }}</span>
            <time class="agent-session-time">{{ formatDate(item.updatedAt) }}</time>
          </button>
          <button
            type="button"
            class="icon-button agent-session-delete"
            :title="t('删除对话')"
            :aria-label="t('删除对话')"
            @click="requestDeleteSession(item)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </div>
    </aside>

    <section class="agent-main">
      <header class="agent-toolbar">
        <p v-if="isRunActive" class="agent-runtime-hint" role="note">
          {{ t("当前运行中，修改将在下一轮生效") }}
          <span v-if="isWaitingApproval">{{ t("待确认计划的生图模型例外，以计划卡片显示为准。") }}</span>
        </p>
        <fieldset class="agent-toolbar-controls" :disabled="controlsBlocked">
        <div class="agent-toolbar-row">
          <button
            v-if="!sidebarOpen"
            type="button"
            class="icon-button agent-toggle-btn"
            :title="t('展开对话列表')"
            :aria-label="t('展开对话列表')"
            @click="sidebarOpen = true"
          >
            <PanelLeftOpen :size="16" />
          </button>
          <button
            v-if="!sidebarOpen"
            type="button"
            class="icon-button agent-toggle-btn"
            :title="t('新建对话')"
            :aria-label="t('新建对话')"
            :disabled="sending"
            @click="createNewSession()"
          >
            <Plus :size="16" />
          </button>

          <div class="agent-model-group">
            <label class="agent-control-field">
              <span class="agent-control-label">{{ t("对话模型") }}</span>
              <ModelSelect
                :providers="providers"
                kind="text"
                :provider-id="config.textProviderId"
                :model="config.textModel"
                :label="t('对话模型')"
                @change="onTextModelChange"
              />
            </label>
            <label class="agent-control-field">
              <span class="agent-control-label">{{ t("生图模型") }}</span>
              <ModelSelect
                :providers="providers"
                kind="image"
                :provider-id="config.imageProviderId"
                :model="config.imageModel"
                :label="t('生图模型')"
                @change="onImageModelChange"
              />
            </label>
          </div>

          <div class="agent-tuning-group">
            <div class="agent-seg-wrap" :title="t('思考强度')">
              <span class="agent-seg-label"><Brain :size="13" />{{ t("思考强度") }}</span>
              <div class="agent-seg" role="radiogroup" :aria-label="t('思考强度')">
                <button
                  v-for="level in (['low', 'medium', 'high'] as ThinkingEffort[])"
                  :key="level"
                  type="button"
                  role="radio"
                  :aria-checked="config.thinkingEffort === level"
                  :class="{ active: config.thinkingEffort === level }"
                  @click="updateConfig('thinkingEffort', level)"
                >
                  {{ t(level === "low" ? "低" : level === "medium" ? "中" : "高") }}
                </button>
              </div>
            </div>

            <div class="agent-seg-wrap" :title="t('速度')">
              <span class="agent-seg-label"><Zap :size="13" />{{ t("速度") }}</span>
              <div class="agent-seg" role="radiogroup" :aria-label="t('速度')">
                <button
                  type="button"
                  role="radio"
                  :aria-checked="config.speed === 'normal'"
                  :class="{ active: config.speed === 'normal' }"
                  @click="updateConfig('speed', 'normal')"
                >
                  {{ t("普通") }}
                </button>
                <button
                  type="button"
                  role="radio"
                  :aria-checked="config.speed === 'priority'"
                  :class="{ active: config.speed === 'priority' }"
                  @click="updateConfig('speed', 'priority')"
                >
                  {{ t("快速") }}
                </button>
              </div>
            </div>

            <button
              type="button"
              class="agent-options-btn"
              :class="{ active: optionsOpen }"
              :aria-expanded="optionsOpen"
              @click="optionsOpen = !optionsOpen"
            >
              <SlidersHorizontal :size="14" />
              <span>{{ t("更多设置") }}</span>
              <ChevronDown :size="13" class="agent-chevron" :class="{ open: optionsOpen }" />
            </button>
          </div>
        </div>

        <div v-if="optionsOpen" class="agent-options-drawer">
          <div class="agent-option-item">
            <span class="agent-seg-label">{{ t("执行策略") }}</span>
            <div class="agent-seg" role="radiogroup" :aria-label="t('执行策略')">
              <button
                type="button"
                role="radio"
                :aria-checked="config.approvalMode === 'confirm'"
                :class="{ active: config.approvalMode === 'confirm' }"
                @click="updateConfig('approvalMode', 'confirm')"
              >
                {{ t("确认后生图") }}
              </button>
              <button
                type="button"
                role="radio"
                :aria-checked="config.approvalMode === 'auto'"
                :class="{ active: config.approvalMode === 'auto' }"
                @click="updateConfig('approvalMode', 'auto')"
              >
                {{ t("自动闭环") }}
              </button>
            </div>
          </div>

          <label class="agent-option-toggle">
            <input
              type="checkbox"
              :checked="config.autoInspect"
              @change="
                updateConfig(
                  'autoInspect',
                  ($event.target as HTMLInputElement).checked,
                )
              "
            />
            <ShieldCheck :size="14" />
            <span>{{ t("自动验收") }}</span>
          </label>

          <label class="agent-option-number">
            <span>{{ t(isRunActive ? "下轮预算（张）" : "本轮预算（张）") }}</span>
            <input
              type="number"
              min="1"
              max="24"
              :value="config.budgetImages"
              @change="
                updateConfig(
                  'budgetImages',
                  Number(($event.target as HTMLInputElement).value) || 8,
                )
              "
            />
          </label>

          <label class="agent-option-number">
            <span>{{ t("质检自动重试上限") }}</span>
            <input
              type="number"
              min="0"
              max="4"
              :value="config.maxRetries"
              @change="
                updateConfig(
                  'maxRetries',
                  Number(($event.target as HTMLInputElement).value) || 0,
                )
              "
            />
          </label>
        </div>
        </fieldset>
      </header>

      <div class="agent-thread-region">
      <div ref="threadRef" class="agent-thread" @scroll.passive="onThreadScroll">
        <div v-if="sseState === 'reconnecting' || sseState === 'disconnected' || reconciliationExpired" class="agent-error-bar" role="status">
          <AlertTriangle :size="14" aria-hidden="true" />
          <span>{{ t(reconciliationExpired ? "后台任务仍未结束，请刷新状态。" : sseState === "reconnecting" ? "连接中断，正在重新连接…" : "实时连接已断开") }}</span>
          <button type="button" @click="reconnectSession">{{ t("重新连接 / 刷新状态") }}</button>
        </div>
        <div v-if="loadingDetail" class="agent-empty">
          <LoaderCircle :size="24" class="spin" />
        </div>
        <div v-else-if="detailError" class="agent-empty" role="alert">
          <AlertTriangle :size="24" aria-hidden="true" />
          <p>{{ detailError }}</p>
          <button type="button" @click="selectSession(currentSessionId)">{{ t("重试") }}</button>
        </div>

        <div v-else-if="!messages.length" class="agent-empty">
          <div class="agent-empty-badge">
            <Sparkles :size="22" />
          </div>
          <h2>{{ t("开始与你的 AI 视觉创作搭档对话") }}</h2>
          <p>
            {{
              t(
                "聊聊灵感、拆解成套系列图，或直接粘贴参考图让它帮你构思、批量出图并自动看图把关。",
              )
            }}
          </p>
          <button
            v-if="!hasProviders"
            type="button"
            class="primary"
            @click="emit('go-settings')"
          >
            {{ t("先去配置文本与生图模型") }}<ArrowUpRight :size="15" />
          </button>
          <div v-else class="agent-starters">
            <button
              v-for="s in starters"
              :key="s.title"
              type="button"
              class="agent-starter-card"
              @click="
                draft = s.prompt;
                resizeTextarea();
                textareaRef?.focus();
              "
            >
              <strong>{{ s.title }}</strong>
              <span>{{ s.prompt }}</span>
            </button>
          </div>
        </div>

        <template v-else>
          <article
            v-for="msg in messages"
            :key="msg.id"
            class="agent-msg"
            :class="`agent-msg-${msg.role}`"
          >
            <div v-if="msg.role === 'user'" class="agent-user-bubble">
              <div v-if="msg.attachments.length" class="agent-msg-attachments">
                <button
                  v-for="(assetId, idx) in msg.attachments"
                  :key="assetId"
                  type="button"
                  class="agent-thumb-btn"
                  :aria-label="t('查看原图')"
                  @click="openLightbox(msg.attachments, idx)"
                >
                  <AssetImage
                    :asset="assetId"
                    :signal="signal"
                    :alt="t('参考图 {index}', { index: idx + 1 })"
                  />
                </button>
              </div>
              <div v-if="msg.documents?.length" class="agent-msg-docs">
                <div v-for="doc in msg.documents" :key="doc.id" class="agent-doc-card">
                  <div class="agent-doc-head">
                    <FileText :size="19" aria-hidden="true" />
                    <div class="agent-doc-info">
                      <span class="agent-doc-name" :title="doc.name">{{ doc.name }}</span>
                      <span class="agent-doc-meta">
                        {{ t("{chars} 字 · {images} 张图", { chars: doc.charCount, images: doc.images.length }) }}
                      </span>
                    </div>
                  </div>
                  <div v-if="doc.skippedImages || doc.truncated" class="agent-doc-warnings">
                    <span v-if="doc.skippedImages">{{ t("跳过 {count} 张不支持格式", { count: doc.skippedImages }) }}</span>
                    <span v-if="doc.truncated">{{ t("内容已截断") }}</span>
                  </div>
                  <div v-if="doc.images.length" class="agent-doc-thumbs">
                    <button
                      v-for="(assetId, idx) in doc.images.slice(0, 6)"
                      :key="`${assetId}-${idx}`"
                      type="button"
                      class="agent-doc-thumb"
                      :aria-label="t('文档图片 {index}', { index: idx + 1 })"
                      @click="openLightbox(doc.images, idx)"
                    >
                      <AssetImage :asset="assetId" :signal="signal" :alt="t('文档图片 {index}', { index: idx + 1 })" />
                    </button>
                    <button
                      v-if="doc.images.length > 6"
                      type="button"
                      class="agent-doc-more"
                      :aria-label="t('文档图片 {index}', { index: 7 })"
                      @click="openLightbox(doc.images, 6)"
                    >
                      +{{ doc.images.length - 6 }}
                    </button>
                  </div>
                </div>
              </div>
              <p v-if="msg.content" class="agent-text">{{ msg.content }}</p>
            </div>

            <div v-else class="agent-assistant-body">
              <details v-if="msg.reasoning" class="agent-reasoning">
                <summary>
                  <Brain :size="13" />
                  <span>{{ t("思考过程") }}</span>
                </summary>
                <div class="agent-reasoning-text">{{ msg.reasoning }}</div>
              </details>

              <div v-if="msg.content" class="agent-text">{{ msg.content }}</div>

              <div v-if="msg.cards.length" class="agent-cards">
                <template v-for="card in msg.cards" :key="card.id">
                  <!-- Plan Approval Card -->
                  <section v-if="card.type === 'plan'" class="agent-card agent-plan-card">
                    <div class="agent-card-head">
                      <div class="agent-card-title">
                        <WandSparkles :size="15" />
                        <strong>{{ t("生图计划") }}</strong>
                        <span class="agent-card-sub">
                          {{
                            t("共 {groups} 组 · {images} 张", {
                              groups: getPlanItems(card).length,
                              images: planTotalImages(card),
                            })
                          }}
                        </span>
                      </div>
                      <span class="agent-pill" :class="`status-${card.status}`">
                        {{
                          t(
                            card.status === "pending"
                              ? "待确认"
                              : card.status === "approved"
                                ? "已批准"
                                : card.status === "rejected"
                                  ? "已取消"
                                  : "已过期",
                          )
                        }}
                      </span>
                    </div>
                    <p v-if="card.summary" class="agent-card-summary">{{ card.summary }}</p>
                    <p v-if="card.status === 'pending'" class="agent-card-summary" :class="{ 'text-danger': plannedTotalImages > remainingBudget }">
                      {{ t("本次计划 {planned} 张 / 剩余预算 {remaining} 张", { planned: plannedTotalImages, remaining: remainingBudget }) }}
                    </p>

                    <div class="agent-plan-list">
                      <div
                        v-for="(item, idx) in getPlanItems(card)"
                        :key="idx"
                        class="agent-plan-item"
                      >
                        <div class="agent-plan-item-head">
                          <input
                            v-if="card.status === 'pending'"
                            v-model="item.title"
                            type="text"
                            class="agent-plan-title-input"
                          />
                          <strong v-else>{{ item.title }}</strong>

                          <div class="agent-plan-meta">
                            <span class="agent-tag">
                              {{ item.autoSize !== false ? t("自动规格") : item.size || "1024x1024" }}
                            </span>
                            <div v-if="card.status === 'pending'" class="agent-count-stepper">
                              <button
                                type="button"
                                class="icon-button"
                                :disabled="item.count <= 1"
                                @click="adjustPlanCount(card.id, idx, -1)"
                              >
                                -
                              </button>
                              <span>{{ item.count }}</span>
                              <button
                                type="button"
                                class="icon-button"
                                :disabled="item.count >= 8 || plannedTotalImages >= remainingBudget"
                                @click="adjustPlanCount(card.id, idx, 1)"
                              >
                                +
                              </button>
                            </div>
                            <span v-else class="agent-tag">{{ item.count }} {{ t("张数") }}</span>
                            <button
                              v-if="card.status === 'pending' && getPlanItems(card).length > 1"
                              type="button"
                              class="icon-button"
                              :aria-label="t('移除参考图')"
                              @click="removePlanItem(card.id, idx)"
                            >
                              <X :size="13" />
                            </button>
                          </div>
                        </div>
                        <p class="agent-plan-execution-model">{{ t("执行模型：{model}", { model: planExecutionModel(item) }) }}</p>

                        <textarea
                          v-if="card.status === 'pending'"
                          v-model="item.prompt"
                          rows="2"
                          class="agent-plan-prompt-input"
                          :aria-label="t('提示词')"
                          :aria-invalid="!item.prompt.trim() ? 'true' : undefined"
                          :aria-describedby="!item.prompt.trim() ? `plan-prompt-error-${card.id}-${idx}` : undefined"
                        />
                        <p v-else class="agent-plan-prompt-text">{{ item.prompt }}</p>
                        <p v-if="card.status === 'pending' && !item.prompt.trim()" :id="`plan-prompt-error-${card.id}-${idx}`" class="agent-validation-error">{{ t("提示词不能为空") }}</p>

                        <div v-if="item.references?.length" class="agent-plan-refs">
                          <button
                            v-for="(refId, rIdx) in item.references"
                            :key="refId"
                            type="button"
                            class="agent-mini-thumb"
                            @click="openLightbox(item.references, rIdx)"
                          >
                            <AssetImage :asset="refId" :signal="signal" alt="" />
                          </button>
                        </div>
                      </div>
                    </div>

                    <div v-if="card.status === 'pending'" class="agent-plan-actions">
                      <button
                        type="button"
                        class="primary"
                        :disabled="approving || !canApprovePlan(card)"
                        @click="handleApprove(card, true)"
                      >
                        <LoaderCircle v-if="approving" :size="14" class="spin" />
                        <Check v-else :size="14" />
                        <span>{{ t("批准并开始生成") }}</span>
                      </button>
                      <span v-if="planBlockingReason(card)" class="agent-validation-error" role="status">{{ planBlockingReason(card) }}</span>
                      <button
                        type="button"
                        :disabled="approving || controlsBlocked"
                        @click="handleApprove(card, false)"
                      >
                        <X :size="14" />
                        <span>{{ t("取消计划") }}</span>
                      </button>
                    </div>
                  </section>

                  <!-- Batch Results Card -->
                  <section v-else-if="card.type === 'batch'" class="agent-card agent-batch-card">
                    <div class="agent-card-head">
                      <div class="agent-card-title">
                        <LoaderCircle
                          v-if="batchStats(card).active"
                          :size="15"
                          class="spin"
                        />
                        <CheckCircle2 v-else :size="15" class="text-success" />
                        <strong>{{ t("批量生成结果") }}</strong>
                        <span class="agent-card-sub">
                          {{ batchStats(card).done }} / {{ batchStats(card).total }}
                        </span>
                      </div>
                      <span v-if="card.summary" class="agent-card-sub">
                        {{ card.summary }}
                      </span>
                    </div>

                    <div class="agent-batch-groups">
                      <div
                        v-for="item in card.items"
                        :key="item.jobId"
                        class="agent-batch-group"
                      >
                        <div class="agent-batch-group-head">
                          <div>
                            <strong>{{ item.title }}</strong>
                            <span class="agent-batch-model">{{ item.model }}</span>
                          </div>
                          <button
                            type="button"
                            class="agent-inline-link"
                            @click="restoreItemToStudio(item)"
                          >
                            {{ t("回填工作台") }}<ArrowUpRight :size="12" />
                          </button>
                        </div>
                        <p class="agent-batch-prompt">{{ item.prompt }}</p>
                        <div class="agent-gallery-grid">
                          <div
                            v-for="tk in item.tasks"
                            :key="tk.id"
                            class="agent-gallery-cell"
                          >
                            <template v-if="tk.status === 'succeeded' && tk.asset">
                              <button
                                type="button"
                                class="agent-gallery-open"
                                :aria-label="t('查看原图')"
                                @click="openBatchLightbox(card, tk.asset)"
                              >
                                <AssetImage
                                  :asset="tk.asset"
                                  :signal="signal"
                                  :alt="item.title"
                                />
                              </button>
                              <div class="agent-gallery-actions">
                                <button
                                  type="button"
                                  class="icon-button"
                                  :class="{ favorited: favoriteAssets.has(tk.asset) }"
                                  :title="t('收藏夹')"
                                  @click="favoriteBatchTask(item, tk.id, tk.asset)"
                                >
                                  <Star
                                    :size="13"
                                    :fill="
                                      favoriteAssets.has(tk.asset)
                                        ? 'currentColor'
                                        : 'none'
                                    "
                                  />
                                </button>
                                <button
                                  type="button"
                                  class="icon-button"
                                  :title="t('设为参考图')"
                                  @click="attachAssetToChat(tk.asset)"
                                >
                                  <ImagePlus :size="13" />
                                </button>
                                <button
                                  type="button"
                                  class="icon-button"
                                  :title="t('复制图片')"
                                  @click="
                                    run(
                                      () => copyImage(tk.asset!, signal),
                                      t('复制成功'),
                                    )
                                  "
                                >
                                  <Copy :size="13" />
                                </button>
                                <button
                                  type="button"
                                  class="icon-button"
                                  :title="t('下载原图')"
                                  @click="
                                    run(() =>
                                      download(
                                        `/api/assets/${tk.asset}`,
                                        imageDownloadName(tk.asset!, tk.mime),
                                        signal,
                                      ),
                                    )
                                  "
                                >
                                  <Download :size="13" />
                                </button>
                              </div>
                            </template>
                            <div
                              v-else-if="
                                tk.status === 'queued' || tk.status === 'running'
                              "
                              class="agent-gallery-loading"
                            >
                              <LoaderCircle :size="20" class="spin" />
                              <span>{{
                                t(tk.status === "running" ? "生成中" : "排队中")
                              }}</span>
                            </div>
                            <div v-else class="agent-gallery-failed">
                              <XCircle :size="18" />
                              <span>{{ tk.error || t("失败") }}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </section>

                  <!-- Visual Inspection Report Card -->
                  <section
                    v-else-if="card.type === 'inspection'"
                    class="agent-card agent-inspect-card"
                  >
                    <div class="agent-card-head">
                      <div class="agent-card-title">
                        <ShieldCheck :size="15" />
                        <strong>{{ t("视觉质检报告") }}</strong>
                      </div>
                      <span
                        class="agent-pill"
                        :class="
                          card.degraded
                            ? 'status-superseded'
                            : card.passed
                              ? 'status-approved'
                              : 'status-warn'
                        "
                      >
                        {{
                          t(
                            card.degraded
                              ? "已跳过看图"
                              : card.passed
                                ? "验收通过"
                                : "发现待优化项",
                          )
                        }}
                      </span>
                    </div>
                    <p class="agent-card-summary">{{ card.summary }}</p>

                    <ul v-if="card.checks.length" class="agent-inspect-checks">
                      <li v-for="(chk, cIdx) in card.checks" :key="cIdx">
                        <CheckCircle2
                          v-if="chk.status === 'pass'"
                          :size="14"
                          class="text-success"
                        />
                        <AlertTriangle
                          v-else-if="chk.status === 'warn'"
                          :size="14"
                          class="text-warn"
                        />
                        <XCircle v-else :size="14" class="text-danger" />
                        <div class="agent-check-copy">
                          <strong>{{ chk.criterion }}</strong>
                          <span v-if="chk.note">{{ chk.note }}</span>
                        </div>
                      </li>
                    </ul>

                    <div v-if="card.suggestedFix" class="agent-inspect-fix">
                      <strong>{{ t("改进建议") }}：</strong>{{ card.suggestedFix }}
                    </div>
                  </section>

                  <!-- Deliverables Card -->
                  <section
                    v-else-if="card.type === 'deliverables'"
                    class="agent-card agent-deliverables-card"
                  >
                    <div class="agent-card-head">
                      <div class="agent-card-title">
                        <Sparkles :size="15" />
                        <strong>{{ card.title || t("精选成品") }}</strong>
                      </div>
                      <button
                        type="button"
                        class="agent-inline-link"
                        @click="favoriteDeliverables(card)"
                      >
                        <Star :size="13" />{{ t("全部收藏") }}
                      </button>
                    </div>
                    <p v-if="card.summary" class="agent-card-summary">{{ card.summary }}</p>
                    <div class="agent-gallery-grid">
                      <div
                        v-for="(assetId, idx) in card.assetIds"
                        :key="assetId"
                        class="agent-gallery-cell"
                      >
                        <button
                          type="button"
                          class="agent-gallery-open"
                          @click="openLightbox(card.assetIds, idx)"
                        >
                          <AssetImage :asset="assetId" :signal="signal" :alt="card.title" />
                        </button>
                        <div class="agent-gallery-actions">
                          <button
                            type="button"
                            class="icon-button"
                            :title="t('设为参考图')"
                            @click="attachAssetToChat(assetId)"
                          >
                            <ImagePlus :size="13" />
                          </button>
                          <button
                            type="button"
                            class="icon-button"
                            :title="t('下载原图')"
                            @click="
                              run(() =>
                                download(
                                  `/api/assets/${assetId}`,
                                  imageDownloadName(assetId),
                                  signal,
                                ),
                              )
                            "
                          >
                            <Download :size="13" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>
                </template>
              </div>
            </div>
          </article>

          <div v-if="isRunning || isWaitingApproval" class="agent-status-bar">
            <LoaderCircle v-if="isRunning" :size="14" class="spin" />
            <WandSparkles v-else :size="14" />
            <span>
              {{
                t(
                  isRunning
                    ? "正在思考与规划…"
                    : "等待你确认生图计划…",
                )
              }}
            </span>
            <span v-if="activeRun" class="agent-budget-chip">
              {{
                t("本轮已用 {used}/{budget} 张", {
                  used: activeRun.usedImages,
                  budget: activeRun.budgetImages,
                })
              }}
            </span>
          </div>

          <div
            v-else-if="activeRun?.status === 'failed' && activeRun.error"
            class="agent-error-bar"
          >
            <AlertTriangle :size="14" />
            <span>{{ activeRun.error }}</span>
          </div>
        </template>
      </div>
        <button v-if="!isNearBottom || hasUnreadOutput" type="button" class="agent-jump-bottom" @click="scrollToBottom(true, true)">
          {{ t(hasUnreadOutput ? "有新动态" : "回到底部") }}
        </button>
      </div>

      <footer class="agent-composer">
        <div class="agent-input-box">
          <div v-if="attachments.length || pendingDocuments.length" class="agent-attach-strip">
            <div
              v-for="(assetId, idx) in attachments"
              :key="assetId"
              class="agent-attach-item"
            >
              <button
                type="button"
                class="agent-attach-open"
                @click="openLightbox(attachments, idx)"
              >
                <AssetImage :asset="assetId" :signal="signal" alt="" />
              </button>
              <button
                type="button"
                class="agent-attach-remove"
                :aria-label="t('移除参考图')"
                @click="removeAttachment(assetId)"
              >
                <X :size="12" />
              </button>
            </div>
            <div v-for="doc in pendingDocuments" :key="doc.id" class="agent-doc-chip">
              <div class="agent-doc-head">
                <FileText :size="18" aria-hidden="true" />
                <div class="agent-doc-info">
                  <span class="agent-doc-name" :title="doc.name">{{ doc.name }}</span>
                  <span class="agent-doc-meta">
                    {{ t(doc.images.length ? "{chars} 字 · {images} 张图" : "{chars} 字", { chars: doc.charCount, images: doc.images.length }) }}
                  </span>
                </div>
                <button
                  type="button"
                  class="agent-doc-remove"
                  :title="t('移除文档')"
                  :aria-label="`${t('移除文档')} ${doc.name}`"
                  @click="removeDocument(doc.id)"
                >
                  <X :size="14" />
                </button>
              </div>
              <div v-if="doc.skippedImages || doc.truncated" class="agent-doc-warnings">
                <span v-if="doc.skippedImages">{{ t("跳过 {count} 张不支持格式", { count: doc.skippedImages }) }}</span>
                <span v-if="doc.truncated">{{ t("内容已截断") }}</span>
              </div>
              <div v-if="doc.images.length" class="agent-doc-thumbs">
                <button
                  v-for="(assetId, idx) in doc.images.slice(0, 4)"
                  :key="`${assetId}-${idx}`"
                  type="button"
                  class="agent-doc-thumb"
                  :aria-label="t('文档图片 {index}', { index: idx + 1 })"
                  @click="openLightbox(doc.images, idx)"
                >
                  <AssetImage :asset="assetId" :signal="signal" :alt="t('文档图片 {index}', { index: idx + 1 })" />
                </button>
                <button
                  v-if="doc.images.length > 4"
                  type="button"
                  class="agent-doc-more"
                  :aria-label="t('文档图片 {index}', { index: 5 })"
                  @click="openLightbox(doc.images, 4)"
                >
                  +{{ doc.images.length - 4 }}
                </button>
              </div>
            </div>
          </div>

          <textarea
            ref="textareaRef"
            v-model="draft"
            rows="1"
            class="agent-textarea"
            :disabled="controlsBlocked"
            :placeholder="t('请输入内容...（Enter 发送，Shift+Enter 换行）')"
            @input="resizeTextarea"
            @keydown="onTextareaKeydown"
            @paste="onPaste"
          />

          <div class="agent-input-bar">
            <div class="agent-input-bar-left">
              <input
                ref="fileInput"
                type="file"
                class="agent-file-input"
                accept="image/png,image/jpeg,image/webp,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                multiple
                hidden
                @change="onFileChange"
              />
              <button
                type="button"
                class="icon-button agent-attach-btn"
                :disabled="controlsBlocked || refs.pending.value || uploadingDocs || isRunning"
                :title="t('上传图片或 Word 文档 (.docx)')"
                :aria-label="t('上传图片或 Word 文档 (.docx)')"
                @click="fileInput?.click()"
              >
                <LoaderCircle v-if="refs.pending.value || uploadingDocs" :size="17" class="spin" />
                <Paperclip v-else :size="17" />
              </button>
              <span v-if="uploadingDocs" class="agent-doc-meta" role="status">{{ t("正在解析文档…") }}</span>
            </div>

            <div class="agent-input-bar-right">
              <button
                v-if="isRunActive"
                :disabled="controlsBlocked"
                type="button"
                class="agent-stop-btn"
                :title="t('停止运行')"
                @click="stopRun"
              >
                <Square :size="14" fill="currentColor" />
                <span>{{ t("停止运行") }}</span>
              </button>
              <button
                v-else
                type="button"
                class="primary agent-send-btn"
                :disabled="!canSend"
                :title="t('发送')"
                @click="sendMessage()"
              >
                <LoaderCircle v-if="sending" :size="15" class="spin" />
                <Send v-else :size="15" />
                <span>{{ t("发送") }}</span>
              </button>
            </div>
          </div>
        </div>
      </footer>
    </section>

    <Modal
      v-if="deleteTarget"
      :title="t('删除对话')"
      @close="deleteTarget = null"
    >
      <p>{{ t(deleteHasActiveRun ? "此对话仍在运行。删除将停止 Agent、取消排队任务并拒绝待确认计划；已开始的生图任务可能仍会在后台完成，已生成的图片资产会保留。" : "删除对话后不会删除已生成的图片资产。") }}</p>
      <div class="modal-actions">
        <button type="button" @click="deleteTarget = null">{{ t("取消") }}</button>
        <button type="button" class="danger-btn" @click="confirmDeleteSession">
          {{ t("删除对话") }}
        </button>
      </div>
    </Modal>

    <Lightbox
      v-if="lightboxIndex !== null && lightboxItems[lightboxIndex]"
      :asset="lightboxItems[lightboxIndex].asset"
      :items="lightboxItems"
      :initial-index="lightboxIndex"
      :signal="signal"
      :run="run"
      @close="lightboxIndex = null"
    />
  </div>
</template>

<style scoped>
.agent-session-select {
  flex: 1;
  align-items: stretch;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 2px 0;
  border-radius: 4px;
  min-width: 0;
}
.agent-session-item:focus-within .agent-session-delete { opacity: 1; }
.agent-toolbar-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.agent-thread-region { position: relative; display: flex; flex: 1; min-height: 0; }
.agent-thread-region > .agent-thread { min-width: 0; }
.agent-runtime-hint, .agent-plan-execution-model {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.agent-runtime-hint span { display: block; }
.agent-validation-error { margin: 0; color: var(--danger); font-size: 12px; }
.agent-plan-prompt-input[aria-invalid="true"] { border-color: var(--danger); }
.agent-jump-bottom {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  flex-shrink: 0;
  z-index: 1;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--ink) 12%, transparent);
}
.agent-error-bar { flex-wrap: wrap; }
</style>
