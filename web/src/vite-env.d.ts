/// <reference types="vite/client" />

/**
 * Typed environment access.
 *
 * Declaring the variables explicitly means a typo in `import.meta.env.VITE_API_BSE_URL`
 * is a compile error rather than a runtime `undefined` that silently falls back
 * to localhost in production.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
