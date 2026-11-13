import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const resources = path.resolve(fileURLToPath(new URL('../unreal/HaybaMCPToolkit/Resources/', import.meta.url)));
const page = fileURLToPath(new URL('./chat-ui-preview.html', import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const nativeDispatch = "location.href = 'hayba-chat://event/' + encodeURIComponent(JSON.stringify(commands.shift()));";

const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (req.method !== 'GET' || pathname.includes('\\')) { res.writeHead(404).end(); return; }
    const file = pathname === '/' ? page : path.resolve(resources, '.' + pathname);
    if (file !== page && !file.startsWith(resources + path.sep)) { res.writeHead(404).end(); return; }
    // Only the preview response substitutes the native bridge; shipping files stay untouched.
    let data = await fs.readFile(file);
    if (pathname === '/chat/chat.js') {
      const script = data.toString();
      if (!script.includes(nativeDispatch)) throw new Error('Preview bridge no longer matches the transcript.');
      data = script.replace(nativeDispatch, 'window.parent.postMessage({ haybaPreview: commands.shift() }, location.origin);');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(0, '127.0.0.1', () => console.log(`Hayba UI preview: http://127.0.0.1:${server.address().port}`));
