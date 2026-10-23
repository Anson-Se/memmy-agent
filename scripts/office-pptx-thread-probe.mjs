/** CI-only derived converter: keep production source and runtime unchanged. */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildThreadProbe(repo, program, evidence, { sourceOnly = false } = {}) {
  let source = await readFile(join(repo, "plugins/office/native/windows-convert.cpp"), "utf8");
  const replace = (from, to) => {
    if (!source.includes(from)) throw new Error(`Probe source anchor missing: ${from.slice(0, 80)}`);
    source = source.replace(from, to);
  };
  replace('#include <tlhelp32.h>', `#include <tlhelp32.h>
#include <wct.h>
#pragma comment(lib, "advapi32.lib")
static void diagnosticWaitChain(DWORD id) {
    HWCT session = OpenThreadWaitChainSession(0, NULL);
    if (!session) { fprintf(stderr, "WCT unavailable: %lu\\n", GetLastError()); return; }
    WAITCHAIN_NODE_INFO nodes[WCT_MAX_NODE_COUNT] = {};
    DWORD count = WCT_MAX_NODE_COUNT; BOOL cycle = FALSE;
    if (GetThreadWaitChain(session, 0, WCTP_GETINFO_ALL_FLAGS, id, &count, nodes, &cycle)) {
        fprintf(stderr, "WCT thread=%lu cycle=%d nodes=%lu\\n", id, cycle, count);
        for (DWORD i = 0; i < count; ++i) {
            fprintf(stderr, "  WCT node=%lu type=%d status=%d", i, (int)nodes[i].ObjectType, (int)nodes[i].ObjectStatus);
            if (nodes[i].ObjectType == WctThreadType)
                fprintf(stderr, " pid=%lu tid=%lu waitMs=%lu", nodes[i].ThreadObject.ProcessId, nodes[i].ThreadObject.ThreadId, nodes[i].ThreadObject.WaitTime);
            fputc('\\n', stderr);
        }
    } else fprintf(stderr, "WCT thread=%lu error=%lu\\n", id, GetLastError());
    CloseThreadWaitChainSession(session); fflush(stderr);
}
static BOOL CALLBACK diagnosticWindow(HWND window, LPARAM unused) {
    (void)unused; DWORD pid = 0; DWORD owner = GetWindowThreadProcessId(window, &pid);
    if (pid == GetCurrentProcessId()) {
        wchar_t kind[128] = {}; GetClassNameW(window, kind, 128);
        fwprintf(stderr, L"WINDOW hwnd=%p ownerTid=%lu class=%ls\\n", window, owner, kind);
    }
    return TRUE;
}`);
  replace('    // CI-only diagnostics for a headless engine stuck in native startup.', `    diagnosticWaitChain(id);
    EnumThreadWindows(id, diagnosticWindow, 0);
    // CI-only diagnostics for a headless engine stuck in native startup.`);
  replace('    void (*freeError)(char *);', `    void (*freeError)(char *);
    // Stable public Kit ABI, through runLoop (LibreOfficeKit.h, 26.2.6.2).
    void (*registerCallback)(Kit *, void (*)(int, const char *, void *), void *);
    char *(*getFilterTypes)(Kit *);
    void (*setOptionalFeatures)(Kit *, unsigned long long);
    void (*setDocumentPassword)(Kit *, const char *, const char *);
    char *(*getVersionInfo)(Kit *);
    int (*runMacro)(Kit *, const char *);
    bool (*signDocument)(Kit *, const char *, const unsigned char *, int, const unsigned char *, int);
    void (*runLoop)(Kit *, int (*)(void *, long long), void (*)(void *), void *);`);
  const start = source.indexOf('    trace("loading document");');
  const end = source.indexOf('\nint wmain(', start);
  if (start < 0 || end < 0) throw new Error("Cannot isolate converter load/save body");
  const body = source.slice(start, end);
  const helper = `
static int diagnosticLoadSave(Kit *kit, char *source, const wchar_t *input, const wchar_t *outdir, const wchar_t *format) {
    Document *document; const wchar_t *base, *dot; const char *extension;
    wchar_t output[32768]; char *target; int saved;
    fprintf(stderr, "LOADSAVE thread=%lu\\n", GetCurrentThreadId()); fflush(stderr);
${body}
struct DiagnosticJob { Kit *kit; char *source; const wchar_t *input, *outdir, *format; };
static DiagnosticJob job;
static void CALLBACK diagnosticTimer(HWND, UINT, UINT_PTR timer, DWORD) {
    KillTimer(NULL, timer);
    fprintf(stderr, "RUNLOOP callback thread=%lu\\n", GetCurrentThreadId()); fflush(stderr);
    int code = diagnosticLoadSave(job.kit, job.source, job.input, job.outdir, job.format);
    fprintf(stderr, "RUNLOOP conversion result=%d\\n", code); fflush(stderr);
    // Trusted diagnostic worker only: the test ends after save+dispose, rather
    // than trying to recursively shut down the outer soffice_main event loop.
    TerminateProcess(GetCurrentProcess(), code);
}
`;
  source = source.slice(0, start) + `    wchar_t mode[32] = {};
    GetEnvironmentVariableW(L"MEMMY_PPTX_THREAD_MODEL", mode, 32);
    if (!wcscmp(mode, L"runloop")) {
        if (kit->methods->size < offsetof(KitMethods, runLoop) + sizeof(kit->methods->runLoop) || !kit->methods->runLoop) return 2;
        job = {kit, source, input, outdir, format};
        if (!SetTimer(NULL, 0, 500, diagnosticTimer)) return 2;
        trace("entering runLoop");
        kit->methods->runLoop(kit, NULL, NULL, NULL);
        fprintf(stderr, "runLoop returned without conversion\\n"); return 2;
    }
    return diagnosticLoadSave(kit, source, input, outdir, format);
}
` + source.slice(end);
  source = source.replace('static int convert(int argc, wchar_t **argv) {', helper + '\nstatic int convert(int argc, wchar_t **argv) {');
  replace('    trace("initializing engine");', `    wchar_t threadMode[32] = {};
    GetEnvironmentVariableW(L"MEMMY_PPTX_THREAD_MODEL", threadMode, 32);
    if (!wcscmp(threadMode, L"runloop")) setEnvironment(L"SAL_LOK_OPTIONS", L"unipoll");
    fprintf(stderr, "INITIALIZE thread=%lu mode=%ls\\n", GetCurrentThreadId(), threadMode); fflush(stderr);
    trace("initializing engine");`);
  const probe = join(evidence, "thread-probe.cpp");
  await writeFile(probe, source);
  let builder = await readFile(join(repo, "plugins/office/scripts/build-windows-converter.mjs"), "utf8");
  builder = builder.replace('const source = fileURLToPath(new URL("../native/windows-convert.cpp", import.meta.url));', `const source = ${JSON.stringify(probe)};`)
    .replace('const manifest = fileURLToPath(new URL("../native/windows-convert.manifest", import.meta.url));', `const manifest = ${JSON.stringify(join(repo, "plugins/office/native/windows-convert.manifest"))};`);
  const buildFile = join(evidence, "build-thread-probe.mjs");
  await writeFile(buildFile, builder);
  if (sourceOnly) return { probe, buildFile };
  const { buildWindowsConverter } = await import(pathToFileURL(buildFile).href);
  await buildWindowsConverter(program);
}
