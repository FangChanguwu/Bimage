<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { t } from '../i18n';
import { Plus } from 'lucide-vue-next';
import Modal from './Modal.vue';
import SelectControl from './SelectControl.vue';
import type { Account, AccountDirectory, AccountRole, Api } from '../types';

const props = defineProps<{ api: Api }>();
const emit = defineEmits<{ created: [] }>();
const directory = ref<AccountDirectory>();
const loading = ref(false), loadError = ref('');
const creating = ref(false), saving = ref(false), createError = ref('');
const email = ref(''), name = ref(''), password = ref(''), role = ref<AccountRole>('user'), concurrency = ref('1');
const roles = computed(() => [{ value: 'user', label: t('用户') }, { value: 'admin', label: t('管理员') }]);
const limits = Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));

async function load() {
  if (loading.value) return;
  loadError.value = '';
  loading.value = true;
  try {
    directory.value = await props.api<AccountDirectory>('/admin/users');
  } catch (error) {
    if ((error as Error).name !== 'AbortError') loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function open() {
  email.value = name.value = password.value = createError.value = '';
  role.value = 'user';
  concurrency.value = '1';
  creating.value = true;
}
function close() {
  password.value = '';
  creating.value = false;
}
async function create() {
  if (saving.value || !directory.value) return;
  const previous = directory.value;
  createError.value = '';
  saving.value = true;
  try {
    const account = await props.api<Account>('/admin/users', {
      email: email.value.trim(), password: password.value, name: name.value.trim(), role: role.value,
      concurrency: Number(concurrency.value),
    });
    directory.value = {
      users: [...previous.users, account],
    };
    close();
    emit('created');
  } catch (error) {
    if ((error as Error).name !== 'AbortError') createError.value = (error as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="account-settings">
    <section class="panel settings-section" aria-labelledby="accounts-heading">
      <div class="section-head">
        <h2 id="accounts-heading">{{ t('用户列表') }} <span v-if="directory" class="account-count">{{ t('{count} 位', { count: directory.users.length }) }}</span></h2>
        <button type="button" class="primary" :disabled="!directory" @click="open"><Plus :size="16" aria-hidden="true" />{{ t('创建用户') }}</button>
      </div>
      <p class="muted">{{ t('为用户分配登录账号与同时处理的图像请求数。') }}</p>
      <p v-if="loading" class="muted" role="status">{{ t('正在加载用户…') }}</p>
      <div v-else-if="loadError" class="account-load-error">
        <p class="error-message" role="alert">{{ t(loadError) }}</p>
        <button type="button" @click="load">{{ t('重试') }}</button>
      </div>
      <ul v-else-if="directory?.users.length" class="account-list">
        <li v-for="user in directory.users" :key="user.id" class="account-row">
          <div class="account-info">
            <strong v-if="user.name && user.name !== user.email">{{ user.name }}</strong>
            <span :class="{ muted: user.name && user.name !== user.email }">{{ user.email }}</span>
          </div>
          <div class="account-details">
            <span class="badge" :class="{ neutral: user.role !== 'admin' }">{{ t(user.role === 'admin' ? '管理员' : '用户') }}</span>
            <span class="account-limit">{{ t('并发上限 {count}', { count: user.concurrency }) }}</span>
          </div>
        </li>
      </ul>
      <p v-else class="muted">{{ t('尚无用户。') }}</p>
    </section>
    <Modal v-if="creating" :title="t('创建用户')" :locked="saving" @close="close">
      <form class="account-form" :aria-busy="saving" @submit.prevent="create" @input="createError = ''">
        <fieldset :disabled="saving">
          <label>{{ t('邮箱') }}<input v-model="email" name="email" type="email" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="254" required autofocus /></label>
          <label>{{ t('密码') }}<input v-model="password" name="new-password" type="password" autocomplete="new-password" minlength="5" required aria-describedby="account-password-hint" /></label>
          <small class="account-hint" id="account-password-hint">{{ t('至少 5 个字符。') }}</small>
          <label>{{ t('用户名（可选）') }}<input v-model="name" name="name" autocomplete="off" maxlength="100" /></label>
          <div class="account-field-grid">
            <div class="account-field">
              <span aria-hidden="true">{{ t('角色') }}</span>
              <SelectControl :model-value="role" :options="roles" :label="t('角色')" :disabled="saving" @update:model-value="role = $event === 'admin' ? 'admin' : 'user'; createError = ''" />
            </div>
            <div class="account-field">
              <span aria-hidden="true">{{ t('并发上限') }}</span>
              <SelectControl v-model="concurrency" :options="limits" :label="t('并发上限')" :disabled="saving" @update:model-value="createError = ''" />
            </div>
          </div>
          <small class="account-hint">{{ t('可同时执行的图像请求数，范围为 1–8。') }}</small>
          <p v-if="createError" class="error-message" role="alert">{{ t(createError) }}</p>
          <footer class="form-footer">
            <button type="button" @click="close">{{ t('取消') }}</button>
            <button type="submit" class="primary">{{ t(saving ? '正在创建…' : '创建用户') }}</button>
          </footer>
        </fieldset>
      </form>
    </Modal>
  </div>
</template>

<style scoped>
.account-settings { display: grid; gap: 18px; }
.account-count { margin-inline-start: 7px; color: var(--muted); font-size: 12px; font-weight: 500; }
.account-list { margin: 0; padding: 0; list-style: none; }
.account-row { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px 18px; border-top: 1px solid var(--line); padding: 14px 0; }
.account-row:last-child { padding-bottom: 0; }
.account-info { display: grid; gap: 2px; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
.account-details { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; }
.account-limit { min-width: 6em; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.account-load-error { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.account-form fieldset { min-width: 0; padding: 0; margin: 0; border: 0; }
.account-form label { margin: 0 0 13px; }
.account-field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.account-field { display: grid; gap: 7px; min-width: 0; font-size: 12px; font-weight: 550; }
.account-hint { display: block; margin: -5px 0 13px; }
.account-field-grid + .account-hint { margin-top: 6px; }
.account-form .error-message { margin-top: 12px; font-size: 13px; overflow-wrap: anywhere; }
.account-form .form-footer { margin-top: 18px; padding-top: 14px; }
@media (max-width: 560px) {
  .account-row { align-items: flex-start; flex-direction: column; }
}
</style>
