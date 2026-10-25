// 개발용: API 서버(파일이 바뀌면 다시 시작)와 Vite 개발 서버(화면 즉시 반영)를 함께 띄운다.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch', 'src/server/main.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

function stopAll(): void {
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
for (const child of children) {
  child.on('exit', (code) => {
    process.exitCode ??= code ?? 0;
    stopAll();
  });
}
