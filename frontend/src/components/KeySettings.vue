<script setup lang="ts">
import { ref, onMounted } from "vue";
import { KeyRound, Eye, EyeOff } from "lucide-vue-next";
import Modal from "./Modal.vue";
import type { Identity, Api, Run } from "../types";
const props = defineProps<{ identity: Identity; api: Api; run: Run }>();
const emit = defineEmits<{ csrf: [token: string] }>();
const keys = ref<Identity[]>([]),
  newKey = ref(""),
  name = ref(""),
  expires = ref(""),
  rotating = ref(false),
  current = ref(""),
  next = ref(""),
  repeat = ref(""),
  show = ref(false),
  busy = ref(false),
  confirm = ref<{ message: string; action: () => Promise<void> } | null>(null);
async function refresh() {
  keys.value = await props.api<Identity[]>("/admin/keys");
}
onMounted(() => props.run(refresh));
async function create() {
  if (busy.value) return;
  busy.value = true;
  try {
    await props.run(async () => {
      const result = await props.api<{ key: string }>("/admin/keys", {
        name: name.value,
        role: "user",
        expires: expires.value ? new Date(expires.value).toISOString() : null,
      });
      newKey.value = result.key;
      name.value = "";
      expires.value = "";
      await refresh();
    });
  } finally {
    busy.value = false;
  }
}
function closeRotation() {
  rotating.value = false;
  current.value = "";
  next.value = "";
  repeat.value = "";
  show.value = false;
}
async function rotate() {
  if (busy.value) return;
  busy.value = true;
  try {
    await props.run(async () => {
      const result = await props.api<{ csrf: string }>("/admin/rotate-key", {
        currentKey: current.value,
        newKey: next.value,
        confirmKey: repeat.value,
        confirm: true,
      });
      emit("csrf", result.csrf);
      await refresh();
      closeRotation();
    }, "管理员密钥已修改，当前会话已更新");
  } finally {
    busy.value = false;
  }
}
async function execute() {
  const action = confirm.value?.action;
  confirm.value = null;
  if (action) await props.run(action);
}
</script>
<template>
  <section class="panel settings-section">
    <div class="section-head">
      <h2>访问密钥</h2>
      <KeyRound :size="19" />
    </div>
    <p class="muted">管理员仅有一个。普通成员的配置和历史按访问密钥隔离。</p>
    <button @click="rotating = true">修改管理员密钥</button>
    <form class="key-create" @submit.prevent="create">
      <h3>创建普通成员密钥</h3>
      <div class="field-grid">
        <label>名称<input v-model="name" name="name" required /></label
        ><label
          >过期时间（可选）<input
            v-model="expires"
            name="expires"
            type="datetime-local"
        /></label>
      </div>
      <button :disabled="busy">创建访问密钥</button>
    </form>
    <div v-if="newKey" class="one-time-key">
      <strong>仅此一次显示，请私密保存</strong
      ><code class="secret">{{ newKey }}</code
      ><button @click="newKey = ''">隐藏</button>
    </div>
    <div class="key-list">
      <div v-for="key in keys" :key="key.id" class="key-row">
        <div>
          <strong>{{ key.name }}</strong
          ><small>{{
            key.role === "admin"
              ? "唯一管理员"
              : key.disabled
                ? "已禁用"
                : "普通成员 · 有效"
          }}</small
          ><small>{{
            key.expires ? new Date(key.expires).toLocaleString() : "不过期"
          }}</small>
        </div>
        <div
          v-if="key.role !== 'admin' && key.id !== identity.id"
          class="actions"
        >
          <button
            @click="
              run(async () => {
                await api(
                  '/admin/keys/' + key.id,
                  { disabled: !key.disabled },
                  'PATCH',
                );
                await refresh();
              })
            "
          >
            {{ key.disabled ? "启用" : "禁用" }}</button
          ><button
            class="danger-text"
            @click="
              confirm = {
                message: '永久删除此访问密钥？其会话将立即失效。',
                action: async () => {
                  await api('/admin/keys/' + key.id, {}, 'DELETE');
                  await refresh();
                },
              }
            "
          >
            删除
          </button>
        </div>
      </div>
    </div>
  </section>
  <Modal v-if="rotating" title="修改管理员密钥" @close="closeRotation"
    ><p class="muted">
      新密钥为 16–256
      字符，不含控制字符，不会去除首尾空格。旧密钥及其他管理员会话将立即失效，历史与供应商不变。
    </p>
    <label
      >当前管理员密钥<input
        v-model="current"
        aria-label="当前管理员密钥"
        :type="show ? 'text' : 'password'"
        autocomplete="current-password" /></label
    ><label
      >新管理员密钥<input
        v-model="next"
        aria-label="新管理员密钥"
        :type="show ? 'text' : 'password'"
        autocomplete="new-password" /></label
    ><label
      >确认新密钥<input
        v-model="repeat"
        aria-label="确认新密钥"
        :type="show ? 'text' : 'password'"
        autocomplete="new-password" /></label
    ><button aria-label="显示或隐藏密钥" @click="show = !show">
      <EyeOff v-if="show" :size="16" /><Eye v-else :size="16" />{{
        show ? "隐藏密钥" : "显示密钥"
      }}
    </button>
    <footer class="form-footer">
      <button @click="closeRotation">取消</button
      ><button
        class="primary"
        :disabled="
          busy ||
          !current ||
          next.length < 16 ||
          next.length > 256 ||
          next !== repeat ||
          next === current ||
          /[\u0000-\u001F\u007F]/.test(next)
        "
        @click="
          confirm = {
            message:
              '旧密钥及其他会话将立即失效。请先私密保存新密钥，确定修改？',
            action: rotate,
          }
        "
      >
        修改密钥
      </button>
    </footer></Modal
  ><Modal v-if="confirm" title="请确认" @close="confirm = null"
    ><p>{{ confirm.message }}</p>
    <footer class="form-footer">
      <button @click="confirm = null">取消</button
      ><button class="primary" @click="execute">确认</button>
    </footer></Modal
  >
</template>
