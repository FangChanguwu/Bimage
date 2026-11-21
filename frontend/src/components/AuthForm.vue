<script setup lang="ts">
import { ref } from 'vue';
import { ArrowRight } from 'lucide-vue-next';
import { t } from '../i18n';

const props = defineProps<{ setup: boolean; hasSetupToken: boolean; pending: boolean; error: string }>();
const emit = defineEmits<{
  submit: [identifier: string, password: string];
  edit: [];
}>();
const identifier = ref(''), password = ref(''), repeat = ref(''), validation = ref('');

function edited() {
  validation.value = '';
  emit('edit');
}
function submit() {
  if (props.pending || (props.setup && !props.hasSetupToken)) return;
  edited();
  if (!identifier.value.trim()) {
    validation.value = '请输入邮箱';
    return;
  }
  if (props.setup && password.value !== repeat.value) {
    validation.value = '两次输入的密码不一致';
    return;
  }
  emit('submit', identifier.value.trim(), password.value);
}
</script>

<template>
  <section class="panel auth-panel" aria-labelledby="auth-heading">
    <h2 id="auth-heading">{{ t(setup ? '初始化管理员' : '登录') }}</h2>
    <p v-if="setup" class="muted auth-intro">{{ t(hasSetupToken ? '填写邮箱和密码，创建首个管理员账号。' : '请从服务器控制台打开初始化链接。') }}</p>

    <form class="auth-form" :aria-busy="pending" @submit.prevent="submit" @input="edited">
      <fieldset :disabled="pending || (setup && !hasSetupToken)">
        <label>{{ t('邮箱') }}<input v-model="identifier" :type="setup ? 'email' : 'text'" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254" required /></label>
        <label v-if="setup">{{ t('新密码') }}<input v-model="password" type="password" name="new-password" autocomplete="new-password" minlength="5" required aria-describedby="setup-password-hint" /></label>
        <label v-else>{{ t('密码') }}<input v-model="password" type="password" name="password" autocomplete="current-password" required /></label>
        <small v-if="setup" id="setup-password-hint">{{ t('至少 5 个字符。') }}</small>
        <label v-if="setup">{{ t('确认密码') }}<input v-model="repeat" type="password" name="confirm-password" autocomplete="new-password" required /></label>
        <p v-if="validation || error" class="login-error" role="alert">{{ t(validation || error) }}</p>
        <button class="primary" type="submit" :disabled="pending || (setup && !hasSetupToken)">
          {{ t(pending ? (setup ? '正在创建…' : '正在登录…') : setup ? '创建管理员并登录' : '登录') }}
          <ArrowRight :size="17" aria-hidden="true" />
        </button>
      </fieldset>
    </form>
  </section>
</template>

<style scoped>
.auth-panel { width: min(400px, 100%); padding: 24px; }
.auth-panel h2 { font-size: 20px; }
.auth-panel h2 + form { margin-top: 16px; }
.auth-intro { margin: 8px 0 22px; overflow-wrap: anywhere; }
.auth-intro code { color: var(--ink); }
.auth-form fieldset { min-width: 0; padding: 0; margin: 0; border: 0; }
.auth-form label { margin-bottom: 14px; }
.auth-form small { display: block; margin: -8px 0 14px; }
.auth-form input[readonly] { color: var(--muted); background: var(--canvas); }
.auth-form .login-error { margin-bottom: 12px; font-size: 13px; color: var(--danger); overflow-wrap: anywhere; }
.auth-form button { width: 100%; min-height: 42px; margin-top: 4px; }
@media (max-width: 560px) { .auth-panel { padding: 20px; } }
</style>
