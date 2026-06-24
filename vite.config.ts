import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type PluginOption} from 'vite';

export default defineConfig(() => {
  const tailwindPlugins = tailwindcss() as PluginOption | PluginOption[];
  return {
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
