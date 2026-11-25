<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { t } from '../i18n';
import { Search, Save, Plus, X, TriangleAlert } from "lucide-vue-next";
import Modal from "./Modal.vue";
import type { ProviderDraft, Provider, Model, Api, Run } from "../types";

const props = defineProps<{
  provider?: Provider;
  api: Api;
  run: Run;
}>();
const emit = defineEmits<{ saved: []; cancel: [] }>();
const labelId = useId();
const manualReason = "手动指定用途"; // API marker; not rendered in the editor.
const modalRef = ref<InstanceType<typeof Modal> | null>(null);
const baseUrlInput = ref<HTMLInputElement | null>(null);
const originalBaseUrl = (props.provider?.baseUrl || "").trim().replace(/\/$/, "");
const wasShared = Boolean(props.provider?.shared);

function withDefaultPurpose(model: Model): Model {
  const types = Array.from(new Set(model.types.filter((type) => type === "image" || type === "text")));
  return { ...model, types: types.length ? types : ["text"] };
}

const draft = ref<ProviderDraft>({
  id: props.provider?.id,
  name: props.provider?.name || "",
  baseUrl: props.provider?.baseUrl || "",
  apiKey: "",
  models: (props.provider?.models ?? []).map(withDefaultPurpose),
  shared: !!props.provider?.shared,
  kind: "mixed",
});
const clearApiKey = ref(false);
const reuseApiKey = ref(false);
const pending = ref<"discover" | "save" | null>(null);
const newModelId = ref("");
const newModelPurpose = ref<"image" | "text" | "both">("image");
const manualModelError = ref("");
const discoverSummary = ref<{ added: number; missingIds: string[] } | null>(null);
const confirmingRevokeShare = ref(false);

function serializeState(d: ProviderDraft) {
  return JSON.stringify({
    name: d.name.trim(),
    baseUrl: d.baseUrl.trim().replace(/\/$/, ""),
    shared: d.shared,
    models: d.models.map((m) => ({ id: m.id, types: [...m.types].sort() })),
  });
}
const initialSnapshot = serializeState(draft.value);

const normalizedBaseUrl = computed(() => draft.value.baseUrl.trim().replace(/\/$/, ""));
const urlChangedWithSavedKey = computed(() =>
  Boolean(props.provider?.hasKey && originalBaseUrl && normalizedBaseUrl.value !== originalBaseUrl),
);
const needsKeyDecisionForNewUrl = computed(() =>
  urlChangedWithSavedKey.value && !draft.value.apiKey.trim() && !clearApiKey.value && !reuseApiKey.value,
);
const dirty = computed(
  () =>
    serializeState(draft.value) !== initialSnapshot ||
    Boolean(draft.value.apiKey) ||
    clearApiKey.value ||
    reuseApiKey.value,
);

watch(normalizedBaseUrl, () => {
  reuseApiKey.value = false;
});
watch(() => draft.value.apiKey, (val) => {
  if (val) {
    clearApiKey.value = false;
    reuseApiKey.value = false;
  }
});
watch(clearApiKey, (val) => {
  if (val) {
    draft.value.apiKey = "";
    reuseApiKey.value = false;
  }
});

function togglePurpose(model: Model, kind: "text" | "image") {
  const has = model.types.includes(kind);
  if (has) {
    const remaining = model.types.filter((item) => item !== kind);
    model.types = remaining.length ? remaining : [kind === "image" ? "text" : "image"];
  } else {
    model.types = Array.from(new Set([...model.types, kind]));
  }
  model.reason = manualReason;
}

function addManualModel() {
  manualModelError.value = "";
  const id = newModelId.value.trim();
  if (!id) {
    manualModelError.value = "请输入模型 ID";
    return;
  }
  if (draft.value.models.some((m) => m.id === id)) {
    manualModelError.value = "该模型 ID 已存在";
    return;
  }
  const types =
    newModelPurpose.value === "both" ? ["text", "image"] : [newModelPurpose.value];
  draft.value.models.push({ id, types, reason: manualReason });
  newModelId.value = "";
}

function removeModel(id: string) {
  draft.value.models = draft.value.models.filter((m) => m.id !== id);
  if (discoverSummary.value) {
    discoverSummary.value = {
      ...discoverSummary.value,
      missingIds: discoverSummary.value.missingIds.filter((item) => item !== id),
    };
  }
}

function removeMissingModels() {
  if (!discoverSummary.value?.missingIds.length) return;
  const toDrop = new Set(discoverSummary.value.missingIds);
  draft.value.models = draft.value.models.filter((m) => !toDrop.has(m.id));
  discoverSummary.value = { ...discoverSummary.value, missingIds: [] };
}

function buildPayload(): ProviderDraft {
  return {
    ...draft.value,
    clearApiKey: clearApiKey.value || undefined,
    reuseApiKey: reuseApiKey.value || undefined,
  };
}

async function discover() {
  if (pending.value) return;
  if (baseUrlInput.value && !baseUrlInput.value.reportValidity()) return;
  if (needsKeyDecisionForNewUrl.value) return;
  pending.value = "discover";
  discoverSummary.value = null;
  try {
    await props.run(async () => {
      const out = await props.api<{ data: Model[] }>(
        "/providers" + (draft.value.id ? "/" + draft.value.id : "") + "/models",
        buildPayload(),
      );
      const previous = new Map(draft.value.models.map((model) => [model.id, model]));
      const remoteIds = new Set(out.data.map((m) => m.id));
      let added = 0;
      const merged: Model[] = out.data.map((model) => {
        const existing = previous.get(model.id);
        if (existing) {
          if (existing.reason === manualReason || existing.types.length === 2) return existing;
          return withDefaultPurpose(model);
        }
        added++;
        return withDefaultPurpose(model);
      });
      const missingIds: string[] = [];
      for (const oldModel of draft.value.models) {
        if (!remoteIds.has(oldModel.id)) {
          merged.push(oldModel);
          missingIds.push(oldModel.id);
        }
      }
      draft.value.models = merged;
      discoverSummary.value = { added, missingIds };
    }, "模型目录已获取");
  } finally {
    pending.value = null;
  }
}

async function commitSave() {
  if (pending.value) return;
  confirmingRevokeShare.value = false;
  pending.value = "save";
  try {
    await props.run(async () => {
      await props.api(
        "/providers" + (draft.value.id ? "/" + draft.value.id : ""),
        buildPayload(),
        draft.value.id ? "PATCH" : "POST",
      );
      draft.value.apiKey = "";
      clearApiKey.value = false;
      reuseApiKey.value = false;
      emit("saved");
    }, "供应商已保存");
  } finally {
    pending.value = null;
  }
}

function save() {
  if (pending.value || needsKeyDecisionForNewUrl.value) return;
  if (wasShared && !draft.value.shared) {
    confirmingRevokeShare.value = true;
    return;
  }
  void commitSave();
}
</script>

<template>
  <Modal
    ref="modalRef"
    :title="t(provider ? '编辑供应商' : '添加供应商')"
    :locked="!!pending"
    :dirty="dirty"
    @close="emit('cancel')"
  >
    <form class="provider-form" @submit.prevent="save">
      <div class="field-grid">
        <label>
          {{ t('名称') }}
          <input v-model="draft.name" name="name" required maxlength="100" :disabled="!!pending" :placeholder="t('例如：我的图像服务')" />
        </label>
        <label>
          Base URL
          <input ref="baseUrlInput" v-model="draft.baseUrl" name="baseUrl" type="url" required :disabled="!!pending" placeholder="https://api.example.com/v1" />
        </label>
      </div>
      <div class="provider-key-group">
        <label>
          {{ t(provider?.hasKey ? "新 API Key（留空保持原值）" : "API Key") }}
          <input v-model="draft.apiKey" name="apiKey" type="password" autocomplete="new-password" :disabled="!!pending || clearApiKey" :placeholder="t('请输入API Key')" />
        </label>
        <div v-if="provider?.hasKey && !draft.apiKey" class="provider-key-options">
          <label class="inline-check">
            <input v-model="clearApiKey" type="checkbox" :disabled="!!pending" />
            <span>{{ t('清除已保存的 API Key') }}</span>
          </label>
        </div>
        <div v-if="urlChangedWithSavedKey && !draft.apiKey && !clearApiKey" class="provider-warning-box" role="alert">
          <TriangleAlert :size="15" aria-hidden="true" />
          <div class="provider-warning-copy">
            <p>{{ t('Base URL 已变更。为防止密钥泄露，不会自动将原 API Key 发送到新地址。请输入新密钥、清除原密钥，或显式确认复用。') }}</p>
            <label class="inline-check">
              <input v-model="reuseApiKey" type="checkbox" :disabled="!!pending" />
              <span>{{ t('确认将原 API Key 发送至新的 Base URL') }}</span>
            </label>
          </div>
        </div>
      </div>
      <div class="switch-row">
        <div>
          <strong>{{ t('开放 / 共享') }}</strong>
          <small :id="`${labelId}-sharing`">{{ t('设置为共享将让此供应商配置被所有用户可见并使用。') }}</small>
          <p v-if="wasShared && !draft.shared" class="provider-inline-warn" role="alert">
            {{ t('保存后将关闭共享，其他用户使用该供应商的排队中任务会被取消。') }}
          </p>
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          :aria-label="t('开放共享供应商')"
          :aria-describedby="`${labelId}-sharing`"
          :aria-checked="draft.shared"
          :disabled="!!pending"
          @click="draft.shared = !draft.shared"
        ><span aria-hidden="true" /></button>
      </div>
      <section class="provider-models" :aria-labelledby="`${labelId}-catalog`">
        <div class="provider-models-head">
          <h3 :id="`${labelId}-catalog`">{{ t('模型目录') }} <small v-if="draft.models.length">{{ t('{count} 个', { count: draft.models.length }) }}</small></h3>
          <button type="button" :disabled="!!pending || !draft.baseUrl.trim() || needsKeyDecisionForNewUrl" @click="discover">
            <Search :size="16" />{{ t(pending === 'discover' ? "获取中…" : "获取模型") }}
          </button>
        </div>
        <div class="manual-model-row">
          <input
            v-model="newModelId"
            type="text"
            :disabled="!!pending"
            :aria-label="t('手动添加模型 ID')"
            :placeholder="t('手动输入模型 ID，如 gpt-image-1')"
            @keydown.enter.prevent="addManualModel"
            @input="manualModelError = ''"
          />
          <div class="purpose-toggle-group" role="group" :aria-label="t('新模型用途')">
            <button type="button" :class="{ active: newModelPurpose === 'image' }" :disabled="!!pending" @click="newModelPurpose = 'image'">{{ t('图像') }}</button>
            <button type="button" :class="{ active: newModelPurpose === 'text' }" :disabled="!!pending" @click="newModelPurpose = 'text'">{{ t('文本') }}</button>
            <button type="button" :class="{ active: newModelPurpose === 'both' }" :disabled="!!pending" @click="newModelPurpose = 'both'">{{ t('两者') }}</button>
          </div>
          <button type="button" :disabled="!!pending || !newModelId.trim()" @click="addManualModel">
            <Plus :size="15" />{{ t('添加') }}
          </button>
        </div>
        <p v-if="manualModelError" class="error-message provider-inline-error" role="alert">{{ t(manualModelError) }}</p>
        <div v-if="discoverSummary?.missingIds.length" class="provider-merge-banner" role="status">
          <span>{{ t('本次获取新增 {added} 个模型；原有 {missing} 个模型未出现在远程列表，已暂时保留。', { added: discoverSummary.added, missing: discoverSummary.missingIds.length }) }}</span>
          <button type="button" class="text-button" :disabled="!!pending" @click="removeMissingModels">
            {{ t('移除未返回模型') }}
          </button>
        </div>
        <p v-if="!draft.models.length" class="muted provider-empty-hint">
          {{ t('当前模型目录为空；请先点击「获取模型」或手动添加模型 ID，否则保存后无法在模型下拉框中使用。') }}
        </p>
        <ul v-else class="model-catalog">
          <li v-for="model in draft.models" :key="model.id" class="catalog-row">
            <strong class="catalog-model-id">
              {{ model.id }}
              <span v-if="discoverSummary?.missingIds.includes(model.id)" class="badge neutral">{{ t('未在远程返回') }}</span>
            </strong>
            <div class="catalog-purpose">
              <div class="purpose-toggle-group" role="group" :aria-label="t('{model} 用途', { model: model.id })">
                <button
                  type="button"
                  :aria-pressed="model.types.includes('text')"
                  :class="{ active: model.types.includes('text') }"
                  :disabled="!!pending"
                  @click="togglePurpose(model, 'text')"
                >{{ t('文本') }}</button>
                <button
                  type="button"
                  :aria-pressed="model.types.includes('image')"
                  :class="{ active: model.types.includes('image') }"
                  :disabled="!!pending"
                  @click="togglePurpose(model, 'image')"
                >{{ t('图像') }}</button>
              </div>
              <button
                type="button"
                class="icon-button"
                :aria-label="t('移除模型 {model}', { model: model.id })"
                :disabled="!!pending"
                @click="removeModel(model.id)"
              >
                <X :size="14" />
              </button>
            </div>
          </li>
        </ul>
      </section>
      <div v-if="confirmingRevokeShare" class="provider-warning-box" role="alertdialog">
        <TriangleAlert :size="15" aria-hidden="true" />
        <div class="provider-warning-copy">
          <p>{{ t('确认关闭共享？其他用户当前使用该供应商的排队中任务将被立即取消。') }}</p>
          <div class="dialog-discard-actions">
            <button type="button" :disabled="!!pending" @click="confirmingRevokeShare = false">{{ t('取消') }}</button>
            <button type="button" class="delete-confirm" :disabled="!!pending" @click="commitSave">{{ t('确认关闭并保存') }}</button>
          </div>
        </div>
      </div>
      <footer class="form-footer">
        <button type="button" :disabled="!!pending" @click="modalRef?.requestClose()">{{ t('取消') }}</button>
        <button type="submit" class="primary" :disabled="!!pending || needsKeyDecisionForNewUrl">
          <Save :size="16" />{{ t(pending === 'save' ? "保存中…" : provider ? "保存修改" : "保存供应商") }}
        </button>
      </footer>
    </form>
  </Modal>
</template>

<style scoped>
.provider-key-group { display: grid; gap: 8px; }
.provider-key-options { display: flex; flex-wrap: wrap; gap: 12px; }
.inline-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); cursor: pointer; margin: 0; }
.inline-check input { width: auto; min-height: auto; margin: 0; }
.provider-warning-box { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid #d6b46d; background: #fff6e3; color: #795016; font-size: 12px; line-height: 1.5; }
[data-theme="dark"] .provider-warning-box { border-color: #9b7a43; background: #3b3020; color: #f4d296; }
.provider-warning-box svg { flex: none; margin-top: 2px; }
.provider-warning-copy { display: grid; gap: 8px; min-width: 0; }
.provider-warning-copy p { margin: 0; color: inherit; }
.provider-inline-warn { margin: 4px 0 0; font-size: 12px; color: var(--danger); }
.provider-inline-error { margin: 4px 0 0; font-size: 12px; }
.provider-empty-hint { margin: 8px 0 0; font-size: 12px; }
.manual-model-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.manual-model-row > input { flex: 1 1 180px; min-width: 0; height: 34px; padding: 6px 10px; font-size: 13px; }
.manual-model-row > button { height: 34px; min-height: 34px; padding: 0 10px; }
.purpose-toggle-group { display: inline-flex; border: 1px solid var(--line-strong); border-radius: 8px; overflow: hidden; flex: none; }
.purpose-toggle-group > button { border: 0; border-radius: 0; min-height: 28px; height: 28px; padding: 0 9px; font-size: 12px; background: transparent; color: var(--muted); box-shadow: none; }
.purpose-toggle-group > button + button { border-left: 1px solid var(--line); }
.purpose-toggle-group > button.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.provider-merge-banner { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: var(--field); border: 1px solid var(--line); font-size: 12px; color: var(--ink); flex-wrap: wrap; }
.catalog-model-id { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
</style>
