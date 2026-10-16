# exe 빌드와 릴리스

`StreamDesk.exe`는 Node 22 단일 실행 파일(SEA)이고, 배포용 `StreamDesk-x.y.z.exe`는 그것을 xz로 압축해 푸는 작은 런처로 감싼 것입니다(약 20 MB). 빌드는 Linux/macOS/WSL에서 합니다.

## 준비물

- Node.js 22 (`node -v`)
- 같은 버전의 **Windows용 node.exe**: https://nodejs.org/dist/ 에서 `node-vX.Y.Z-win-x64.zip`을 받아 `node.exe`를 꺼냅니다. 버전이 지금 쓰는 Node와 정확히 같아야 합니다.
- `pip install ziglang` (런처를 Windows용으로 컴파일)
- `xz` 명령
- [xz-embedded](https://github.com/tukaani-project/xz-embedded) 체크아웃 (`XZ_EMBEDDED` 환경변수로 경로 지정)

## 빌드

```bash
npm install
node tools/build-exe.mjs /path/to/node.exe
XZ_EMBEDDED=/path/to/xz-embedded node tools/build-launcher.mjs
```

결과는 `dist/StreamDesk-<버전>.exe`입니다. 버전은 `package.json`의 `version`을 따릅니다.

## 릴리스

1. `package.json`의 `version`을 올리고 커밋합니다.
2. 위 순서로 빌드합니다.
3. 태그를 만들고 푸시합니다.
   ```bash
   git tag v0.13.0 && git push --tags
   ```
4. GitHub에서 그 태그로 Release를 만들고 `dist/StreamDesk-0.13.0.exe`를 첨부합니다.
   ```bash
   gh release create v0.13.0 dist/StreamDesk-0.13.0.exe --title "v0.13.0" --notes "변경 사항"
   ```

exe는 저장소에 커밋하지 않습니다(`dist/`는 `.gitignore`). README의 다운로드 링크는 항상 최신 Release로 연결됩니다.
