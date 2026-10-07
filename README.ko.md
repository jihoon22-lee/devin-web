# devin-web

[![CI](https://github.com/jihoon22-lee/devin-web/actions/workflows/ci.yml/badge.svg)](https://github.com/jihoon22-lee/devin-web/actions/workflows/ci.yml)

[English](README.md) · [한국어 시작 안내](docs/getting-started.ko.md) · [상세 문서 (English)](docs/README.md)

[Devin CLI](https://devin.ai)를 데스크톱과 휴대폰의 브라우저에서 사용하는 자체 호스팅 웹 인터페이스입니다. 대화 스트리밍, 권한 승인, 파일 탐색, Git 변경 검토, 실제 터미널을 제공합니다. 관리 모드에서는 웹을 재시작해도 에이전트 작업과 터미널이 유지됩니다.

Cognition이나 Devin의 공식 제품이 아닌 독립적인 커뮤니티 프로젝트입니다. Devin CLI를 별도로 설치하고 인증해야 하며, 해당 서비스의 이용 조건과 요금이 적용됩니다.

## 시작하기

**Linux 또는 WSL 내부 Linux**, **Node.js ≥24.18.0, <25**, **pnpm 9.15.9**, `PATH`에서 실행할 수 있는 인증된 `devin`이 필요합니다. 네이티브 PTY 설치에는 Python 3, make, C/C++ 컴파일러가 필요할 수 있습니다.

```bash
git clone https://github.com/jihoon22-lee/devin-web.git
cd devin-web
pnpm install --frozen-lockfile
devin auth status
pnpm build
bin/devin-web-ctl start
```

[http://127.0.0.1:7100](http://127.0.0.1:7100)을 엽니다. Git 없이 소스 압축 파일에서 설치·빌드·실행할 수도 있습니다. 기여자 검증 명령과 Git 기능에는 Git이 필요합니다. 최초 빌드는 Google Fonts에서 Geist 글꼴을 내려받습니다.

개발은 `pnpm dev`, 빌드 후 포그라운드 프로덕션 웹 실행은 `pnpm start`를 사용합니다. 지속적인 사용에는 `bin/devin-web-ctl start`를 권장합니다. `pnpm start`만으로 데몬이나 감시 프로세스가 시작되지는 않습니다.

## 주요 기능

- CLI 세션 조회, 검색, 태그, 보관, 이어서 작업, 분기
- 메시지·계획·도구 실행 스트리밍과 권한 승인 및 질문 응답
- 프롬프트 대기열, 이미지 첨부, 파일 멘션, 대기 중인 메시지 편집·삭제
- 파일 탐색, Git diff 확인, 스테이징과 커밋
- 재연결 가능한 실제 터미널과 모바일 보조 키
- 테마, PWA, 기기별 선택적 푸시 알림, 키보드 단축키

**앱 자체 로그인 기능은 없습니다.** 접속한 사용자는 서버 OS 사용자의 권한으로 명령 실행과 파일 편집을 할 수 있습니다. 기본 루프백 주소를 유지하고, 원격 접속에는 인증된 사설 접속 계층을 사용하세요. Host·CSRF 검사는 사용자 인증을 대신하지 않습니다. [보안 정책](SECURITY.md)을 확인하세요.

[사용법](docs/usage.md) · [설정](docs/configuration.md) · [운영·업데이트·백업](docs/operations.md) · [구조](docs/architecture.md) · [기여 안내](CONTRIBUTING.md) · [로드맵](docs/roadmap.md)

프로젝트 자체 코드와 문서는 MIT 라이선스입니다. [LICENSE](LICENSE)와 [제3자 고지](THIRD_PARTY_NOTICES.md)를 확인하세요.
