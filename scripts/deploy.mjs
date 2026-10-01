// 컨트랙트 배포 + 권한 부여
//   RPC_URL=https://vyd.mustree.kr PRIVATE_KEY=0x... node scripts/deploy.mjs
// 선택 환경변수
//   ADMIN=0x...                관리자 주소 (기본: 배포 계정)
//   REGISTRARS=0xA,0xB         이력 등록 권한을 줄 주소 목록
//   AUDITORS=0xC               감사 로그 앵커 권한을 줄 주소 목록
//   GAS_PRICE=0                가스 가격(wei). 무료 가스 네트워크면 0
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const art = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'DataProvenanceRegistry.json'), 'utf8'));
const { RPC_URL: RPC_ENV, PRIVATE_KEY, ADMIN, REGISTRARS = '', AUDITORS = '', GAS_PRICE } = process.env;
if (!PRIVATE_KEY) { console.error('PRIVATE_KEY 환경변수가 필요합니다.'); process.exit(1); }
const RPC_URL = RPC_ENV || 'https://vyd.mustree.kr';

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const net = await provider.getNetwork();
const overrides = GAS_PRICE != null && GAS_PRICE !== '' ? { gasPrice: BigInt(GAS_PRICE) } : {};
console.log(`network chainId=${net.chainId} · deployer=${wallet.address}`);
console.log(`balance=${ethers.formatEther(await provider.getBalance(wallet.address))}`);

const admin = ADMIN || wallet.address;
const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
const contract = await factory.deploy(admin, overrides);
const deployTx = contract.deploymentTransaction();
console.log(`deploy tx ${deployTx.hash} … 확정 대기`);
const receipt = await deployTx.wait();
const address = await contract.getAddress();
console.log(`deployed at ${address} (block ${receipt.blockNumber})`);

const grants = [];
const list = s => s.split(',').map(x => x.trim()).filter(Boolean);
if (admin.toLowerCase() === wallet.address.toLowerCase()) {
  for (const [role, addrs] of [['REGISTRAR_ROLE', list(REGISTRARS)], ['AUDITOR_ROLE', list(AUDITORS)]]) {
    const roleId = await contract[role]();
    for (const a of addrs) {
      const tx = await contract.grantRole(roleId, a, overrides);
      await tx.wait();
      grants.push({ role, account: a, tx: tx.hash });
      console.log(`grant ${role} → ${a} (${tx.hash})`);
    }
  }
} else if (REGISTRARS || AUDITORS) {
  console.warn('ADMIN이 배포 계정과 달라 권한 부여는 건너뜁니다. 관리자 지갑으로 콘솔에서 부여하세요.');
}

const out = {
  network: { chainId: Number(net.chainId), rpc: RPC_URL },
  contract: 'DataProvenanceRegistry', address, deployTx: deployTx.hash, blockNumber: receipt.blockNumber,
  deployer: wallet.address, admin, compiler: art.compiler, settings: art.settings, grants,
  deployedAt: new Date().toISOString(),
};
fs.mkdirSync(path.join(root, 'deployments'), { recursive: true });
const f = path.join(root, 'deployments', `chain-${net.chainId}.json`);
fs.writeFileSync(f, JSON.stringify(out, null, 2));
console.log(`saved ${path.relative(root, f)}`);
console.log(`\n콘솔 설정: 컨트랙트 주소 ${address}, 배포 블록 ${receipt.blockNumber}`);
