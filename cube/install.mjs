import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ensureDocker } from './ensure-docker.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This DeerFlow package requires Linux x64.');
const config = await ensureDocker();
const images = JSON.parse(await readFile(new URL('./images.json', import.meta.url), 'utf8'));
const run = (bin, args, env = config.env) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { env, stdio: 'inherit' });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Install command failed (${code}).`)));
});
for (const target of ['gateway', 'frontend']) {
  console.log(`Installing the pinned DeerFlow ${images.version} ${target} image.`);
  await run(config.docker, ['--host', config.socket, 'pull', '--platform', images.platform, images[target]]);
}
// First migrations/initialization happen during install, outside Cube's 60s
// startup budget. The warm-up stops only its own two containers afterwards.
await run('sh', [fileURLToPath(new URL('./start.sh', import.meta.url))], { ...config.env, PORT: '0', CUBE_DEERFLOW_WARMUP: '1' });
console.log('DeerFlow is installed and initialized.');
