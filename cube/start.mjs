import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, cp, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { dockerConfig, dockerReady } from './ensure-docker.mjs';
import { createProxy } from './proxy.mjs';

const exec = promisify(execFile);
const warmup = process.env.CUBE_DEERFLOW_WARMUP === '1';
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < (warmup ? 0 : 1) || port > 65535) throw new Error('Invalid PORT.');
const data = process.env.CUBE_DEERFLOW_DATA_DIR || path.join(os.homedir(), '.local/share/cube-deerflow');
const root = fileURLToPath(new URL('../', import.meta.url));
const images = JSON.parse(await readFile(new URL('./images.json', import.meta.url), 'utf8'));
const docker = dockerConfig();
if (!await dockerReady(docker)) throw new Error('Docker is not ready; launch through cube/start.sh.');
const identity = createHash('sha256').update(path.resolve(data)).digest('hex').slice(0, 16);
const prefix = `cube-deerflow-${identity}`;
const label = 'computer.cube.deerflow';
const containers = [];
const waiters = [];
let proxy;
const readyPorts = { gateway: 0, frontend: 0 };
let stopping = false;
let networkOwned = false;
const cmd = (args, timeout = 30000) => exec(docker.docker, ['--host', docker.socket, ...args], { env: docker.env, timeout, maxBuffer: 1024 * 1024 });

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  proxy?.close();
  await Promise.all(containers.map(name => cmd(['stop', '--time', '1', name], 1800).catch(() => {})));
  await Promise.all(containers.map(name => cmd(['rm', '-f', name]).catch(() => {})));
  for (const child of waiters) child.kill('SIGTERM');
  if (networkOwned) await cmd(['network', 'rm', prefix]).catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGHUP', () => void stop());

async function createOnce(file, contents) {
  try { await writeFile(file, contents, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
async function removeStale(name) {
  const existing = await cmd(['inspect', '--format', `{{index .Config.Labels "${label}"}}`, name]).catch(() => null);
  if (!existing) return;
  if (existing.stdout.trim() !== identity) throw new Error('A container with this name belongs to another installation.');
  await cmd(['rm', '-f', name]);
}
async function launch(target, args) {
  if (stopping) throw new Error('Stopped during startup.');
  const name = `${prefix}-${target}`;
  await removeStale(name);
  containers.push(name);
  // Creation can be slow. An interrupted create leaves only a stopped owned
  // container; start never runs before its name exists for stop/remove.
  await cmd(['create', '--name', name, '--label', `${label}=${identity}`, '--platform', images.platform,
    '--network', prefix, '--network-alias', target, '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
    ...args, images[target]], 45000);
  if (stopping) { await cmd(['rm', '-f', name]); throw new Error('Stopped during startup.'); }
  await cmd(['start', name]);
  const waiter = spawn(docker.docker, ['--host', docker.socket, 'wait', name], { env: docker.env, stdio: 'ignore' });
  waiters.push(waiter);
  waiter.on('error', () => { if (!stopping) void stop(1); });
  waiter.on('exit', () => { if (!stopping) { console.error(`${target} stopped unexpectedly; inspect its private Docker log.`); void stop(1); } });
  const inner = target === 'gateway' ? 8001 : 3000;
  const result = await cmd(['port', name, `${inner}/tcp`]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(result.stdout.trim());
  if (!match) throw new Error('Docker did not provide a loopback-only port.');
  return Number(match[1]);
}

try {
  await mkdir(data, { recursive: true, mode: 0o700 });
  if (!warmup) {
    proxy = createProxy(readyPorts);
    proxy.server.listen(port, '127.0.0.1'); await once(proxy.server, 'listening');
    console.log('Starting DeerFlow containers; the app will refresh when initialization finishes.');
  }
  await mkdir(path.join(data, 'state'), { recursive: true, mode: 0o700 });
  await createOnce(path.join(data, 'config.yaml'), await readFile(new URL('./config.default.yaml', import.meta.url)));
  await createOnce(path.join(data, 'extensions_config.json'), '{"middlewares":[],"mcpServers":{},"skills":{}}\n');
  await createOnce(path.join(data, 'private.env'), `DEER_FLOW_AUTH_DISABLED=1\nBETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}\nDEER_FLOW_INTERNAL_AUTH_TOKEN=${randomBytes(32).toString('hex')}\n`);
  if (!await stat(path.join(data, 'skills')).catch(() => null)) await cp(path.join(root, 'skills'), path.join(data, 'skills'), { recursive: true });
  const existingNetwork = await cmd(['network', 'inspect', '--format', `{{index .Labels "${label}"}}`, prefix]).catch(() => null);
  if (existingNetwork && existingNetwork.stdout.trim() !== identity) throw new Error('The Docker network belongs to another installation.');
  if (!existingNetwork) await cmd(['network', 'create', '--label', `${label}=${identity}`, prefix]);
  networkOwned = true;
  const common = ['--env-file', path.join(data, 'private.env')];
  const credentials = process.env.CLAUDE_CODE_CREDENTIALS_PATH || path.join(os.homedir(), '.claude/.credentials.json');
  const auth = await stat(credentials).catch(() => null);
  const mounts = auth?.isFile() ? ['--mount', `type=bind,src=${credentials},dst=/cube-claude-credentials.json,readonly`, '-e', 'CLAUDE_CODE_CREDENTIALS_PATH=/cube-claude-credentials.json'] : [];
  if (!auth) console.log('Claude credentials not found; configure a model provider in the persistent config before chatting.');
  const gateway = await launch('gateway', [...common, '-p', '127.0.0.1::8001',
    '--mount', `type=bind,src=${data},dst=/cube-data`, ...mounts,
    '-e', 'DEER_FLOW_PROJECT_ROOT=/app', '-e', 'DEER_FLOW_HOME=/cube-data/state',
    '-e', 'DEER_FLOW_CONFIG_PATH=/cube-data/config.yaml', '-e', 'DEER_FLOW_EXTENSIONS_CONFIG_PATH=/cube-data/extensions_config.json',
    '-e', 'DEER_FLOW_SKILLS_PATH=/cube-data/skills', '-e', 'LANGSMITH_TRACING=false', '-e', 'PYTHONPATH=/app/backend']);
  const frontend = await launch('frontend', [...common, '-p', '127.0.0.1::3000', '-e', 'DEER_FLOW_INTERNAL_GATEWAY_BASE_URL=http://gateway:8001']);
  const deadline = Date.now() + 180000;
  let ready = false;
  while (!stopping && Date.now() < deadline) {
    try {
      const results = await Promise.all([fetch(`http://127.0.0.1:${gateway}/health`, { signal: AbortSignal.timeout(2000) }), fetch(`http://127.0.0.1:${frontend}/`, { signal: AbortSignal.timeout(2000) })]);
      ready = results.every(response => response.ok);
      for (const response of results) await response.body?.cancel();
    } catch {}
    if (ready) break;
    await delay(300);
  }
  if (!ready) throw new Error('DeerFlow did not become ready. Inspect the owned gateway/frontend Docker logs.');
  if (warmup) { console.log('DeerFlow initialization passed.'); await stop(); }
  Object.assign(readyPorts, { gateway, frontend });
  console.log(`DeerFlow is ready on 127.0.0.1:${port}.`);
} catch (error) {
  // execFile errors can contain environment or upstream details; never print
  // their captured output into Cube's app log.
  console.error(error.cmd ? 'DeerFlow container operation failed. Inspect the owned Docker containers.' : error.message);
  await stop(1);
}
