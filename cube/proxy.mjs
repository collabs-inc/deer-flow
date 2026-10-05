import http from 'node:http';

export function allowed(req, websocket = false) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) && !/^[a-z0-9][a-z0-9-]*-[a-z0-9]{8}(?:-stg)?\.cube\.site$/.test(host.hostname)) return false;
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  if (req.headers.origin && req.headers.origin !== `${proto}://${req.headers.host}`) return false;
  const unsafe = websocket || !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site) && (unsafe || !['document', 'iframe'].includes(req.headers['sec-fetch-dest']))) return false;
  return true;
}

export function route(url) {
  if (url.startsWith('/api/langgraph/')) return ['gateway', url.replace('/api/langgraph/', '/api/')];
  if (/^\/(?:api(?:\/|\?|$)|health(?:\?|$)|docs(?:\/|\?|$)|redoc(?:\?|$)|openapi\.json(?:\?|$))/.test(url)) return ['gateway', url];
  return ['frontend', url];
}

export function createProxy(ports) {
  const sockets = new Set();
  function options(req) {
    const [target, path] = route(req.url);
    return { host: '127.0.0.1', port: ports[target], path, method: req.method, headers: { ...req.headers } };
  }
  const server = http.createServer((req, res) => {
    if (!allowed(req)) { res.writeHead(403); res.end('Forbidden'); return; }
    const proxy = http.request(options(req), response => {
      const headers = { ...response.headers };
      delete headers['access-control-allow-origin'];
      delete headers['access-control-allow-credentials'];
      res.writeHead(response.statusCode, headers);
      response.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('DeerFlow is unavailable'); });
    req.on('aborted', () => proxy.destroy());
    res.on('close', () => proxy.destroy());
    req.pipe(proxy);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!allowed(req, true)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const proxy = http.request(options(req));
    proxy.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote); remote.on('close', () => sockets.delete(remote));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy()); remote.pipe(socket).pipe(remote);
    });
    proxy.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Upstream Rejected\r\nConnection: close\r\n\r\n`); response.resume(); });
    proxy.on('error', () => socket.destroy()); proxy.end();
  });
  return { server, close: () => { server.close(); for (const socket of sockets) socket.destroy(); } };
}
