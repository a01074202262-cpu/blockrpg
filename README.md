# 블록 월드 RPG - Render 배포

## Render 설정
- New + -> Web Service
- 이 폴더를 GitHub 저장소에 업로드
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Node 20 이상
- 배포 후 `https://서비스주소/healthz`가 `{"ok":true}`를 반환하면 서버가 실행 중입니다.

## 선택 환경 변수
- `MAX_PLAYERS`: 동시 접속 제한 (기본 80, 허용 2~200)
- `ALLOWED_ORIGINS`: 허용할 Origin을 쉼표로 구분. 예: `https://your-game.onrender.com`
  기본값은 요청과 동일한 호스트의 HTTP(S) Origin만 허용합니다.

## 보안 메모
- 이 서버는 SQL 데이터베이스를 사용하지 않고 SQL 쿼리 API도 노출하지 않습니다. 따라서 SQL 인젝션 진입점이 없습니다.
- WebSocket 메시지는 JSON 파싱, 엄격한 필드 allowlist, 숫자 범위 검사, 페이로드 크기 제한, 메시지 빈도 제한을 적용합니다.
- Helmet 보안 헤더/CSP, HTTP 요청 제한, Origin 검사, IP별 연결 제한, 접속자 수 제한 및 heartbeat가 포함됩니다.
- 현재 멀티플레이어는 익명 위치 중계입니다. 계정/인벤토리/전투 결과를 신뢰성 있게 저장하거나 치트를 방지하는 authoritative game server는 아닙니다.
- 계정, 채팅, 저장 기능을 추가할 때는 인증/권한 검증을 별도로 구현하고, DB 사용 시 prepared/parameterized statements를 사용해야 합니다.
