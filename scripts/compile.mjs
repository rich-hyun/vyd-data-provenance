// 컨트랙트 컴파일: node scripts/compile.mjs
// 결과물: artifacts/DataProvenanceRegistry.json (abi, bytecode)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const solc = require('solc');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = 'DataProvenanceRegistry.sol';
const source = fs.readFileSync(path.join(root, 'contracts', file), 'utf8');

const input = {
  language: 'Solidity',
  sources: { [file]: { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'london', // PUSH0 미사용: 하드포크 설정이 다른 체인에서도 배포 가능
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
function findImports(p) {
  try { return { contents: fs.readFileSync(require.resolve(p), 'utf8') }; }
  catch { return { error: 'not found: ' + p }; }
}
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors || []).filter(e => e.severity === 'error');
(out.errors || []).forEach(e => console.error(e.formattedMessage));
if (errors.length) process.exit(1);

const c = out.contracts[file].DataProvenanceRegistry;
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
const artifact = {
  contractName: 'DataProvenanceRegistry',
  compiler: `solc ${solc.version()}`,
  settings: { optimizer: input.settings.optimizer, evmVersion: input.settings.evmVersion },
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
  deployedBytecode: '0x' + c.evm.deployedBytecode.object,
};
fs.writeFileSync(path.join(root, 'artifacts', 'DataProvenanceRegistry.json'), JSON.stringify(artifact, null, 2));
console.log(`compiled with ${artifact.compiler} · bytecode ${(artifact.bytecode.length - 2) / 2} bytes`);
