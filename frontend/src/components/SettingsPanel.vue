<script setup lang="ts">
import { ref } from "vue";
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
}>();
const tab = ref("providers"),
  adding = ref(false),
  editing = ref<Provider | null>(null),
  deleting = ref<Provider | null>(null),
  defaults = ref(modelDefaults()),
  savingDefaults = ref(false),
  defaultsStatus = ref("");
function modelDefaults() {
  const effective = resolveTextDefaults(props.providers, props.settings);
  return { quickProvider: effective.quickProvider, quickModel: effective.quickModel,
    textProvider: effective.textProvider, textModel: effective.textModel,
    imageProvider: effective.imageProvider, imageModel: effective.imageModel };
}
function closeEditor() {
  adding.value = false;
  editing.value = null;
}
async function saveDefaults() {
  if (savingDefaults.value) return;
  savingDefaults.value = true;
  defaultsStatus.value = "默认模型保存中…";
  let saved = false;
  try {
    await props.run(async () => {
      // The editor owns model choices only. Drafts and other settings may have
      // changed since mount: never write a captured whole-settings snapshot.
      await props.api("/settings", { ...props.settings, ...defaults.value }, "PUT");
      const result = await props.api<Settings>("/settings");
      emit("settings", result);
      saved = true;
    }, "默认模型已保存");
  } finally {
    savingDefaults.value = false;
    defaultsStatus.value = saved ? "默认模型已保存" : "默认模型保存失败，请重试";
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
      @click="tab = item.id"
    >
      {{ t(item.label) }}
    </button>
  </div>
  <div v-if="tab === 'providers'" class="provider-settings">
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
          @change="(p, m) => { defaults.quickProvider = p; defaults.quickModel = m; }"
        /></label>
        <label>{{ t('提示词优化') }}<ModelSelect
          :providers="providers" kind="text" :label="t('提示词优化')"
          :provider-id="defaults.textProvider" :model="defaults.textModel"
          @change="(p, m) => { defaults.textProvider = p; defaults.textModel = m; }"
        /></label>
        <label>{{ t('生图模型') }}<ModelSelect
          :providers="providers" kind="image" :label="t('生图模型')"
          :provider-id="defaults.imageProvider" :model="defaults.imageModel"
          @change="(p, m) => { defaults.imageProvider = p; defaults.imageModel = m; }"
        /></label>
      </fieldset>
      <footer class="form-footer">
        <span role="status" aria-live="polite" aria-atomic="true" class="muted">{{ t(defaultsStatus) }}</span>
        <button type="button" class="primary" :disabled="savingDefaults" @click="saveDefaults">{{ t(savingDefaults ? '保存中…' : '保存默认模型') }}</button>
      </footer>
    </section>
  </div>
  <section v-if="tab === 'cache'" class="panel settings-section">
    <ImageCacheSettings :signal="signal" @cleared="emit('cleared')" />
  </section>
  <SiteSettings
    v-if="tab === 'site' && identity.role === 'admin'"
    :site="site"
    :api="api"
    :run="run"
    @saved="(s) => emit('site', s)"
  />
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
