import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 測試一律純記憶體，不連 Supabase；若日後加入整合測試請另開 project
    include: ['lib/**/*.test.ts'],
    environment: 'node',
    reporters: ['verbose'],
  },
});
