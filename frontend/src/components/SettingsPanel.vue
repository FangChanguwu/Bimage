<script setup lang="ts">
import { ref } from "vue";
import { Plus, ExternalLink, Server, LockKeyhole } from "lucide-vue-next";
import ProviderEditor from "./ProviderEditor.vue";
import ModelSelect from "./ModelSelect.vue";
import SiteSettings from "./SiteSettings.vue";
import KeySettings from "./KeySettings.vue";
import Modal from "./Modal.vue";
import type { Provider, Settings, Site, Identity, Api, Run } from "../types";
const props = defineProps<{
  providers: Provider[];
  settings: Settings;
  site: Site;
  identity: Identity;
  api: Api;
  run: Run;
}>();
const emit = defineEmits<{
  refresh: [];
  settings: [settings: Settings];
  site: [site: Site];
  csrf: [token: string];
}>();
const tab = ref("providers"),
  adding = ref(false),
  editing = ref<Provider | null>(null),
  deleting = ref<Provider | null>(null),
  defaults = ref({ ...props.settings });
async function saveDefaults() {
  await props.run(async () => {
    await props.api("/settings", defaults.value, "PUT");
    const result = await props.api<Settings>("/settings");
    emit("settings", result);
  }, "默认模型已保存");
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
  <div class="settings-tabs" role="tablist" aria-label="设置分类">
    <button
      v-for="item in [
        { id: 'providers', label: '供应商' },
        { id: 'defaults', label: '默认模型' },
        ...(identity.role === 'admin'
          ? [
              { id: 'site', label: '站点样式' },
              { id: 'keys', label: '密钥' },
            ]
          : []),
      ]"
      :key="item.id"
      role="tab"
      :aria-selected="tab === item.id"
      :class="{ selected: tab === item.id }"
      @click="tab = item.id"
    >
      {{ item.label }}
    </button>
  </div>
  <div v-if="tab === 'providers'" class="provider-settings">
    <section class="panel settings-section">
      <div class="section-head">
        <h2>已连接的供应商</h2>
        <button class="primary" @click="adding = true">
          <Plus :size="16" />添加供应商
        </button>
      </div>
      <p class="muted">OpenAI-compatible API · API Key 仅保存在服务端。</p>
      <div v-if="!providers.length" class="inline-empty">
        <Server :size="28" />
        <p>连接一个供应商，开始创作。</p>
      </div>
      <div
        v-for="provider in providers"
        :key="provider.id"
        class="provider-row"
      >
        <div class="provider-info">
          <div class="provider-title">
            <strong>{{ provider.name }}</strong
            ><span v-if="provider.shared" class="badge">共享</span
            ><span v-if="!provider.canManage" class="badge neutral"
              >只读目录</span
            >
          </div>
          <p v-if="provider.baseUrl">{{ provider.baseUrl }}</p>
          <small
            >{{ provider.models?.length || 0 }} 个模型 ·
            {{
              provider.hasKey
                ? "密钥已保存"
                : provider.canManage
                  ? "无密钥"
                  : "由所有者管理"
            }}</small
          >
        </div>
        <div v-if="provider.canManage" class="actions">
          <button @click="editing = provider">编辑</button
          ><button class="danger-text" @click="deleting = provider">
            删除
          </button>
        </div>
        <LockKeyhole v-else :size="18" class="muted" />
      </div>
    </section>
    <p class="settings-note">
      <ExternalLink
        :size="15"
      />共享供应商仅提供固定配置的使用权；只有所有者或管理员能修改、刷新目录。
    </p>
  </div>
  <section v-if="tab === 'defaults'" class="panel settings-section">
    <h2>默认模型</h2>
    <p class="muted">从已连接和共享目录选择。用于新的创作和快速提示词。</p>
    <label
      >图像生成<ModelSelect
        :providers="providers"
        kind="image"
        :provider-id="defaults.imageProvider"
        :model="defaults.imageModel"
        label="默认图像模型"
        @change="
          (p, m) => {
            defaults.imageProvider = p;
            defaults.imageModel = m;
          }
        " /></label
    ><label
      >提示词优化<ModelSelect
        :providers="providers"
        kind="text"
        :provider-id="defaults.textProvider"
        :model="defaults.textModel"
        label="文本模型"
        @change="
          (p, m) => {
            defaults.textProvider = p;
            defaults.textModel = m;
          }
        "
    /></label>
    <footer class="form-footer">
      <button class="primary" @click="saveDefaults">保存默认模型</button>
    </footer>
  </section>
  <SiteSettings
    v-if="tab === 'site' && identity.role === 'admin'"
    :site="site"
    :api="api"
    :run="run"
    @saved="(s) => emit('site', s)"
  /><KeySettings
    v-if="tab === 'keys' && identity.role === 'admin'"
    :identity="identity"
    :api="api"
    :run="run"
    @csrf="(t) => emit('csrf', t)"
  /><Modal
    v-if="adding || editing"
    :title="editing ? '编辑供应商' : '添加供应商'"
    @close="
      adding = false;
      editing = null;
    "
    ><ProviderEditor
      :key="editing?.id || 'new'"
      :provider="editing || undefined"
      :admin="identity.role === 'admin'"
      :api="api"
      :run="run"
      @saved="
        adding = false;
        editing = null;
        emit('refresh');
      "
      @cancel="
        adding = false;
        editing = null;
      " /></Modal
  ><Modal v-if="deleting" title="删除供应商" @close="deleting = null"
    ><p>
      删除
      {{ deleting.name }}？已有历史保留，待执行任务将无法继续使用这个供应商。
    </p>
    <footer class="form-footer">
      <button @click="deleting = null">取消</button
      ><button class="primary" @click="remove">确认删除</button>
    </footer></Modal
  >
</template>
