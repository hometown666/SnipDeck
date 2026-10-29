// ESLint 扁平配置（2026-10-30 加）。
//
// 目的不是改代码风格，是把「明显写错」拦在提交前：未使用变量、shadow 掉的内置、
// 无 await 的 async、误用 const 赋值之类。格式问题不在这管 —— 本项目不用 prettier，
// 免得把 5000 行代码一次性重排成没法 review 的 diff。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// 只用 Node 侧全局；浏览器全局由 TS 的 DOM lib 负责（eslint 看到的 .ts 不判 no-undef）
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  fetch: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  WebSocket: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  globalThis: 'readonly',
  require: 'readonly',
  module: 'writable',
}

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'data/**', '**/*.d.ts', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: nodeGlobals },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // service worker 跑在 ServiceWorkerGlobalScope，不是 window 也不是 node
    files: ['packages/web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly',
        skipWaiting: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      // TS 自己管标识符是否存在，这里再判一遍会把 DOM/Node 类型全报成未定义
      'no-undef': 'off',
      // 边界处（fastify 泛型、CDP 返回值、探针脚本）有意的 any，不值得为它加一堆泛型
      '@typescript-eslint/no-explicit-any': 'off',
      // 下划线前缀 = 有意不用（回调签名占位）。
      // 用 error 不用 warn：历史上有过「算出来没人用」的死变量（history.ts 的 shell），
      // warn 不会让 CI 变红，等于没拦。
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]
