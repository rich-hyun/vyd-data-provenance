// VYD 데이터 이력·진위검증 API 서버
//   cd api-server && npm install && node server.mjs
// 환경변수는 .env.example 참고 (process.env 로 읽음, --env-file=.env 사용 가능: node --env-file=.env server.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import express from 'express';
import { ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const art = JSON.parse(fs.readFileSync(path.join(here, '..', 'artifacts', 'DataProvenanceRegistry.json'), 'utf8'));

const env = process.env;
const CFG = {
  port: +(env.PORT || 8080),
  rpc: env.RPC_URL || 'https://vyd.mustree.kr',
  chainId: +(env.CHAIN_ID || 7603),
  contract: env.CONTRACT_ADDRESS,
  deployBlock: +(env.DEPLOY_BLOCK || 0),
  privateKey: env.PRIVATE_KEY,
  dataDir: path.resolve(here, env.DATA_DIR || 'data'),
  anchorSize: +(env.ANCHOR_SIZE || 10),
  corsOrigin: env.CORS_ORIGIN || '*',
  gasPrice: env.GAS_PRICE != null && env.GAS_PRICE !== '' ? BigInt(env.GAS_PRICE) : null,
  rateLimit: +(env.RATE_LIMIT_PER_MIN || 600),
  // "이름:키:권한1,권한2;이름:키:권한" — 권한: write | read | verify
  apiKeys: (env.API_KEYS || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const [name, key, scopes = 'read,verify'] = s.split(':');
    return { name, key, scopes: new Set(scopes.split(',').map(x => x.trim())) };
  }),
};
if (!CFG.contract) { console.error('CONTRACT_ADDRESS가 필요합니다. scripts/deploy.mjs 실행 결과의 주소를 넣으세요.'); process.exit(1); }
if (!CFG.apiKeys.length) console.warn('[경고] API_KEYS가 비어 있어 모든 요청이 401이 됩니다.');

const STAGES = ['COLLECT', 'PREPROCESS', 'AI_PROCESS', 'QA', 'LICENSE'];
const ZERO = ethers.ZeroHash;
const provider = new ethers.JsonRpcProvider(CFG.rpc, CFG.chainId, { staticNetwork: true });
const signer = CFG.privateKey ? new ethers.NonceManager(new ethers.Wallet(CFG.privateKey, provider)) : null;
const reader = new ethers.Contract(CFG.contract, art.abi, provider);
const writer = signer ? new ethers.Contract(CFG.contract, art.abi, signer) : null;
const txOpts = () => (CFG.gasPrice != null ? { gasPrice: CFG.gasPrice } : {});

/* ---------------- 저장소 (JSON 파일) ---------------- */
fs.mkdirSync(CFG.dataDir, { recursive: true });
const F = { audit: path.join(CFG.dataDir, 'audit.jsonl'), meta: path.join(CFG.dataDir, 'meta.json'), anchors: path.join(CFG.dataDir, 'anchors.json') };
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const audit = fs.existsSync(F.audit) ? fs.readFileSync(F.audit, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const meta = readJSON(F.meta, { datasets: {}, notes: {} });  // 오프체인 메타: 데이터셋 이름, 단계별 작업 내용
const anchors = readJSON(F.anchors, []);
const saveMeta = () => fs.writeFileSync(F.meta, JSON.stringify(meta, null, 2));
const saveAnchors = () => fs.writeFileSync(F.anchors, JSON.stringify(anchors, null, 2));

/* ---------------- 감사 로그 + 머클 앵커 ----------------
   leaf = sha256(JSON.stringify([seq, ts, type, actor, action, target, result, tx]))
   node = sha256(왼쪽hex + 오른쪽hex(0x 제외)) — 홀수면 마지막 노드를 복제
   콘솔(index.html)의 merkleRoot()와 같은 규칙이라 브라우저에서 재검증할 수 있다. */
const sha = s => '0x' + crypto.createHash('sha256').update(s).digest('hex');
const leafOf = e => JSON.stringify([e.seq, e.ts, e.type, e.actor, e.action, e.target, e.result, e.tx || '']);
function merkleRoot(entries) {
  let lvl = entries.map(e => sha(leafOf(e)));
  while (lvl.length > 1) {
    const nx = [];
    for (let i = 0; i < lvl.length; i += 2) nx.push(sha(lvl[i] + (lvl[i + 1] ?? lvl[i]).slice(2)));
    lvl = nx;
  }
  return lvl[0];
}
function log(type, actor, action, target, result, tx) {
  const e = { seq: audit.length + 1, ts: Date.now(), type, actor, action, target: target || '', result: String(result), tx: tx || null };
  audit.push(e);
  fs.appendFileSync(F.audit, JSON.stringify(e) + '\n');
  maybeAnchor().catch(err => console.error('anchor failed:', err.shortMessage || err.message));
  return e;
}
let anchoring = false;
async function maybeAnchor() {
  if (anchoring || !writer) return;
  const lastTo = anchors.length ? anchors[anchors.length - 1].toSeq : 0;
  if (audit.length - lastTo < CFG.anchorSize) return;
  anchoring = true;
  try {
    const fromSeq = lastTo + 1, toSeq = lastTo + CFG.anchorSize;
    const root = merkleRoot(audit.slice(fromSeq - 1, toSeq));
    const tx = await writer.anchorAuditLog(root, fromSeq, toSeq, txOpts());
    const a = { fromSeq, toSeq, root, txHash: tx.hash, block: null, anchorId: null };
    anchors.push(a); saveAnchors();
    const rc = await tx.wait();
    a.block = rc.blockNumber;
    const ev = rc.logs.map(l => { try { return reader.interface.parseLog(l); } catch { return null; } }).find(x => x?.name === 'AuditLogAnchored');
    if (ev) a.anchorId = Number(ev.args.anchorId);
    saveAnchors();
    log('ANCHOR', '감사 로그 서비스', 'anchorAuditLog', `#${fromSeq}–#${toSeq}`, 'SUCCESS', tx.hash);
  } finally { anchoring = false; }
}

/* ---------------- 공통 ---------------- */
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const isHash = h => /^0x[0-9a-fA-F]{64}$/.test(h || '');
function parseStage(v) {
  if (Number.isInteger(v) && STAGES[v]) return v;
  const s = String(v ?? '').trim().toUpperCase();
  if (/^\d$/.test(s) && STAGES[+s]) return +s;
  const i = STAGES.indexOf(s);
  if (i < 0) throw new ApiError(400, 'INVALID_STAGE', 'stage는 COLLECT, PREPROCESS, AI_PROCESS, QA, LICENSE 중 하나여야 합니다.');
  return i;
}
function mapRevert(err) {
  const name = err?.revert?.name || (() => { try { return reader.interface.parseError(err?.data)?.name; } catch { return null; } })();
  if (name === 'DuplicateHash') return new ApiError(409, 'DUPLICATE_HASH', '이미 등록된 콘텐츠 해시입니다.');
  if (name === 'InvalidStageOrder') return new ApiError(422, 'STAGE_ORDER', '현재 단계보다 이전 단계는 등록할 수 없습니다.');
  if (name === 'AccessControlUnauthorizedAccount') return new ApiError(403, 'FORBIDDEN_ROLE', '서버 계정에 REGISTRAR_ROLE이 없습니다.');
  if (name === 'EmptyDataId' || name === 'EmptyHash') return new ApiError(400, 'INVALID_REQUEST', name);
  if (err?.code === 'NETWORK_ERROR' || err?.code === 'TIMEOUT' || err?.code === 'SERVER_ERROR') return new ApiError(503, 'CHAIN_UNAVAILABLE', '블록체인 노드에 연결할 수 없습니다.');
  return null;
}
const recOut = (r, i) => ({
  index: i, stage: STAGES[Number(r.stage)], contentHash: r.contentHash, parentHash: r.parentHash, registrar: r.registrar,
  block: Number(r.blockNumber), timestamp: new Date(Number(r.timestamp) * 1000).toISOString(), metaURI: r.metaURI,
  note: meta.notes[r.contentHash.toLowerCase()] || null,
});

/* ---------------- 앱 ---------------- */
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', CFG.corsOrigin);
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/health', (req, res) => res.json({ ok: true }));

const buckets = new Map();
function auth(scope) {
  return (req, res, next) => {
    const k = CFG.apiKeys.find(x => x.key === req.get('X-API-Key'));
    if (!k) return next(new ApiError(401, 'UNAUTHORIZED', 'X-API-Key 헤더가 없거나 유효하지 않습니다.'));
    req.apiClient = k.name;
    if (scope && !k.scopes.has(scope)) return next(new ApiError(403, 'FORBIDDEN_SCOPE', `이 키에는 ${scope} 권한이 없습니다.`));
    const now = Date.now(), b = buckets.get(k.key) || { t: now, n: 0 };
    if (now - b.t > 60_000) { b.t = now; b.n = 0; }
    if (++b.n > CFG.rateLimit) return next(new ApiError(429, 'RATE_LIMITED', '분당 호출 한도를 넘었습니다.'));
    buckets.set(k.key, b); next();
  };
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const v1 = express.Router();

v1.get('/network/status', auth('read'), wrap(async (req, res) => {
  const [block, peers, client, syncing, code, total, sets] = await Promise.all([
    provider.getBlockNumber(), provider.send('net_peerCount', []).catch(() => null), provider.send('web3_clientVersion', []).catch(() => null),
    provider.send('eth_syncing', []).catch(() => null), provider.getCode(CFG.contract),
    reader.totalRecords().catch(() => null), reader.datasetCount().catch(() => null),
  ]);
  res.json({ chainId: CFG.chainId, blockNumber: block, peerCount: peers == null ? null : Number(peers), clientVersion: client, syncing: !!syncing,
    contract: { address: CFG.contract, deployed: code !== '0x', totalRecords: total == null ? null : Number(total), datasetCount: sets == null ? null : Number(sets) } });
}));

v1.get('/records', auth('read'), wrap(async (req, res) => {
  const n = Number(await reader.datasetCount());
  const items = [];
  for (let i = Math.max(0, n - 200); i < n; i++) {
    const [dataId, records] = await reader.datasetAt(i);
    items.push({ dataId, name: meta.datasets[dataId]?.name || null, records: Number(records) });
  }
  res.json({ total: n, items: items.reverse() });
}));

v1.post('/records', auth('write'), wrap(async (req, res) => {
  if (!writer) throw new ApiError(503, 'NO_SIGNER', 'PRIVATE_KEY가 설정되지 않아 쓰기 요청을 처리할 수 없습니다.');
  const b = req.body || {};
  const dataId = String(b.dataId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(dataId)) throw new ApiError(400, 'INVALID_DATA_ID', '데이터 ID는 영문·숫자·-_. 조합 3~64자입니다.');
  const stage = parseStage(b.stage);
  if (!isHash(b.contentHash)) throw new ApiError(400, 'INVALID_HASH', 'contentHash는 0x + 64자리 16진수(SHA-256)여야 합니다.');
  const contentHash = b.contentHash.toLowerCase();
  const metaURI = String(b.metaURI || '');
  try { await writer.registerRecord.staticCall(dataId, stage, contentHash, metaURI); }
  catch (e) { throw mapRevert(e) || e; }
  const tx = await writer.registerRecord(dataId, stage, contentHash, metaURI, txOpts());
  if (b.name && !meta.datasets[dataId]) meta.datasets[dataId] = { name: String(b.name).slice(0, 120) };
  if (b.note) meta.notes[contentHash] = String(b.note).slice(0, 500);
  saveMeta();
  log('TX', req.apiClient, 'registerRecord 제출', `${dataId} · ${STAGES[stage]}`, 'PENDING', tx.hash);
  tx.wait().then(rc => log('REGISTER', req.apiClient, 'registerRecord 확정', `${dataId} · ${STAGES[stage]}`, rc.status === 1 ? 'SUCCESS' : 'REVERTED', tx.hash))
    .catch(e => log('REGISTER', req.apiClient, 'registerRecord 실패', dataId, e.shortMessage || 'FAILED', tx.hash));
  res.status(202).json({ txHash: tx.hash, status: 'PENDING', dataId, stage: STAGES[stage], contentHash, submittedAt: new Date().toISOString() });
}));

async function history(dataId) {
  const h = await reader.getHistory(dataId);
  if (!h.length) throw new ApiError(404, 'NOT_FOUND', '해당 데이터 ID의 이력이 없습니다.');
  return h.map(recOut);
}
v1.get('/records/:dataId', auth('read'), wrap(async (req, res) => {
  const h = await history(req.params.dataId); const l = h[h.length - 1];
  log('QUERY', req.apiClient, 'GET /records/{dataId}', req.params.dataId, 200);
  res.json({ dataId: req.params.dataId, name: meta.datasets[req.params.dataId]?.name || null, currentStage: l.stage, latestHash: l.contentHash, entries: h.length, lastBlock: l.block, updatedAt: l.timestamp });
}));
v1.get('/records/:dataId/history', auth('read'), wrap(async (req, res) => {
  const h = await history(req.params.dataId);
  const intact = h.every((r, i) => r.parentHash === (i === 0 ? ZERO : h[i - 1].contentHash));
  log('QUERY', req.apiClient, 'GET /records/{dataId}/history', req.params.dataId, 200);
  res.json({ dataId: req.params.dataId, name: meta.datasets[req.params.dataId]?.name || null, chainIntegrity: intact ? 'VALID' : 'BROKEN', history: h });
}));

v1.post('/verify', auth('verify'), wrap(async (req, res) => {
  const { contentHash, dataId } = req.body || {};
  if (!isHash(contentHash)) throw new ApiError(400, 'INVALID_HASH', 'contentHash가 필요합니다.');
  const [found, foundId, index, record] = await reader.verify(contentHash);
  const height = await provider.getBlockNumber();
  let out;
  if (found && (!dataId || foundId === dataId)) {
    const h = await reader.getHistory(foundId);
    out = { result: 'MATCH', contentHash, dataId: foundId, stage: STAGES[Number(record.stage)], isLatest: Number(index) === h.length - 1,
      block: Number(record.blockNumber), confirmations: height - Number(record.blockNumber), registrar: record.registrar,
      timestamp: new Date(Number(record.timestamp) * 1000).toISOString() };
  } else if (dataId) {
    const h = await reader.getHistory(dataId);
    out = h.length ? { result: 'MISMATCH', contentHash, dataId, expectedLatestHash: h[h.length - 1].contentHash, expectedStage: STAGES[Number(h[h.length - 1].stage)], registeredElsewhere: found ? foundId : null }
                   : { result: 'NOT_FOUND', contentHash, dataId };
  } else out = { result: 'NOT_FOUND', contentHash };
  out.checkedAtBlock = height;
  log('VERIFY', req.apiClient, 'verify', `${out.dataId || '전체 원장'} · ${contentHash.slice(0, 10)}`, out.result);
  res.json(out);
}));

v1.get('/transactions/:hash', auth('read'), wrap(async (req, res) => {
  if (!isHash(req.params.hash)) throw new ApiError(400, 'INVALID_HASH', '트랜잭션 해시 형식이 아닙니다.');
  const [tx, rc] = await Promise.all([provider.getTransaction(req.params.hash), provider.getTransactionReceipt(req.params.hash)]);
  if (!tx) throw new ApiError(404, 'NOT_FOUND', '트랜잭션을 찾을 수 없습니다.');
  let method = null, args = null;
  if (tx.to && tx.to.toLowerCase() === CFG.contract.toLowerCase()) {
    try { const p = reader.interface.parseTransaction({ data: tx.data }); method = p.name; args = Object.fromEntries(p.fragment.inputs.map((f, i) => [f.name, p.args[i].toString()])); } catch {}
  }
  const height = await provider.getBlockNumber();
  res.json({ txHash: tx.hash, status: !rc ? 'PENDING' : rc.status === 1 ? 'SUCCESS' : 'REVERTED', block: rc?.blockNumber ?? null,
    confirmations: rc ? height - rc.blockNumber : 0, from: tx.from, to: tx.to, method, args, gasUsed: rc ? Number(rc.gasUsed) : null });
}));

v1.get('/audit-logs', auth('read'), (req, res) => {
  const lim = Math.min(500, +(req.query.limit || 50)); const type = req.query.type;
  const from = +(req.query.fromSeq || 0);
  let list = audit.filter(a => (!type || a.type === type) && a.seq >= from);
  list = from ? list.slice(0, lim) : list.slice(-lim).reverse();
  res.json({ total: audit.length, anchorSize: CFG.anchorSize, items: list });
});
v1.get('/audit-anchors', auth('read'), (req, res) => res.json({ anchorSize: CFG.anchorSize, items: anchors }));
v1.get('/audit-anchors/:i/verify', auth('read'), wrap(async (req, res) => {
  const a = anchors[+req.params.i];
  if (!a || a.anchorId == null) throw new ApiError(404, 'NOT_FOUND', '확정된 앵커가 아닙니다.');
  const onchain = await reader.auditAnchor(a.anchorId);
  const local = merkleRoot(audit.slice(a.fromSeq - 1, a.toSeq));
  res.json({ fromSeq: a.fromSeq, toSeq: a.toSeq, onchainRoot: onchain.merkleRoot, recomputedRoot: local, intact: onchain.merkleRoot === local, txHash: a.txHash });
}));

app.use('/v1', v1);
app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '지원하지 않는 엔드포인트입니다.' } }));
app.use((err, req, res, next) => {
  const e = err instanceof ApiError ? err : mapRevert(err) || new ApiError(500, 'INTERNAL', err.shortMessage || err.message);
  if (e.status >= 500) console.error(err);
  if (req.path !== '/v1/audit-logs') log('API', req.apiClient || 'anonymous', `${req.method} ${req.path}`, '', e.status);
  res.status(e.status).json({ error: { code: e.code, message: e.message } });
});

app.listen(CFG.port, async () => {
  console.log(`VYD API listening on :${CFG.port} · rpc ${CFG.rpc} · contract ${CFG.contract}`);
  if (signer) console.log(`signer ${await signer.getAddress()}`);
});
export { app, merkleRoot };
