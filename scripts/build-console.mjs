// 콘솔 빌드: 컴파일된 ABI·바이트코드와 Solidity 소스를 console/src.html 에 넣어
//   console/index.html (단독 실행용 완성 HTML)을 만든다.
//   node scripts/compile.mjs && node scripts/build-console.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const art = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'DataProvenanceRegistry.json'), 'utf8'));
const sol = fs.readFileSync(path.join(root, 'contracts', 'DataProvenanceRegistry.sol'), 'utf8');
let src = fs.readFileSync(path.join(root, 'console', 'src.html'), 'utf8');

const artJson = JSON.stringify({ abi: art.abi, bytecode: art.bytecode, compiler: art.compiler, settings: art.settings });
const marker = '/*__ARTIFACT__*/{"abi":[],"bytecode":"0x","compiler":"","settings":{}}';
if (!src.includes(marker) || !src.includes('`__SOL_SOURCE__`')) throw new Error('placeholder not found in src.html');
src = src.replace(marker, () => artJson);
const solTpl = sol.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
src = src.replace('`__SOL_SOURCE__`', () => '`' + solTpl + '`');

// 배포 환경값을 콘솔 기본 설정에 반영 (GitHub Actions 변수 등)
//   CONSOLE_RPC, CONSOLE_CHAIN_ID, CONSOLE_CONTRACT, CONSOLE_DEPLOY_BLOCK, CONSOLE_API
const setDefault = (key, val) => {
  const re = new RegExp(`(\\n  ${key}: )[^,\\n]+,`);
  if (!re.test(src)) throw new Error(`DEFAULTS.${key} not found`);
  src = src.replace(re, (_, pre) => pre + JSON.stringify(val) + ',');
};
const env = process.env;
if (env.CONSOLE_RPC) setDefault('rpc', env.CONSOLE_RPC);
if (env.CONSOLE_CHAIN_ID) setDefault('chainId', Number(env.CONSOLE_CHAIN_ID));
if (env.CONSOLE_CONTRACT) setDefault('contract', env.CONSOLE_CONTRACT);
if (env.CONSOLE_DEPLOY_BLOCK) setDefault('deployBlock', Number(env.CONSOLE_DEPLOY_BLOCK));
if (env.CONSOLE_API) setDefault('api', env.CONSOLE_API.replace(/\/$/, ''));

// 단독 실행용 HTML 골격
const cut = src.indexOf('</style>') + '</style>'.length;
const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${src.slice(0, cut)}
</head>
<body>
${src.slice(cut).trim()}
</body>
</html>
`;
fs.writeFileSync(path.join(root, 'console', 'index.html'), html);
fs.writeFileSync(path.join(root, 'console', '.artifact-body.html'), src); // 본문만 (claude 아티팩트 게시용)
console.log(`console/index.html written (${(html.length / 1024).toFixed(0)} KB)`);
