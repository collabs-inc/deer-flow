import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
// Cube installs updates while the old version is still running. Initialization
// belongs to the new runtime, behind its explicit starting page and app lock.
console.log('DeerFlow images are installed.');
