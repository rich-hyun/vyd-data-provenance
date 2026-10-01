# VYD 노드·관제 스택

Prometheus(수집) · Alertmanager(경보) · Grafana(대시보드) · 체인 익스포터 · 서버 리소스 익스포터를 Docker Compose로 띄웁니다.

## 실행

```bash
cd monitoring
cp .env.example .env        # 비밀번호 등 수정
docker compose up -d
```

- Grafana: `http://<서버>:3000` (admin / `.env`의 `GRAFANA_ADMIN_PASSWORD`) → 대시보드 **VYD › VYD 메인넷 관제**
- Prometheus: `http://127.0.0.1:9090` (서버 내부)
- Alertmanager: `http://127.0.0.1:9093` (서버 내부)

## 수집 대상

| 대상 | 내용 | 주기 |
|---|---|---|
| vyd-exporter (`exporter/vyd-exporter.mjs`) | RPC 응답, 블록 높이, 블록 정지, 시계 오차, 피어, 서명자, 온체인 이력·데이터셋·앵커 수 | 5초 |
| node-exporter | 서버 CPU·메모리·디스크 | 15초 |
| Geth `/debug/metrics/prometheus` | Geth 내부 메트릭 (Geth에 `--metrics` 옵션 필요) | 15초 |

## 경보 기준 (`prometheus/alerts.yml`)

| 경보 | 조건 | 등급 |
|---|---|---|
| VydRpcDown | RPC 응답 없음 1분 | critical |
| VydExporterDown | 익스포터 응답 없음 1분 | critical |
| VydBlockProductionStalled | 새 블록 없음 30초 (익스포터 시계 기준) | critical |
| VydChainIdMismatch | 체인 ID ≠ 7603 | critical |
| VydNodeClockSkew | 노드 시계 오차 15초 초과 5분 | warning |
| VydRpcSlow | RPC 응답 1초 초과 5분 | warning |
| HostDiskAlmostFull | 디스크 85% 초과 5분 | warning |
| HostMemoryHigh | 메모리 90% 초과 10분 | warning |
| HostCpuHigh | CPU 90% 초과 10분 | warning |
| HostDown | 서버 메트릭 수집 중단 1분 | critical |
| VydNoPeers | 피어 0 10분 (단일 노드 안내) | info, 알림 안 보냄 |

경보를 메일·메신저로 받으려면 `alertmanager/alertmanager.yml`의 `receivers.ops` 주석을 풀고 값을 넣은 뒤 `docker compose restart alertmanager`.

## 익스포터만 따로 실행

Docker 없이 Node.js로도 돌아갑니다.

```bash
RPC_URL=https://vyd.mustree.kr CONTRACT_ADDRESS=0x09429a97f265606F1e288E1B68314364bC63EEF8 node exporter/vyd-exporter.mjs
curl localhost:9101/metrics
```
