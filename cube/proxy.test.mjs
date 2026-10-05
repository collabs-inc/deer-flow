import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { allowed, createProxy, route } from './proxy.mjs';

test('websocket requests require an origin and host rejects userinfo', () => {
  const request = { socket: { remoteAddress: '127.0.0.1' }, method: 'GET', headers: { host: 'localhost:3000' } };
  assert.equal(allowed(request, true), false);
  assert.equal(allowed({ ...request, headers: { host: 'evil@localhost:3000' } }), false);
});

test('routes LangGraph, API and frontend paths without losing query strings', () => {
  assert.deepEqual(route('/api/langgraph/threads?limit=2'), ['gateway', '/api/threads?limit=2']);
  assert.deepEqual(route('/api/models'), ['gateway', '/api/models']);
  assert.deepEqual(route('/health'), ['gateway', '/health']);
  assert.deepEqual(route('/workspace/chats/a'), ['frontend', '/workspace/chats/a']);
});

test('streams bodies and responses through Cube hosts, rejecting cross-origin mutations', async () => {
  const seen = [];
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { seen.push({ path: req.url, body }); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: '); res.end(body || 'ready'); });
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const proxy = createProxy({ gateway: backend.address().port, frontend: backend.address().port });
  proxy.server.listen(0, '127.0.0.1'); await once(proxy.server, 'listening');
  const port = proxy.server.address().port;
  const request = (headers, method = 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/langgraph/threads', method, headers }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ code: res.statusCode, body }));
    }); req.on('error', reject); req.end(method === 'POST' ? '{"hello":true}' : undefined);
  });
  try {
    const host = 'deer-flow-1234abcd-stg.cube.site';
    const valid = { host, origin: `https://${host}`, 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' };
    assert.deepEqual(await request(valid), { code: 200, body: 'data: {"hello":true}' });
    assert.deepEqual(seen[0], { path: '/api/threads', body: '{"hello":true}' });
    assert.equal((await request({ ...valid, origin: 'https://evil.test' })).code, 403);
    assert.equal((await request({ ...valid, host: 'evil.test', origin: 'https://evil.test' })).code, 403);
    assert.equal((await request({ host: `localhost:${port}`, 'sec-fetch-site': 'cross-site' })).code, 403);
    assert.equal(seen.length, 1);
  } finally { proxy.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
});
