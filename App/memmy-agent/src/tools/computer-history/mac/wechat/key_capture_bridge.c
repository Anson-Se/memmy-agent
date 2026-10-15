// Capture SQLCipher key-derivation parameters from the one temporary WeChat
// process this helper launches. Injected only into "Memmy WeChat Reader.app",
// alongside the private-storage bridge, so the host no longer needs a debugger
// (LLDB) and therefore no Xcode or Command Line Tools on the user's Mac.
//
// This records candidate material to a private sink the host verifies against
// real database pages; it never attaches to another process, changes the
// original app, or weakens SIP. The real CommonCrypto call always runs so the
// launched copy behaves normally.
#include <CommonCrypto/CommonKeyDerivation.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Apple's documented dyld __DATA,__interpose tuple, matching private_storage_bridge.c.
#define DYLD_INTERPOSE(replacement, original) \
    __attribute__((used)) static const struct { const void *replacement; const void *original; } \
    interpose_##replacement __attribute__((section("__DATA,__interpose"))) = \
    { (const void *)(uintptr_t)&replacement, (const void *)(uintptr_t)&original }

// SQLCipher 4 uses an HMAC-SHA512 PRF, a 16-byte salt, and either the 256000-round
// passphrase derivation or the 2-round HMAC-key derivation. Bound the password so
// a stray caller cannot make the sink grow without limit.
#define MEMMY_SALT_LENGTH 16
#define MEMMY_MAX_PASSWORD 256

static int sink_descriptor = -1;
static pthread_mutex_t sink_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_once_t sink_ready = PTHREAD_ONCE_INIT;

static void open_sink(void) {
    const char *path = getenv("MEMMY_WECHAT_KEY_SINK");
    if (path == NULL || path[0] != '/') return;
    // The host pre-creates the sink with 0600; only append so a hostile symlink
    // swap cannot redirect us to a new file, and never follow a final symlink.
    sink_descriptor = open(path, O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW);
}

static void write_all(const void *data, size_t length) {
    const uint8_t *bytes = data;
    for (size_t written = 0; written < length;) {
        ssize_t count = write(sink_descriptor, bytes + written, length - written);
        if (count > 0) { written += (size_t)count; continue; }
        if (count < 0 && errno == EINTR) continue;
        return; // A broken sink simply yields no key; the host times out safely.
    }
}

// Record layout the host parses: "MKC1" | rounds u32le | saltLen u32le | pwLen u32le | salt | password.
static void capture(unsigned rounds, const uint8_t *salt, size_t salt_length,
                    const char *password, size_t password_length) {
    if (salt == NULL || password == NULL) return;
    if (salt_length != MEMMY_SALT_LENGTH) return;
    if (password_length == 0 || password_length > MEMMY_MAX_PASSWORD) return;
    if (rounds != 2 && rounds != 256000) return;
    pthread_once(&sink_ready, open_sink);
    if (sink_descriptor < 0) return;
    uint8_t header[16];
    memcpy(header, "MKC1", 4);
    uint32_t values[3] = { (uint32_t)rounds, (uint32_t)salt_length, (uint32_t)password_length };
    memcpy(header + 4, values, sizeof values);
    pthread_mutex_lock(&sink_lock);
    write_all(header, sizeof header);
    write_all(salt, salt_length);
    write_all(password, password_length);
    pthread_mutex_unlock(&sink_lock);
}

static int memmy_key_derivation_pbkdf(CCPBKDFAlgorithm algorithm, const char *password, size_t password_length,
                                      const uint8_t *salt, size_t salt_length, CCPseudoRandomAlgorithm prf,
                                      unsigned rounds, uint8_t *derived_key, size_t derived_key_length) {
    if (prf == kCCPRFHmacAlgSHA512) {
        capture(rounds, salt, salt_length, password, password_length);
    }
    // Calling the symbol by name inside an interpose reaches the real function.
    return CCKeyDerivationPBKDF(algorithm, password, password_length, salt, salt_length,
                                prf, rounds, derived_key, derived_key_length);
}
DYLD_INTERPOSE(memmy_key_derivation_pbkdf, CCKeyDerivationPBKDF);
