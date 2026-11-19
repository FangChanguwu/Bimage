<script setup lang="ts">
import { ref } from "vue";
import { Search, Save } from "lucide-vue-next";
import SelectControl from "./SelectControl.vue";
import type { ProviderDraft, Provider, Model, Api, Run } from "../types";
const props = defineProps<{
  provider?: Provider;
  admin: boolean;
  api: Api;
  run: Run;
}>();
const emit = defineEmits<{ saved: []; cancel: [] }>();
const draft = ref<ProviderDraft>({
  id: props.provider?.id,
  name: props.provider?.name || "",
  baseUrl: props.provider?.baseUrl || "",
  apiKey: "",
  models: JSON.parse(JSON.stringify(props.provider?.models || [])),
  allowPrivate: !!props.provider?.allowPrivate,
  shared: !!props.provider?.shared,
  kind: "mixed",
});
const busy = ref(false);
async function discover() {
  if (busy.value) return;
  busy.value = true;
  try {
    await props.run(async () => {
      const out = await props.api<{ data: Model[] }>(
        "/providers" + (draft.value.id ? "/" + draft.value.id : "") + "/models",
        draft.value,
      );
      draft.value.models = out.data;
    }, "模型目录已获取，可手动调整用途");
  } finally {
    busy.value = false;
  }
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  try {
    await props.run(async () => {
      await props.api(
        "/providers" + (draft.value.id ? "/" + draft.value.id : ""),
        draft.value,
        draft.value.id ? "PATCH" : "POST",
      );
      draft.value.apiKey = "";
      await props.api("/providers");
      emit("saved");
    }, "供应商已保存");
  } finally {
    busy.value = false;
  }
}
function classify(model: Model, value: string) {
  model.types = value
    .split(",")
    .filter(Boolean);
  model.reason = "手动指定用途";
}
</script>
<template>
  <form class="provider-form" @submit.prevent="save">
    <div class="field-grid">
      <label
        >名称<input
          v-model="draft.name"
          name="name"
          required
          placeholder="例如：我的图像服务" /></label
      ><label
        >Base URL<input
          v-model="draft.baseUrl"
          name="baseUrl"
          type="url"
          required
          placeholder="https://api.example.com/v1"
      /></label>
    </div>
    <label
      >{{ provider ? "新 API Key（留空保持原值）" : "API Key"
      }}<input
        v-model="draft.apiKey"
        name="apiKey"
        type="password"
        autocomplete="new-password"
        placeholder="仅发送到自己的后端保存"
    /></label>
    <div class="switch-row">
      <div>
        <strong>开放 / 共享</strong
        ><small>允许其他访问密钥使用，不会暴露密钥或地址。</small>
      </div>
      <button
        type="button"
        class="switch"
        role="switch"
        aria-label="开放共享供应商"
        :aria-checked="draft.shared"
        @click="draft.shared = !draft.shared"
      >
        <span />
      </button>
    </div>
    <details v-if="admin">
      <summary>高级配置</summary>
      <label class="check"
        ><input
          v-model="draft.allowPrivate"
          type="checkbox"
          name="allowPrivate"
        />允许访问私网地址（仅用于可信服务）</label
      >
    </details>
    <button type="button" :disabled="busy || !draft.baseUrl" @click="discover">
      <Search :size="16" />{{ busy ? "处理中…" : "获取模型" }}
    </button>
    <div v-if="draft.models.length" class="model-catalog">
      <div v-for="model in draft.models" :key="model.id" class="catalog-row">
        <div>
          <strong>{{ model.id }}</strong
          ><small>{{ model.reason || "可手动指定用途" }}</small>
        </div>
        <SelectControl
          :label="model.id + ' 用途'"
          :model-value="model.types.join(',')"
          :options="[{value:'',label:'未知 · 指定用途'}, {value:'image',label:'图像'}, {value:'text',label:'文本'}, {value:'image,text',label:'图像 + 文本'}]"
          @update:model-value="classify(model, $event)"
        />
      </div>
    </div>
    <footer class="form-footer">
      <button v-if="provider" type="button" @click="emit('cancel')">取消</button
      ><button class="primary" :disabled="busy">
        <Save :size="16" />{{ provider ? "保存修改" : "保存供应商" }}
      </button>
    </footer>
  </form>
</template>
