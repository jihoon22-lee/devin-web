# 시작 안내

## 준비

지원 환경은 **Linux와 WSL 내부 Linux**입니다. 네이티브 Windows와 macOS의 서비스 관리는 지원하지 않습니다. WSL에서는 Node, pnpm, Devin CLI와 저장소를 모두 Linux 환경에 설치하세요. 기존 Linux 프로젝트 경로를 그대로 사용할 수 있습니다. Windows 브라우저에서는 보통 전달된 localhost 주소로 접속할 수 있지만 WSL 네트워크 설정에 따라 달라질 수 있습니다.

- Node.js **≥24.18.0, <25**, pnpm **9.15.9**
- 같은 OS 사용자로 설치·인증한 Devin CLI: `devin --version`, `devin auth status` 확인
- Bash, curl, util-linux의 `setsid`, iproute2의 `ss`, procps의 `ps`·`pgrep`, GNU 기본 도구
- 네이티브 PTY 빌드용 Python 3, make, C/C++ 컴파일러. Debian/Ubuntu에서는 보통 `python3`, `build-essential` 패키지를 사용합니다.
- 복제·기여자 검증·Git 기능에는 Git이 필요합니다. 소스 압축 파일의 설치·빌드·일반 실행에는 필요하지 않습니다.

Corepack이 있는 Node 환경에서는 `corepack enable`, `corepack prepare pnpm@9.15.9 --activate`로 pnpm 버전을 맞출 수 있습니다. 없다면 지원되는 pnpm 설치 방법을 사용하고 `node --version`, `pnpm --version`을 확인하세요.

초기 릴리스의 실제 사용자 흐름은 Devin CLI **3000.11.3**으로 검증했습니다. 다른 CLI 버전을 사용할 때는 상태 배지에서 스키마 호환성을 확인하세요.

## 설치와 실행

```bash
git clone https://github.com/jihoon22-lee/devin-web.git
cd devin-web
pnpm install --frozen-lockfile
devin auth status
pnpm build
bin/devin-web-ctl start
```

소스 압축 파일을 사용한다면 압축을 풀고 해당 디렉터리에서 `pnpm install --frozen-lockfile`부터 진행합니다. 네이티브 의존성이 설치될 수 있도록 설치 스크립트를 비활성화하지 마세요. 빌드 중 Google Fonts에서 Geist 글꼴을 내려받으며, 이후 브라우저에는 서버의 정적 파일로 제공합니다.

[http://127.0.0.1:7100](http://127.0.0.1:7100)을 열고 `bin/devin-web-ctl status`와 화면의 상태 배지를 확인합니다. 기존 세션이 없다면 소유한 작업 디렉터리에서 새 세션을 만들고 짧은 프롬프트로 동작을 확인하세요. 인증이 안 되어 있다면 터미널에서 Devin CLI 인증을 완료하세요.

## 실행 모드

| 명령 | 동작 |
| --- | --- |
| `pnpm dev` | `--dev`를 사용하는 개발 서버 |
| `pnpm build` 후 `pnpm start` | 포그라운드 프로덕션 웹 프로세스; 데몬·감시 프로세스를 자동 관리하지 않음 |
| `pnpm build` 후 `bin/devin-web-ctl start` | 웹·에이전트/터미널 데몬·웹 감시 프로세스를 관리하는 권장 방식 |

독립 실행 방식에서는 웹이 에이전트를 소유하므로 웹 종료 시 작업도 중단됩니다. 관리 모드는 데몬이 소유하므로 웹만 재시작할 때 실행 중인 작업과 터미널을 유지합니다. 같은 상태 디렉터리나 데몬 소켓에 여러 웹 인스턴스를 연결하지 마세요.

기본 주소는 `127.0.0.1:7100`입니다. 포트 우선순위는 `--port` → `DEVIN_WEB_PORT` → `PORT` → `7100`입니다. 서비스 설정은 `.env.local`에만 적지 말고 실행 셸이나 서비스 관리자 환경에 내보내야 합니다.

앱 로그인은 없습니다. 원격 접속 전에 [설정](configuration.md)과 [보안](../SECURITY.md)을, 실행 중인 설치를 업데이트하기 전에 [운영 안내](operations.md)를 읽어 주세요.
