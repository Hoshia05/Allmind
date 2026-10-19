# exe 빌드와 릴리스

`Arkbird.exe`는 Node 22 단일 실행 파일(SEA)이고, 배포용 `Arkbird-x.y.z.exe`는 그것을 xz로 압축해 푸는 작은 런처로 감싼 것입니다(약 20 MB). 빌드는 Linux/macOS/WSL에서 합니다.

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

결과는 `dist/Arkbird-<버전>.exe`이고, 안에 든 앱이 원본과 같은지도 확인합니다. 버전은 `package.json`의 `version`과 `src/server.js`의 `VERSION` 두 곳에 있어요.

## 테스트 (방송 PC 없이)

```bash
sh tools/dev/up.sh     # 가짜 OBS + 가짜 치지직 + Arkbird 실행 → http://127.0.0.1:8080
sh tools/dev/down.sh   # 끄기
```

처음 실행하면 `.dev/`에 테스트용 화면·음악·효과음과 설정 파일을 만들어요(ffmpeg 필요).

## 릴리스

1. 버전을 올리고 커밋 → `main` 푸시.
2. GitHub에서 **Releases → Draft a new release** → 태그 `vX.Y.Z` 입력 → **Create new tag**.
3. `dist/Arkbird-X.Y.Z.exe`와 `THIRD_PARTY_NOTICES.txt`를 첨부하고 **Publish release**.

> 앱 안의 업데이트 기능은 **가장 최신 Release**(초안·프리릴리스 제외)의 태그 `vX.Y.Z`와 첨부 파일 이름 `Arkbird-X.Y.Z.exe`를 보고 새 버전을 찾습니다. 태그 숫자와 파일 이름의 버전이 다르면 인식하지 못해요.

exe는 저장소에 커밋하지 않습니다(`dist/`는 `.gitignore`). README의 다운로드 링크는 항상 최신 Release로 연결됩니다.
