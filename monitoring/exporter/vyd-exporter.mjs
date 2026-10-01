// VYD 체인 익스포터 — RPC로 체인 상태를 읽어 Prometheus 메트릭(/metrics)으로 내보낸다.
// 의존성 없음 (Node.js 20+). 환경변수:
//   RPC_URL           기본 https://vyd.mustree.kr
//   EXPECTED_CHAIN_ID 기본 7603
//   CONTRACT_ADDRESS  DataProvenanceRegistry 주소 (선택)
//   PORT              기본 9101
//   INTERVAL_MS       기본 5000
import http from 'node:http';

const RPC_URL = process.env.RPC_URL || 'https://vyd.mustree.kr';
const EXPECTED = Number(process.env.EXPECTED_CHAIN_ID || 7603);
const CONTRACT = process.env.CONTRACT_ADDRESS || '';
const PORT = Number(process.env.PORT || 9101);
const INTERVAL = Number(process.env.INTERVAL_MS || 5000);

// 컨트랙트 읽기 함수 셀렉터 (keccak256 앞 4바이트)
const SEL = { totalRecords: '0x125f8974', datasetCount: '0x3c8935b9', auditAnchorCount: '0xc0c8cd56' };

const m = {
  up: 0, chainId: null, height: null, blockTs: null, lastChange: null, latency: null, peers: null,
  signers: null, pending: null, skew: null, records: null, datasets: null, anchors: null,
  scrapes: 0, errors: 0, lastError: '',
};

let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const opt = (method, params) => rpc(method, params).catch(() => null);
const hex = v => (v == null ? null : parseInt(v, 16));

async function poll() {
  m.scrapes++;
  try {
    const t0 = performance.now();
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    m.latency = (performance.now() - t0) / 1000;
    const height = hex(b.number), ts = hex(b.timestamp), now = Date.now() / 1000;
    if (height !== m.height) {
      m.lastChange = now;               // 익스포터 시계 기준: 노드 시계가 틀려도 정지 감지 가능
      m.skew = now - ts;                // 새 블록을 본 순간의 (내 시계 - 블록 시각)
    }
    m.height = height; m.blockTs = ts;
    const [cid, peers, signers, pool] = await Promise.all([
      opt('eth_chainId'), opt('net_peerCount'), opt('clique_getSigners', ['latest']), opt('txpool_status'),
    ]);
    m.chainId = hex(cid); m.peers = hex(peers);
    m.signers = Array.isArray(signers) ? signers.length : null;
    m.pending = pool ? hex(pool.pending) : null;
    if (CONTRACT) {
      const call = sel => opt('eth_call', [{ to: CONTRACT, data: sel }, 'latest']).then(v => (v && v !== '0x' ? Number(BigInt(v)) : null));
      [m.records, m.datasets, m.anchors] = await Promise.all([call(SEL.totalRecords), call(SEL.datasetCount), call(SEL.auditAnchorCount)]);
    }
    m.up = 1; m.lastError = '';
  } catch (e) {
    m.up = 0; m.errors++; m.lastError = e.message;
  }
}

function metrics() {
  const out = [];
  const g = (name, help, val, labels = '') => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    if (val != null && !Number.isNaN(val)) out.push(`${name}${labels} ${val}`);
  };
  const c = (name, help, val) => { out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${val}`); };
  g('vyd_up', 'RPC 응답 여부 (1=정상)', m.up);
  g('vyd_chain_id', '응답한 체인 ID', m.chainId);
  g('vyd_expected_chain_id', '기대 체인 ID', EXPECTED);
  g('vyd_block_height', '최신 블록 번호', m.height);
  g('vyd_block_timestamp_seconds', '최신 블록 타임스탬프 (노드 시계)', m.blockTs);
  g('vyd_last_block_change_timestamp_seconds', '블록 번호가 마지막으로 바뀐 시각 (익스포터 시계)', m.lastChange);
  g('vyd_clock_skew_seconds', '익스포터 시계 - 블록 타임스탬프 (양수면 노드 시계가 늦음)', m.skew);
  g('vyd_rpc_latency_seconds', 'eth_getBlockByNumber 응답 시간', m.latency);
  g('vyd_peer_count', '노드 피어 수', m.peers);
  g('vyd_clique_signers', 'Clique 서명자 수 (clique API 활성 시)', m.signers);
  g('vyd_txpool_pending', '대기 트랜잭션 수 (txpool API 활성 시)', m.pending);
  g('vyd_contract_total_records', '온체인 이력 건수', m.records);
  g('vyd_contract_datasets', '온체인 데이터셋 수', m.datasets);
  g('vyd_contract_audit_anchors', '감사 로그 앵커 수', m.anchors);
  c('vyd_exporter_polls_total', 'RPC 조회 횟수', m.scrapes);
  c('vyd_exporter_errors_total', 'RPC 조회 실패 횟수', m.errors);
  return out.join('\n') + '\n';
}

http.createServer((req, res) => {
  if (req.url === '/metrics') { res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }); return res.end(metrics()); }
  if (req.url === '/health') { res.writeHead(m.up ? 200 : 503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ up: !!m.up, height: m.height, error: m.lastError || null })); }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`vyd-exporter :${PORT} → ${RPC_URL}`));

await poll();
setInterval(poll, INTERVAL);
