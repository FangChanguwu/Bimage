<script setup lang="ts">
import { computed } from "vue";
import SelectControl from "./SelectControl.vue";
import { t } from "../i18n";
import type { Provider } from "../types";
const props = defineProps<{
  providers: Provider[];
  kind: string;
  providerId?: string;
  model?: string;
  label: string;
}>();
const emit = defineEmits<{ change: [providerId: string, model: string] }>();
const value = computed(() =>
  props.providerId && props.model
    ? JSON.stringify([props.providerId, props.model])
    : "",
);
const items = computed(() =>
  props.providers.flatMap((p) =>
    (p.models || [])
      .filter((m) => m.types.includes(props.kind))
      .map((m) => ({
        value: JSON.stringify([p.id, m.id]),
        label: m.id,
        secondary: p.name,
      })),
  ),
);
const staleOption = computed(() => {
  if (!value.value || items.value.some((i) => i.value === value.value)) return null;
  const provider = props.providers.find((p) => p.id === props.providerId);
  let secondary = t('历史模型');
  if (!provider) {
    secondary = t('供应商已不可用');
  } else if ((provider.models || []).some((m) => m.id === props.model)) {
    secondary = t('模型用途不匹配');
  } else {
    secondary = t('模型已不在目录中');
  }
  return { value: value.value, label: props.model || '', secondary };
});
const options = computed(() => {
  const base = [{ value: '', label: items.value.length ? t('选择模型') : t('暂无可用模型') }, ...items.value];
  if (staleOption.value) base.push(staleOption.value);
  return base;
});
function change(v: string) {
  if (v) {
    const [p, m] = JSON.parse(v);
    emit("change", p, m);
  } else emit("change", "", "");
}
</script>
<template>
  <SelectControl :label="label" :model-value="value" :options="options" @update:model-value="change" />
</template>
