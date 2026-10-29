import { defineConfig, devices } from '@playwright/test'

// BASE_URL points the suite at a deployed site; otherwise it runs against the local production preview.
const baseURL = process.env.BASE_URL ?? 'http://localhost:4173'
const channel = process.env.PW_CHANNEL

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) } }],
  webServer: process.env.BASE_URL
    ? undefined
    : { command: 'npm run preview', url: baseURL, reuseExistingServer: !process.env.CI, timeout: 120_000 },
})
