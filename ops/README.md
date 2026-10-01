# 노드 운영 설정

## 1. 시간 동기화 (필수)

블록 타임스탬프가 실제 시각보다 40~50초 늦게 찍히고 있습니다. 노드 서버에서:

```bash
sudo timedatectl set-ntp true
timedatectl status          # "System clock synchronized: yes" 확인
```

## 2. Geth 상시 실행 (systemd)

`geth/vyd-geth.service`의 【 】 부분을 현재 실행 명령에 맞춰 고친 뒤:

```bash
sudo cp geth/vyd-geth.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vyd-geth
```

서버가 재부팅되거나 Geth가 죽어도 5초 뒤 자동으로 다시 뜹니다.

## 3. 브라우저 접근 허용 (CORS)

`--http.corsdomain`에 관리 콘솔 주소를 넣습니다. 경로 없이 도메인까지만 씁니다.

```
--http.corsdomain "https://rich-hyun.github.io,http://localhost:5173"
```

`vyd.mustree.kr` 앞에 nginx가 있다면 nginx에서 처리해도 됩니다.

```nginx
location / {
  if ($request_method = OPTIONS) {
    add_header Access-Control-Allow-Origin "https://rich-hyun.github.io";
    add_header Access-Control-Allow-Methods "POST, OPTIONS";
    add_header Access-Control-Allow-Headers "Content-Type";
    return 204;
  }
  add_header Access-Control-Allow-Origin "https://rich-hyun.github.io" always;
  proxy_pass http://127.0.0.1:8545;
}
```

## 4. 관제 스택

`../monitoring/README.md` 참고.
