import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The preview server sends the same headers as production, so end-to-end tests run under the real policy.
const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
  headers: { headers: { key: string; value: string }[] }[]
}
const productionHeaders = Object.fromEntries(
  (vercel.headers[0]?.headers ?? []).map((h) => [h.key, h.value]),
)
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  server: { headers: isolationHeaders },
  preview: { headers: productionHeaders },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
})
