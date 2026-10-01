// 로컬 체인(ganache)에서 컨트랙트 동작 검증: node test/contract.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
const require = createRequire(import.meta.url);
const ganache = require('ganache');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const art = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'DataProvenanceRegistry.json'), 'utf8'));

// 프로세스 안에서 도는 로컬 체인 (포트·네이티브 바이너리 불필요)
const chain = ganache.provider({ chain: { chainId: 7603 }, wallet: { totalAccounts: 3 }, logging: { quiet: true } });
try {
  const provider = new ethers.BrowserProvider(chain);
  const [admin, other] = await Promise.all([provider.getSigner(0), provider.getSigner(1)]);
  const c = await new ethers.ContractFactory(art.abi, art.bytecode, admin).deploy(await admin.getAddress());
  await c.waitForDeployment();
  const h = s => ethers.sha256(ethers.toUtf8Bytes(s));

  await (await c.registerRecord('DS-1', 0, h('a'), 's3://a')).wait();
  await (await c.registerRecord('DS-1', 1, h('b'), '')).wait();
  const hist = await c.getHistory('DS-1');
  assert.equal(hist.length, 2);
  assert.equal(hist[1].parentHash, h('a'), 'parentHash 연결');

  const v = await c.verify(h('b'));
  assert.equal(v.found, true); assert.equal(v.dataId, 'DS-1'); assert.equal(v.index, 1n);
  assert.equal((await c.verify(h('zzz'))).found, false);

  await assert.rejects(c.registerRecord.staticCall('DS-2', 0, h('a'), ''), /DuplicateHash/);
  await assert.rejects(c.registerRecord.staticCall('DS-1', 0, h('c'), ''), /InvalidStageOrder/);
  await assert.rejects(c.connect(other).registerRecord.staticCall('DS-3', 0, h('d'), ''), /AccessControlUnauthorizedAccount/);

  await (await c.grantRole(await c.REGISTRAR_ROLE(), await other.getAddress())).wait();
  await (await c.connect(other).registerRecord('DS-3', 0, h('d'), '')).wait();
  assert.equal(await c.datasetCount(), 2n);
  assert.equal(await c.totalRecords(), 3n);

  await (await c.anchorAuditLog(h('root'), 1, 10)).wait();
  assert.equal(await c.auditAnchorCount(), 1n);
  await assert.rejects(c.anchorAuditLog.staticCall(h('root'), 5, 1), /InvalidRange/);

  const logs = await c.queryFilter(c.filters.RecordRegistered(), 0);
  assert.equal(logs.length, 3); assert.equal(logs[0].args.dataId, 'DS-1');
  console.log('contract tests: all passed');
} finally { await chain.disconnect(); }
process.exit(0);
