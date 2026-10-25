import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 웹은 정적 파일로 빌드하고 Tevro 서버가 함께 제공한다(ADR-0001). 개발 중에는 API를 서버로 넘긴다.
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${process.env.PORT ?? 4000}`,
    },
  },
});
