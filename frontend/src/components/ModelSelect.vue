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
function change(v: string) {
  if (v) {
    const [p, m] = JSON.parse(v);
    emit("change", p, m);
  } else emit("change", "", "");
}
</script>
<template>
  <SelectControl :label="label" :model-value="value"
    :options="[{ value: '', label: t('选择模型') }, ...items, ...(value && !items.some(i => i.value === value) ? [{ value, label: model || '', secondary: t('历史模型') }] : [])]"
    @update:model-value="change" />
</template>
