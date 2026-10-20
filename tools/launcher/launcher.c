// Allmind.exe — small self-unpacking launcher.
//
// The real app (a ~80 MB Node single-executable) is appended to this file,
// xz-compressed (~21 MB). On start we unpack it once to
//   %LOCALAPPDATA%\Allmind\app\Allmind-<version>.exe
// and run it. Later starts of the same version skip straight to running it.
//
// Layout of this file:  [launcher exe][xz payload][u64 payload size]["SDPAYLD1"]
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <wchar.h>
#include "xz.h"

#ifndef SD_VERSION
#define SD_VERSION L"dev"
#endif

static void fail(const wchar_t *what, DWORD err) {
  wchar_t msg[1024];
  _snwprintf(msg, 1024, L"Allmind를 시작하지 못했어요.\n\n%ls (오류 %lu)", what, (unsigned long)err);
  MessageBoxW(NULL, msg, L"Allmind", MB_ICONERROR | MB_OK);
  ExitProcess(1);
}

static int file_exists(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

// Remove app copies of other versions (ignored if one is still running).
static void clean_old(const wchar_t *dir, const wchar_t *keep) {
  wchar_t pattern[MAX_PATH];
  _snwprintf(pattern, MAX_PATH, L"%ls\\Allmind-*.exe", dir);
  WIN32_FIND_DATAW fd;
  HANDLE h = FindFirstFileW(pattern, &fd);
  if (h == INVALID_HANDLE_VALUE) return;
  do {
    if (_wcsicmp(fd.cFileName, keep) == 0) continue;
    wchar_t full[MAX_PATH];
    _snwprintf(full, MAX_PATH, L"%ls\\%ls", dir, fd.cFileName);
    DeleteFileW(full);
  } while (FindNextFileW(h, &fd));
  FindClose(h);
}

static void unpack(const wchar_t *self, const wchar_t *target) {
  HANDLE in = CreateFileW(self, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (in == INVALID_HANDLE_VALUE) fail(L"자기 자신의 파일을 읽을 수 없음", GetLastError());

  LARGE_INTEGER size;
  GetFileSizeEx(in, &size);
  unsigned char tail[16];
  DWORD got = 0;
  LARGE_INTEGER pos;
  pos.QuadPart = size.QuadPart - 16;
  SetFilePointerEx(in, pos, NULL, FILE_BEGIN);
  if (!ReadFile(in, tail, 16, &got, NULL) || got != 16 || memcmp(tail + 8, "SDPAYLD1", 8) != 0)
    fail(L"실행 파일이 손상됐어요 — 다시 받아 주세요", 0);
  unsigned long long payload = 0;
  memcpy(&payload, tail, 8);
  pos.QuadPart = size.QuadPart - 16 - (LONGLONG)payload;
  SetFilePointerEx(in, pos, NULL, FILE_BEGIN);

  wchar_t tmp[MAX_PATH];
  _snwprintf(tmp, MAX_PATH, L"%ls.part", target);
  HANDLE out = CreateFileW(tmp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (out == INVALID_HANDLE_VALUE) fail(L"압축을 풀 파일을 만들 수 없음", GetLastError());

  xz_crc32_init();
  struct xz_dec *dec = xz_dec_init(XZ_DYNALLOC, 1u << 27);
  if (!dec) fail(L"메모리가 부족해요", 0);
  static unsigned char ibuf[1 << 16], obuf[1 << 18];
  struct xz_buf b = { ibuf, 0, 0, obuf, 0, sizeof(obuf) };
  unsigned long long left = payload;
  enum xz_ret ret = XZ_OK;
  for (;;) {
    if (b.in_pos == b.in_size && left > 0) {
      DWORD want = left > sizeof(ibuf) ? sizeof(ibuf) : (DWORD)left;
      if (!ReadFile(in, ibuf, want, &got, NULL) || got == 0) fail(L"압축 데이터를 읽지 못함", GetLastError());
      b.in_size = got;
      b.in_pos = 0;
      left -= got;
    }
    ret = xz_dec_run(dec, &b);
    if (b.out_pos == sizeof(obuf) || ret == XZ_STREAM_END) {
      DWORD w = 0;
      if (!WriteFile(out, obuf, (DWORD)b.out_pos, &w, NULL) || w != b.out_pos) fail(L"압축을 푸는 중 쓰기 실패 (디스크 공간?)", GetLastError());
      b.out_pos = 0;
    }
    if (ret == XZ_STREAM_END) break;
    if (ret != XZ_OK) fail(L"압축 데이터가 손상됐어요 — 다시 받아 주세요", (DWORD)ret);
  }
  xz_dec_end(dec);
  CloseHandle(out);
  CloseHandle(in);
  if (!MoveFileExW(tmp, target, MOVEFILE_REPLACE_EXISTING)) {
    DWORD e = GetLastError();
    DeleteFileW(tmp);
    if (!file_exists(target)) fail(L"압축을 푼 파일을 옮기지 못함", e);
  }
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE hp, PWSTR cmd, int show) {
  (void)hi; (void)hp; (void)show;
  wchar_t self[MAX_PATH], base[MAX_PATH], dir[MAX_PATH], name[128], target[MAX_PATH];
  if (!GetModuleFileNameW(NULL, self, MAX_PATH)) fail(L"경로를 알 수 없음", GetLastError());

  if (SHGetFolderPathW(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, base) != S_OK) fail(L"LOCALAPPDATA를 찾을 수 없음", 0);
  _snwprintf(dir, MAX_PATH, L"%ls\\Allmind", base);
  CreateDirectoryW(dir, NULL);
  _snwprintf(dir, MAX_PATH, L"%ls\\Allmind\\app", base);
  CreateDirectoryW(dir, NULL);
  _snwprintf(name, 128, L"Allmind-%ls.exe", SD_VERSION);
  _snwprintf(target, MAX_PATH, L"%ls\\%ls", dir, name);

  // Only one launcher unpacks at a time (double-clicks, auto-start…).
  HANDLE mx = CreateMutexW(NULL, FALSE, L"Local\\AllmindUnpack");
  if (mx) WaitForSingleObject(mx, 120000);
  if (!file_exists(target)) {
    unpack(self, target);
    clean_old(dir, name);
  }
  if (mx) { ReleaseMutex(mx); CloseHandle(mx); }

  // Run it with the same arguments we got.
  size_t n = wcslen(target) + wcslen(cmd) + 8;
  wchar_t *line = (wchar_t *)malloc(n * sizeof(wchar_t));
  _snwprintf(line, n, L"\"%ls\" %ls", target, cmd);
  STARTUPINFOW si = { sizeof(si) };
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(target, line, NULL, NULL, FALSE, 0, NULL, dir, &si, &pi)) {
    DWORD e = GetLastError();
    DeleteFileW(target); // maybe a broken unpack; next start redoes it
    fail(L"앱을 실행하지 못했어요 (백신이 막았을 수 있어요)", e);
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return 0;
}
