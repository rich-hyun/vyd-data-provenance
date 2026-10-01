// 콘솔을 로컬에서 열기: npm run console → http://localhost:5173
// MetaMask는 file:// 페이지에는 붙지 않으므로 로컬 서버로 엽니다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'console', 'index.html');
const PORT = +(process.env.PORT || 5173);
http.createServer((req, res) => {
  if (req.url !== '/' && !req.url.startsWith('/index.html') && !req.url.startsWith('/#')) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`콘솔: http://localhost:${PORT}  (종료: Ctrl+C)`);
});
