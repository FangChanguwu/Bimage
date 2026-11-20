<script setup lang="ts">
import { ref, useId } from "vue";
import { Search, Save } from "lucide-vue-next";
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
const draft = ref<ProviderDraft>({
  id: props.provider?.id,
  name: props.provider?.name || "",
  baseUrl: props.provider?.baseUrl || "",
  apiKey: "",
  models: (props.provider?.models ?? []).map(withDefaultPurpose),
  shared: !!props.provider?.shared,
  kind: "mixed",
});
const pending = ref<"discover" | "save" | null>(null);

function withDefaultPurpose(model: Model): Model {
  const types = model.types.filter((type) => type === "image" || type === "text");
  return { ...model, types: types.length ? types : ["text"] };
}
function setPurpose(model: Model) {
  model.types = [model.types.includes("image") ? "text" : "image"];
  model.reason = manualReason;
}
async function discover() {
  if (pending.value) return;
  pending.value = "discover";
  try {
    await props.run(async () => {
      const out = await props.api<{ data: Model[] }>(
        "/providers" + (draft.value.id ? "/" + draft.value.id : "") + "/models",
        draft.value,
      );
      const previous = new Map(draft.value.models.map((model) => [model.id, model]));
      draft.value.models = out.data.map((model) => {
        const existing = previous.get(model.id);
        // A legacy model can have both uses. Display it as image, but only
        // replace that classification when the user actually flips the switch.
        if (existing && (existing.reason === manualReason || existing.types.length === 2)) return existing;
        return { ...model, types: [model.types.includes("image") ? "image" : "text"] };
      });
    }, "模型目录已获取");
  } finally {
    pending.value = null;
  }
}
async function save() {
  if (pending.value) return;
  pending.value = "save";
  try {
    await props.run(async () => {
      await props.api(
        "/providers" + (draft.value.id ? "/" + draft.value.id : ""),
        draft.value,
        draft.value.id ? "PATCH" : "POST",
      );
      draft.value.apiKey = "";
      emit("saved");
    }, "供应商已保存");
  } finally {
    pending.value = null;
  }
}
</script>

<template>
  <Modal :title="provider ? '编辑供应商' : '添加供应商'" :locked="!!pending" @close="emit('cancel')">
    <form class="provider-form" @submit.prevent="save">
      <div class="field-grid">
        <label>
          名称
          <input v-model="draft.name" name="name" required maxlength="100" :disabled="!!pending" placeholder="例如：我的图像服务" />
        </label>
        <label>
          Base URL
          <input v-model="draft.baseUrl" name="baseUrl" type="url" required :disabled="!!pending" placeholder="https://api.example.com/v1" />
        </label>
      </div>
      <label>
        {{ provider ? "新 API Key（留空保持原值）" : "API Key" }}
        <input v-model="draft.apiKey" name="apiKey" type="password" autocomplete="new-password" :disabled="!!pending" placeholder="请输入API Key" />
      </label>
      <div class="switch-row">
        <div>
          <strong>开放 / 共享</strong>
          <small :id="`${labelId}-sharing`">设置为共享将让此供应商配置被所有用户可见并使用。</small>
        </div>
        <button
          type="button"
          class="switch"
          role="switch"
          aria-label="开放共享供应商"
          :aria-describedby="`${labelId}-sharing`"
          :aria-checked="draft.shared"
          :disabled="!!pending"
          @click="draft.shared = !draft.shared"
        ><span aria-hidden="true" /></button>
      </div>
      <section class="provider-models" :aria-labelledby="`${labelId}-catalog`">
        <div class="provider-models-head">
          <h3 :id="`${labelId}-catalog`">模型目录 <small v-if="draft.models.length">{{ draft.models.length }} 个</small></h3>
          <button type="button" :disabled="!!pending || !draft.baseUrl" @click="discover">
            <Search :size="16" />{{ pending === 'discover' ? "获取中…" : "获取模型" }}
          </button>
        </div>
        <ul v-if="draft.models.length" class="model-catalog">
          <li v-for="(model, index) in draft.models" :key="model.id" class="catalog-row">
            <strong>{{ model.id }}</strong>
            <div class="catalog-purpose">
              <span :id="`${labelId}-purpose-${index}`">{{ model.types.includes('image') ? '图像' : '文本' }}</span>
              <button
                type="button"
                class="switch"
                role="switch"
                :aria-label="`${model.id} 用途`"
                :aria-describedby="`${labelId}-purpose-${index}`"
                :aria-checked="model.types.includes('image')"
                :disabled="!!pending"
                @click="setPurpose(model)"
              ><span aria-hidden="true" /></button>
            </div>
          </li>
        </ul>
      </section>
      <footer class="form-footer">
        <button type="button" :disabled="!!pending" @click="emit('cancel')">取消</button>
        <button type="submit" class="primary" :disabled="!!pending">
          <Save :size="16" />{{ pending === 'save' ? "保存中…" : provider ? "保存修改" : "保存供应商" }}
        </button>
      </footer>
    </form>
  </Modal>
</template>
