import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
const data = process.env.CUBE_DEERFLOW_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'cube-deerflow');
await mkdir(data, { recursive: true, mode: 0o700 });
const lock = spawnSync('flock', ['--nonblock', path.join(data, '.app.lock'), 'true']);
if (lock.error || (lock.status !== 0 && lock.status !== 1)) throw new Error('Cannot check DeerFlow app lock.');
if (lock.status === 0) {
  await run('sh', [fileURLToPath(new URL('./start.sh', import.meta.url))], { ...config.env, PORT: '0', CUBE_DEERFLOW_WARMUP: '1' });
} else {
  console.log('An existing DeerFlow is running; leave its data untouched until Cube switches versions.');
}
console.log('DeerFlow is installed and initialized.');
