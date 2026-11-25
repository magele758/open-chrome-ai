#!/usr/bin/env node
/**
 * Local static server for the PageLens Risk Control Playground.
 * Usage:
 *   node tools/risk-control-playground/server.mjs [--port 18473]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 18473;
const ROOT_DIR = fileURLToPath(new URL('./', import.meta.url));
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export function createPlaygroundServer() {
  const rootPrefix = ROOT_DIR.endsWith(sep) ? ROOT_DIR : ROOT_DIR + sep;
  return createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    let pathname = '/';
    try {
      const rawUrl = req.url || '/';
      const rawPath = rawUrl.split(/[?#]/, 1)[0] || '/';
      pathname = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    if (pathname.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    const relPath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = resolve(ROOT_DIR, relPath);
    if (filePath !== ROOT_DIR && !filePath.startsWith(rootPrefix)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPES[ext];
    if (!contentType) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    try {
      const body = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
}

function parsePort(argv) {
  const flagIndex = argv.indexOf('--port');
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    const n = Number(argv[flagIndex + 1]);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return { port: n, explicit: true };
  }
  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort >= 0 && envPort <= 65535) return { port: envPort, explicit: true };
  return { port: DEFAULT_PORT, explicit: false };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { port, explicit } = parsePort(process.argv.slice(2));
  const server = createPlaygroundServer();
  const announce = () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`Risk Control Playground running at http://127.0.0.1:${actualPort}/`);
  };
  server.on('error', err => {
    if (!explicit && err && err.code === 'EADDRINUSE') {
      server.listen(0, '127.0.0.1', announce);
      return;
    }
    console.error(err);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', announce);
}
