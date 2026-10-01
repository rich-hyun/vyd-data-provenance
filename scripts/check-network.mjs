// VYD 네트워크 연결 확인: npm run check
//   RPC_URL (기본 https://vyd.mustree.kr), CONTRACT_ADDRESS (선택)
import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_URL || 'https://vyd.mustree.kr';
const EXPECTED = 7603;
const ok = s => console.log(`  ✓ ${s}`);
const bad = s => { console.log(`  ✗ ${s}`); process.exitCode = 1; };

let id = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    signal: AbortSignal.timeout(10_000), // 10초 안에 응답이 없으면 실패
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const tryRpc = (m, p) => rpc(m, p).catch(() => null);

console.log(`RPC ${RPC_URL}`);
try {
  const t0 = Date.now();
  const chainId = parseInt(await rpc('eth_chainId'), 16);
  const ms = Date.now() - t0;
  chainId === EXPECTED ? ok(`체인 ID ${chainId} (응답 ${ms}ms)`) : bad(`체인 ID ${chainId} — ${EXPECTED}이어야 합니다`);

  const b = await rpc('eth_getBlockByNumber', ['latest', false]);
  const n = parseInt(b.number, 16), age = Math.round(Date.now() / 1000 - parseInt(b.timestamp, 16));
  age < 60 ? ok(`최신 블록 #${n} (${age}초 전 생성)`) : bad(`최신 블록 #${n}이 ${age}초 전에 생성됨 — 블록 생성이 멈췄을 수 있습니다`);

  const client = await tryRpc('web3_clientVersion');
  if (client) ok(`클라이언트 ${client}`);
  const peers = await tryRpc('net_peerCount');
  if (peers != null) ok(`피어 ${parseInt(peers, 16)}개`);
  const vals = await tryRpc('qbft_getValidatorsByBlockNumber', ['latest']);
  if (vals) ok(`QBFT 검증자 ${vals.length}개`);

  const addr = process.env.CONTRACT_ADDRESS;
  if (addr) {
    const code = await rpc('eth_getCode', [addr, 'latest']);
    if (code === '0x') bad(`컨트랙트 ${addr}에 코드가 없습니다`);
    else {
      const i = new ethers.Interface(['function totalRecords() view returns (uint256)', 'function datasetCount() view returns (uint256)']);
      const call = async f => i.decodeFunctionResult(f, await rpc('eth_call', [{ to: addr, data: i.encodeFunctionData(f) }, 'latest']))[0];
      ok(`컨트랙트 ${addr} · 이력 ${await call('totalRecords')}건 · 데이터셋 ${await call('datasetCount')}개`);
    }
  }
} catch (e) {
  bad(`RPC 호출 실패: ${e.name === 'TimeoutError' ? '10초 동안 응답 없음' : e.message}`);
  console.log('    주소(https:// 포함), 방화벽·IP 허용 목록, 노드의 --rpc-http-enabled 설정을 확인하세요.');
}
