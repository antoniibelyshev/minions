import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const docker = process.env.MINIONS_DOCKER_TESTS === '1';

export default defineConfig({
  define: { __MINIONS_VERSION__: JSON.stringify(pkg.version) },
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', ...(docker ? [] : ['test/docker/**'])],
  },
});
