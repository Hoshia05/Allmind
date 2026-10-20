# exe 빌드와 릴리스

`Allmind.exe`는 Node 22 단일 실행 파일(SEA)이고, 배포용 `Allmind-x.y.z.exe`는 그것을 xz로 압축해 푸는 작은 런처로 감싼 것입니다(약 20 MB). 빌드는 Linux/macOS/WSL에서 합니다.

## 준비 (처음 한 번)

필요한 것: Node.js 22, npm, git, xz, python3(pip).

```bash
sh tools/setup-build.sh
```

`.build-tools/`에 다음을 받아 둡니다 (git에는 안 올라가요).
- 지금 쓰는 Node와 **같은 버전**의 Windows용 `node.exe` (npm 패키지 `node-win-x64`)
- [xz-embedded](https://github.com/tukaani-project/xz-embedded) (런처의 압축 해제 코드)
- zig (`pip install ziglang`, 런처를 Windows용으로 컴파일)

## 빌드

```bash
sh tools/build-all.sh
```

결과는 `dist/Allmind-<버전>.exe`이고, 안에 든 앱이 원본과 같은지도 확인합니다. 버전은 `package.json`의 `version`과 `src/server.js`의 `VERSION` 두 곳에 있어요.

## 테스트 (방송 PC 없이)

```bash
sh tools/dev/up.sh     # 가짜 OBS + 가짜 치지직 + Allmind 실행 → http://127.0.0.1:8080
sh tools/dev/down.sh   # 끄기
```

처음 실행하면 `.dev/`에 테스트용 화면·음악·효과음과 설정 파일을 만들어요(ffmpeg 필요).

## 릴리스

릴리스는 **자동**입니다(`.github/workflows/release.yml`).

1. `package.json`의 `version`과 `src/server.js`의 `VERSION`을 올립니다(두 곳이 다르면 워크플로가 멈춰요).
2. `docs/release-notes/TEMPLATE.md`를 복사해 `docs/release-notes/X.Y.Z.md`로 저장하고 내용을 채웁니다.
3. 커밋 → `main` 푸시.
4. GitHub Actions가 exe를 빌드하고 태그 `vX.Y.Z` 릴리스를 만들어 `Allmind-X.Y.Z.exe`와 `THIRD_PARTY_NOTICES.txt`를 붙입니다. 진행 상황은 저장소의 **Actions** 탭에서 볼 수 있어요.

- 노트 파일(`X.Y.Z.md`)이 있으면 바로 **게시**되고, 없으면 **초안(draft)** 으로 만들어져요. 초안은 Releases 페이지에서 내용을 확인하고 직접 Publish 하면 됩니다.
- 그 버전의 릴리스가 이미 있으면 아무것도 하지 않아요. 실패했다면 Actions 탭의 **Run workflow**로 다시 돌릴 수 있습니다.
- 수동으로 만들고 싶다면: Releases → Draft a new release → 태그 `vX.Y.Z` → `dist/Allmind-X.Y.Z.exe`와 `THIRD_PARTY_NOTICES.txt` 첨부 → Publish.

> 앱 안의 업데이트 기능은 **가장 최신 Release**(초안·프리릴리스 제외)의 태그 `vX.Y.Z`와 첨부 파일 이름 `Allmind-X.Y.Z.exe`를 보고 새 버전을 찾습니다. 태그 숫자와 파일 이름의 버전이 다르면 인식하지 못해요.

exe는 저장소에 커밋하지 않습니다(`dist/`는 `.gitignore`). README의 다운로드 링크는 항상 최신 Release로 연결됩니다.
