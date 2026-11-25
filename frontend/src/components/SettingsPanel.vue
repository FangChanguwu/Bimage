<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { t } from '../i18n';
import { resolveTextDefaults } from "../composables/textDefaults";
import { Plus, Server, LockKeyhole } from "lucide-vue-next";
import ProviderEditor from "./ProviderEditor.vue";
import ModelSelect from "./ModelSelect.vue";
import SiteSettings from "./SiteSettings.vue";
import ImageCacheSettings from "./ImageCacheSettings.vue";
import Modal from "./Modal.vue";
import type { Provider, Settings, Site, Identity, Api, Run } from "../types";
const props = defineProps<{
  providers: Provider[];
  settings: Settings;
  site: Site;
  identity: Identity;
  api: Api;
  run: Run;
  signal: AbortSignal;
}>();
const emit = defineEmits<{
  refresh: [];
  settings: [settings: Settings];
  site: [site: Site];
  cleared: [];
  'cache-error': [message: string];
  'dirty-change': [dirty: boolean];
}>();
const tab = ref("providers"),
  pendingTab = ref<string | null>(null),
  adding = ref(false),
  editing = ref<Provider | null>(null),
  deleting = ref<Provider | null>(null),
  defaults = ref(modelDefaults()),
  savedDefaults = ref({ ...defaults.value }),
  savingDefaults = ref(false),
  defaultsSavedOnce = ref(false),
  defaultsError = ref(""),
  siteDirty = ref(false);

function modelDefaults() {
  const effective = resolveTextDefaults(props.providers, props.settings);
  return { quickProvider: effective.quickProvider || "", quickModel: effective.quickModel || "",
    textProvider: effective.textProvider || "", textModel: effective.textModel || "",
    imageProvider: effective.imageProvider || "", imageModel: effective.imageModel || "" };
}

const defaultsDirty = computed(
  () => JSON.stringify(defaults.value) !== JSON.stringify(savedDefaults.value),
);
const anyDirty = computed(() => defaultsDirty.value || siteDirty.value);
watch(anyDirty, (val) => emit("dirty-change", val), { immediate: true });

function isModelAvailable(providerId: string | undefined, model: string | undefined, kind: "text" | "image"): boolean {
  if (!providerId && !model) return true;
  if (!providerId || !model) return false;
  const provider = props.providers.find((p) => p.id === providerId);
  return Boolean(provider?.models?.some((m) => m.id === model && m.types.includes(kind)));
}

const invalidDefaults = computed(() => {
  const issues: string[] = [];
  if (!isModelAvailable(defaults.value.quickProvider, defaults.value.quickModel, "text")) issues.push(t("快速提示词"));
  if (!isModelAvailable(defaults.value.textProvider, defaults.value.textModel, "text")) issues.push(t("提示词优化"));
  if (!isModelAvailable(defaults.value.imageProvider, defaults.value.imageModel, "image")) issues.push(t("生图模型"));
  return issues;
});

const defaultsStatusText = computed(() => {
  if (savingDefaults.value) return t("默认模型保存中…");
  if (defaultsError.value) return t(defaultsError.value);
  if (defaultsDirty.value) return t("有未保存的更改");
  if (defaultsSavedOnce.value) return t("默认模型已保存");
  return "";
});

watch(
  () => [props.providers, props.settings],
  () => {
    const wasDirty = defaultsDirty.value;
    const nextClean = modelDefaults();
    savedDefaults.value = { ...nextClean };
    if (!wasDirty) {
      defaults.value = { ...nextClean };
    }
  },
  { deep: true },
);

function updateDefault(
  field: "quick" | "text" | "image",
  providerId: string,
  model: string,
) {
  defaultsError.value = "";
  if (field === "quick") {
    defaults.value.quickProvider = providerId;
    defaults.value.quickModel = model;
  } else if (field === "text") {
    defaults.value.textProvider = providerId;
    defaults.value.textModel = model;
  } else {
    defaults.value.imageProvider = providerId;
    defaults.value.imageModel = model;
  }
}

function switchTab(next: string) {
  if (next === tab.value) return;
  const leavingDirtySite = tab.value === "site" && siteDirty.value;
  const leavingDirtyProviders = tab.value === "providers" && defaultsDirty.value;
  if (leavingDirtySite || leavingDirtyProviders) {
    pendingTab.value = next;
    return;
  }
  tab.value = next;
}

function confirmTabSwitch() {
  if (!pendingTab.value) return;
  if (tab.value === "providers") {
    defaults.value = { ...savedDefaults.value };
    defaultsError.value = "";
  }
  if (tab.value === "site") {
    siteDirty.value = false;
  }
  tab.value = pendingTab.value;
  pendingTab.value = null;
}

function closeEditor() {
  adding.value = false;
  editing.value = null;
}
async function saveDefaults() {
  if (savingDefaults.value || invalidDefaults.value.length) return;
  savingDefaults.value = true;
  defaultsError.value = "";
  let saved = false;
  try {
    await props.run(async () => {
      // The editor owns model choices only. Drafts and other settings may have
      // changed since mount: never write a captured whole-settings snapshot.
      await props.api("/settings", { ...props.settings, ...defaults.value }, "PUT");
      const result = await props.api<Settings>("/settings");
      savedDefaults.value = { ...defaults.value };
      defaultsSavedOnce.value = true;
      emit("settings", result);
      saved = true;
    }, "默认模型已保存");
  } finally {
    savingDefaults.value = false;
    if (!saved) defaultsError.value = "默认模型保存失败，请重试";
  }
}
async function remove() {
  const p = deleting.value;
  deleting.value = null;
  if (p)
    await props.run(async () => {
      await props.api("/providers/" + p.id, {}, "DELETE");
      await props.api("/providers");
      emit("refresh");
    }, "供应商已删除，已有历史保留");
}
</script>
<template>
  <div class="settings-view">
  <div class="settings-tabs" role="tablist" :aria-label="t('设置分类')">
    <button
      v-for="item in [
        { id: 'providers', label: '供应商' },
        { id: 'cache', label: '本地缓存' },
        ...(identity.role === 'admin' ? [{ id: 'site', label: '站点样式' }] : []),
      ]"
      :key="item.id"
      role="tab"
      :aria-selected="tab === item.id"
      :class="{ selected: tab === item.id }"
      @click="switchTab(item.id)"
    >
      {{ t(item.label) }}
    </button>
  </div>
  <Transition name="tab-switch" mode="out-in">
  <div v-if="tab === 'providers'" key="providers" class="provider-settings">
    <section class="panel settings-section">
      <div class="section-head">
        <h2>{{ t('已连接的供应商') }}</h2>
        <button class="primary" @click="adding = true">
          <Plus :size="16" />{{ t('添加供应商') }}
        </button>
      </div>

      <div v-if="!providers.length" class="inline-empty">
        <Server :size="28" />
        <p>{{ t('连接一个供应商，开始创作。') }}</p>
      </div>
      <div
        v-for="provider in providers"
        :key="provider.id"
        class="provider-row"
      >
        <div class="provider-info">
          <div class="provider-title">
            <strong>{{ provider.name }}</strong
            ><span v-if="provider.shared" class="badge">{{ t('共享') }}</span
            ><span v-if="!provider.canManage" class="badge neutral"
              >{{ t('只读目录') }}</span
            >
          </div>
          <p v-if="provider.canManage && provider.baseUrl">{{ provider.baseUrl }}</p>
          <small
            >{{ t('{count} 个模型', { count: provider.models?.length || 0 }) }} ·
            {{
              t(provider.canManage
                ? provider.hasKey ? "密钥已保存" : "无密钥"
                : "由所有者管理")
            }}</small
          >
        </div>
        <div v-if="provider.canManage" class="actions">
          <button @click="editing = provider">{{ t('编辑') }}</button
          ><button class="danger-text" @click="deleting = provider">
            {{ t('删除') }}
          </button>
        </div>
        <LockKeyhole v-else :size="18" class="muted" />
      </div>
    </section>
    <section class="panel settings-section" aria-labelledby="model-defaults-title" :aria-busy="savingDefaults">
      <h2 id="model-defaults-title">{{ t('默认模型') }}</h2>
      <p class="muted">{{ t('分别选择快速提示词、提示词优化和生图使用的模型。不会更改当前创作草稿。') }}</p>
      <fieldset class="defaults-fields" :disabled="savingDefaults">
        <label>{{ t('快速提示词') }}<ModelSelect
          :providers="providers" kind="text" :label="t('快速提示词')"
          :provider-id="defaults.quickProvider" :model="defaults.quickModel"
          @change="(p, m) => updateDefault('quick', p, m)"
        /></label>
        <label>{{ t('提示词优化') }}<ModelSelect
          :providers="providers" kind="text" :label="t('提示词优化')"
          :provider-id="defaults.textProvider" :model="defaults.textModel"
          @change="(p, m) => updateDefault('text', p, m)"
        /></label>
        <label>{{ t('生图模型') }}<ModelSelect
          :providers="providers" kind="image" :label="t('生图模型')"
          :provider-id="defaults.imageProvider" :model="defaults.imageModel"
          @change="(p, m) => updateDefault('image', p, m)"
        /></label>
      </fieldset>
      <p v-if="invalidDefaults.length" class="error-message" role="alert">
        {{ t('以下默认模型已不可用或用途不匹配，请重新选择或清空后再保存：{fields}', { fields: invalidDefaults.join('、') }) }}
      </p>
      <footer class="form-footer">
        <span role="status" aria-live="polite" aria-atomic="true" :class="defaultsError ? 'error-message' : 'muted'">{{ defaultsStatusText }}</span>
        <button type="button" class="primary" :disabled="savingDefaults || invalidDefaults.length > 0" @click="saveDefaults">{{ t(savingDefaults ? '保存中…' : '保存默认模型') }}</button>
      </footer>
    </section>
  </div>
  <section v-else-if="tab === 'cache'" key="cache" class="panel settings-section">
    <ImageCacheSettings :signal="signal" @cleared="emit('cleared')" @error="(m) => emit('cache-error', m)" />
  </section>
  <SiteSettings
    v-else-if="tab === 'site' && identity.role === 'admin'"
    key="site"
    :site="site"
    :api="api"
    :run="run"
    @saved="(s) => emit('site', s)"
    @dirty-change="(d) => (siteDirty = d)"
  />
  </Transition>
  <ProviderEditor
    v-if="adding || editing"
    :key="editing?.id || 'new'"
    :provider="editing || undefined"
    :api="api"
    :run="run"
    @saved="closeEditor(); emit('refresh')"
    @cancel="closeEditor"
  />
  <Modal v-if="deleting" :title="t('删除供应商')" @close="deleting = null"
    ><p>{{ t('删除 {name}？已有历史保留，待执行任务将无法继续使用这个供应商。', { name: deleting.name }) }}</p>
    <footer class="form-footer">
      <button @click="deleting = null">{{ t('取消') }}</button
      ><button class="primary" @click="remove">{{ t('确认删除') }}</button>
    </footer></Modal
  >
  <Modal v-if="pendingTab" :title="t('放弃未保存的更改？')" @close="pendingTab = null">
    <p>{{ t('当前设置标签页有未保存的更改，切换标签将丢失这些改动。确定放弃并切换吗？') }}</p>
    <footer class="form-footer">
      <button type="button" autofocus @click="pendingTab = null">{{ t('继续编辑') }}</button>
      <button type="button" class="delete-confirm" @click="confirmTabSwitch">{{ t('放弃并切换') }}</button>
    </footer>
  </Modal>
  </div>
</template>

<style scoped>
.provider-settings {
  display: grid;
  gap: 24px;
}
.defaults-fields {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
</style>
