import {execSync} from 'child_process';
import {readFileSync} from 'fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type PluginOption} from 'vite';

// Stamp the build with the git commit + build time so the running UI can show
// exactly which version is live (makes "did my deploy land?" answerable at a glance).
function gitShortSha(): string {
  if (process.env.BUILD_COMMIT?.trim()) return process.env.BUILD_COMMIT.trim();
  try {
    return execSync('git rev-parse --short HEAD', {stdio: ['ignore', 'pipe', 'ignore']})
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

const release = JSON.parse(
  readFileSync(new URL('./release.json', import.meta.url), 'utf8'),
) as {version: string; name: string};

export default defineConfig(() => {
  const tailwindPlugins = tailwindcss() as PluginOption | PluginOption[];
  const buildTime = new Date().toISOString();
  return {
    define: {
      __APP_VERSION__: JSON.stringify(release.version),
      __APP_RELEASE_NAME__: JSON.stringify(release.name),
      __BUILD_COMMIT__: JSON.stringify(gitShortSha()),
      __BUILD_TIME__: JSON.stringify(buildTime),
    },
    plugins: [react(), ...(Array.isArray(tailwindPlugins) ? tailwindPlugins : [tailwindPlugins])],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      allowedHosts: true as const,
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    build: {
      // إخفاء source maps في الإنتاج — يمنع تسريب الكود المصدري للزوار
      sourcemap: false,
      // تصغير الإخراج لتقليل الحجم
      minify: 'esbuild' as const,
      // تقسيم الملفات لتقليل حجم التحميل الأولي
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['react', 'react-dom'],
            ui: ['lucide-react', 'motion'],
          },
        },
      },
    },
  };
});
