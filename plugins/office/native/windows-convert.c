/* Headless LibreOfficeKit converter. Keeps the desktop single-instance pipe
 * out of AppContainer; conversion still runs with the plugin's restricted token.
 * Uses the stable public LibreOfficeKit C ABI, loaded from the verified runtime. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

typedef struct Kit Kit;
typedef struct Document Document;
typedef struct {
    size_t size;
    void (*destroy)(Kit *);
    Document *(*load)(Kit *, const char *);
    char *(*error)(Kit *);
    Document *(*loadOptions)(Kit *, const char *, const char *);
    void (*freeError)(char *);
} KitMethods;
typedef struct {
    size_t size;
    void (*destroy)(Document *);
    int (*save)(Document *, const char *, const char *, const char *);
} DocumentMethods;
struct Kit { KitMethods *methods; };
struct Document { DocumentMethods *methods; };
typedef Kit *(__cdecl *Initialize)(const char *, const char *);

static char *utf8(const wchar_t *value) {
    int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, NULL, 0, NULL, NULL);
    char *result = (char *)calloc((size_t)size, 1);
    if (!size || !result || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, result, size, NULL, NULL)) return NULL;
    return result;
}
static char *fileUrl(const wchar_t *value) {
    char *bytes = utf8(value), *result, *out;
    const unsigned char *p;
    const char hex[] = "0123456789ABCDEF";
    if (!bytes) return NULL;
    result = (char *)calloc(strlen(bytes) * 3 + 16, 1);
    if (!result) { free(bytes); return NULL; }
    strcpy_s(result, strlen(bytes) * 3 + 16, "file:///"); out = result + 8;
    for (p = (unsigned char *)bytes; *p; ++p) {
        if (*p == '\\') *out++ = '/';
        else if ((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || strchr("-._~/:", *p)) *out++ = (char)*p;
        else { *out++ = '%'; *out++ = hex[*p >> 4]; *out++ = hex[*p & 15]; }
    }
    free(bytes); return result;
}
static int error(Kit *kit, const char *stage) {
    char *message = kit && kit->methods->error ? kit->methods->error(kit) : NULL;
    fprintf(stderr, "LibreOfficeKit %s failed: %s (Windows %lu)\n", stage, message ? message : "no engine diagnostic", GetLastError());
    if (message && kit->methods->size >= offsetof(KitMethods, freeError) + sizeof(kit->methods->freeError)) kit->methods->freeError(message);
    return 1;
}
int wmain(int argc, wchar_t **argv) {
    wchar_t directory[32768], library[32768], output[32768];
    const wchar_t *profile = NULL, *input = NULL, *outdir = NULL, *format = NULL, *base, *dot;
    HMODULE module; Initialize initialize; Kit *kit; Document *document;
    char *install, *user, *source, *target; const char *extension;
    int i, saved;
    for (i = 1; i < argc; ++i) {
        if (!wcsncmp(argv[i], L"-env:UserInstallation=", 22)) profile = argv[i] + 22;
        else if (!wcscmp(argv[i], L"--convert-to") && i + 1 < argc) format = argv[++i];
        else if (!wcscmp(argv[i], L"--outdir") && i + 1 < argc) outdir = argv[++i];
        else if (argv[i][0] != L'-') input = argv[i];
    }
    if (!profile || !input || !outdir || !format || (wcscmp(format, L"pdf") && wcscmp(format, L"xlsx:Calc MS Excel 2007 XML"))) {
        fprintf(stderr, "Expected an isolated profile, input, output directory and PDF/XLSX conversion\n"); return 2;
    }
    if (!GetModuleFileNameW(NULL, directory, 32768)) return error(NULL, "module path");
    base = wcsrchr(directory, L'\\'); if (!base) return 2;
    directory[base - directory] = 0;
    SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    if (!AddDllDirectory(directory)) return error(NULL, "DLL directory");
    swprintf_s(library, 32768, L"%ls\\mergedlo.dll", directory);
    module = LoadLibraryExW(library, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    if (!module) {
        swprintf_s(library, 32768, L"%ls\\sofficeapp.dll", directory);
        module = LoadLibraryExW(library, NULL, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    }
    if (!module) return error(NULL, "library load");
    initialize = (Initialize)(void *)GetProcAddress(module, "libreofficekit_hook_2");
    if (!initialize) return error(NULL, "entrypoint");
    install = utf8(directory); user = utf8(profile); source = fileUrl(input);
    if (!install || !user || !source) return 2;
    SetEnvironmentVariableW(L"SAL_USE_VCLPLUGIN", L"svp");
    SetEnvironmentVariableW(L"SAL_DISABLE_OPENCL", L"1");
    kit = initialize(install, user);
    free(install); free(user);
    if (!kit) { free(source); return error(NULL, "initialization"); }
    // The profile disables macros and external-link refresh before loading.
    document = kit->methods->loadOptions(kit, source, "Batch=true,EnableMacrosExecution=false,MacroSecurityLevel=3");
    free(source);
    if (!document) return error(kit, "document load");
    base = wcsrchr(input, L'\\'); if (!base) base = wcsrchr(input, L'/'); base = base ? base + 1 : input;
    dot = wcsrchr(base, L'.'); if (!dot) dot = base + wcslen(base);
    extension = !wcscmp(format, L"pdf") ? "pdf" : "xlsx";
    swprintf_s(output, 32768, L"%ls\\%.*ls.%ls", outdir, (int)(dot - base), base, !strcmp(extension, "pdf") ? L"pdf" : L"xlsx");
    target = fileUrl(output); if (!target) return 2;
    saved = document->methods->save(document, target, extension, NULL);
    free(target);
    if (!saved) return error(kit, "save");
    document->methods->destroy(document);
    kit->methods->destroy(kit);
    return 0;
}
