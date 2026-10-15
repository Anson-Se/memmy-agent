#!/usr/bin/env python3
"""One-time, user-initiated connection of the current personal WeChat account.

The UI must explain that WeChat will quit normally, a temporary copy may ask
for login, and the original app will reopen. This helper never runs merely
because the chat-reading permission was toggled on.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys
import time


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def command(arguments, *, env=None):
    result = subprocess.run(arguments, capture_output=True, text=True, env=env)
    if result.returncode:
        if arguments[0] == sys.executable:
            try:
                category = json.loads(result.stderr.strip().splitlines()[-1]).get("error")
                if isinstance(category, str) and re.fullmatch(r"[a-zA-Z_][a-zA-Z_:0-9-]{0,127}", category):
                    raise RuntimeError(category)
            except (ValueError, IndexError, AttributeError):
                pass
        raise RuntimeError("command_failed:" + Path(arguments[0]).name)
    return result.stdout or result.stderr


def prepare_permission_helper(state, app, lldb_path):
    # Resolve beside this script in both source and app.asar.unpacked builds.
    location = Path(__file__).with_name("permission_helper.py")
    spec = importlib.util.spec_from_file_location("memmy_wechat_permission_helper", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.prepare_permission_helper(state, app=app, lldb_path=lldb_path)


def private_storage_module():
    location = Path(__file__).with_name("private_storage.py")
    spec = importlib.util.spec_from_file_location("memmy_wechat_private_storage", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def storage_environment(storage, lldb_path):
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(("DYLD_", "MEMMY_WECHAT_"))}
    environment["PYTHONPATH"] = lldb_path
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    for source, copy in storage["mappings"].items():
        kind = "GROUP" if "/Group Containers/" in source else "CONTAINER"
        environment["MEMMY_WECHAT_" + kind + "_SOURCE"] = source
        environment["MEMMY_WECHAT_" + kind + "_COPY"] = copy
    return environment


def lldb_candidates():
    # Avoid the /usr/bin/lldb shim: it can open an installation dialog when no
    # developer tools are installed. Resolve the selected directory read-only.
    candidates = []
    try:
        selected = subprocess.run(["/usr/bin/xcode-select", "-p"],
                                  capture_output=True, text=True, timeout=5)
        directory = Path(selected.stdout.strip())
        if selected.returncode == 0 and directory.is_absolute():
            candidates.append(directory / "usr/bin/lldb")
    except (OSError, subprocess.TimeoutExpired):
        pass
    candidates.append(Path("/Library/Developer/CommandLineTools/usr/bin/lldb"))
    candidates.extend(sorted(Path("/Applications").glob("Xcode*.app/Contents/Developer/usr/bin/lldb")))
    return [path for path in dict.fromkeys(candidates) if path.is_file() and os.access(path, os.X_OK)]


def lldb_version(text):
    match = re.search(r"\blldb-(\d+(?:\.\d+)*)", text)
    return tuple(int(part) for part in match.group(1).split(".")) if match else None


def lldb_python_path():
    candidates = []
    for executable in lldb_candidates():
        try:
            result = subprocess.run([str(executable), "--version"], capture_output=True, text=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            continue
        version = lldb_version(result.stdout)
        if not result.returncode and version:
            candidates.append((version, executable))

    mac_version = platform.mac_ver()[0]
    mac_major = int(mac_version.split(".")[0]) if mac_version else 0
    incompatible = False
    compatible_found = False
    for version, executable in sorted(candidates, key=lambda item: item[0], reverse=True):
        # Xcode 27 uses Apple LLDB 2100+. The previous 1703 tools crash parsing
        # macOS 27's shared cache, including when debugging a tiny C program.
        # Check before importing/launching the capture helper or quitting WeChat.
        if mac_major >= 27 and version[0] < 2100:
            incompatible = True
            continue
        compatible_found = True
        try:
            result = subprocess.run([str(executable), "-P"], capture_output=True, text=True, timeout=10)
            location = result.stdout.strip()
            if result.returncode or not location or not Path(location).is_dir():
                continue
            environment = dict(os.environ, PYTHONPATH=location)
            imported = subprocess.run([sys.executable, "-c", "import lldb"],
                                      env=environment, capture_output=True, text=True, timeout=10)
            if imported.returncode == 0:
                return location
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise RuntimeError("lldb_incompatible" if incompatible and not compatible_found else "lldb_unavailable")


def wait_for_capture(process):
    category = None
    for line in process.stdout:
        # Keep progress visible to the caller and remember the helper's terminal
        # reason so a useful error is not replaced with key_capture_failed.
        print(line, end="", flush=True)
        try:
            status = json.loads(line)
        except (TypeError, ValueError):
            continue
        if (isinstance(status, dict) and status.get("event") == "capture_error"
                and isinstance(status.get("category"), str) and status["category"]):
            category = status["category"]
    return process.wait(), category


def capture_failure_category(code, output_exists, helper_category=None):
    if code < 0:
        return "key_capture_crashed"
    if helper_category:
        return helper_category
    if code == 3:
        return "key_capture_no_keys"
    if code != 0:
        return "key_capture_failed"
    if not output_exists:
        return "key_capture_output_missing"
    return None


def running_wechat():
    result = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True, text=True)
    return bool(result.stdout.strip())


def temporary_copy_running(shadow):
    result = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True, text=True)
    for pid in result.stdout.split():
        process = subprocess.run(["ps", "-p", pid, "-o", "comm="], capture_output=True, text=True)
        if str(shadow) in process.stdout:
            return True
    return False


def current_database_root():
    home = Path.home() / "Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"
    roots = []
    for candidate in home.glob("*/db_storage"):
        if candidate.is_symlink() or not candidate.is_dir():
            continue
        files = list(candidate.rglob("*.db"))
        if not files:
            continue
        roots.append(candidate.resolve(strict=True))
    if not roots:
        raise RuntimeError("wechat_login_required")
    if len(roots) == 1:
        return roots[0]

    # Modification time can select the wrong account when two accounts have
    # recently synced. Identify the database opened by the running original.
    pids = subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True, text=True).stdout.split()
    if pids:
        opened = subprocess.run(["/usr/sbin/lsof", "-Fn", "-p", ",".join(pids)],
                                capture_output=True, text=True)
        active = set()
        for line in opened.stdout.splitlines():
            if not line.startswith("n"):
                continue
            name = line[1:]
            for candidate in roots:
                if name.startswith(str(candidate) + os.sep):
                    active.add(candidate)
        if len(active) == 1:
            return next(iter(active))
    raise RuntimeError("current_account_ambiguous")


def private_save(path, value):
    temporary = path.with_name(path.name + ".new")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def consent_id(state):
    file = state / "consent.json"
    if not file.is_file() or file.is_symlink() or file.stat().st_mode & 0o077:
        return None
    try:
        value = json.loads(file.read_text())
        if value.get("version") == 1 and value.get("enabled") is True and value.get("consentedAt"):
            identifier = value.get("consentId")
            return identifier if isinstance(identifier, str) and identifier else None
        return None
    except (OSError, ValueError, AttributeError):
        return None


def resumable_cursor(state, root, active_consent_id):
    """Only retain a checkpoint from this account's still-enabled consent."""
    account_file = state / "account.json"
    if not account_file.exists() and not account_file.is_symlink():
        return None
    try:
        if (not account_file.is_file() or account_file.is_symlink()
                or account_file.stat().st_mode & 0o077):
            raise RuntimeError("private_file_required")
        account = json.loads(account_file.read_text())
        if (not isinstance(account, dict)
                or not isinstance(account.get("databaseRoot"), str)
                or not account["databaseRoot"].strip()
                or ("consentId" in account and
                    (not isinstance(account["consentId"], str) or not account["consentId"].strip()))):
            raise RuntimeError("invalid_account")
    except (OSError, ValueError) as error:
        raise RuntimeError("invalid_account") from error
    # Older connections did not record consentId. Revocation deletes their
    # account metadata too, so an extant legacy account can safely resume.
    if (account["databaseRoot"] != str(root)
            or account.get("consentId", active_consent_id) != active_consent_id):
        return None
    cursor_file = state / "cursor.json"
    if not cursor_file.exists() and not cursor_file.is_symlink():
        return None
    try:
        if (not cursor_file.is_file() or cursor_file.is_symlink()
                or cursor_file.stat().st_mode & 0o077):
            raise RuntimeError("private_file_required")
        cursor = json.loads(cursor_file.read_text())
        if (not isinstance(cursor, dict) or any(
                not isinstance(key, str)
                or not re.fullmatch(r"message_\d+\.db:Msg_[0-9a-f]{32}", key)
                or type(value) is not int or not 0 <= value <= 2 ** 53 - 1
                for key, value in cursor.items())):
            raise RuntimeError("invalid_cursor")
        return cursor
    except (OSError, ValueError) as error:
        raise RuntimeError("invalid_cursor") from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--library", type=Path)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--seconds", type=int, default=240)
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("mac_arm64_required")
    if os.geteuid() == 0:
        raise RuntimeError("root_execution_refused")
    state = Path(os.path.abspath(args.state))
    if args.prepare_only:
        try:
            result = prepare_permission_helper(state, Path("/Applications/WeChat.app"), lldb_python_path())
        except RuntimeError as error:
            category = str(error)
            if not re.fullmatch(r"[a-z_]+", category):
                category = "wechat_permission_helper_unavailable"
            result = {"ready": False, "appPath": None, "error": category}
        except Exception:
            result = {"ready": False, "appPath": None, "error": "wechat_permission_helper_unavailable"}
        emit("permission_prepared", **result)
        return 0
    active_consent_id = consent_id(state)
    if not active_consent_id:
        raise RuntimeError("wechat_consent_required")
    if args.library is None:
        raise RuntimeError("sqlcipher_library_unavailable")
    library = args.library.resolve(strict=True)
    app = Path("/Applications/WeChat.app").resolve(strict=True)
    original = app / "Contents/MacOS/WeChat"
    if not original.is_file():
        raise RuntimeError("wechat_application_missing")
    lldb_path = lldb_python_path()
    signature = command(["codesign", "-dvv", str(app)])
    command(["codesign", "--verify", "--deep", "--strict", str(app)])
    os.umask(0o077)
    state.mkdir(parents=True, mode=0o700, exist_ok=True)
    # Memmy checks its own source access and verifies private path redirection
    # before disturbing the original. The copy needs no separate disk grant.
    preparation = prepare_permission_helper(state, app, lldb_path)
    if not preparation["ready"]:
        raise RuntimeError(preparation["error"] or "wechat_data_access_required")
    # A missing/inaccessible database layout is checked only after Memmy's data
    # access has been verified, so a disk-permission error is not called logout.
    root = current_database_root()
    if consent_id(state) != active_consent_id:
        raise RuntimeError("wechat_consent_revoked")
    shadow = Path(preparation["appPath"])
    next_keys = state / "keys.next.json"
    next_cursor = state / "cursor.next.json"
    if next_keys.exists() or next_cursor.exists():
        raise RuntimeError("previous_connection_incomplete")
    resume = resumable_cursor(state, root, active_consent_id) is not None

    storage = None
    storage_module = private_storage_module()
    # Invalid aliases, ownership or special files are deterministic structural
    # failures. Check metadata while the original is still running; do not quit
    # it just to discover that a private session cannot be prepared.
    emit("preparing_wechat_data")
    storage_module.preflight_private_storage(state, consent_id=active_consent_id)
    restore_original = False
    try:
        original_was_running = running_wechat()
        if consent_id(state) != active_consent_id:
            raise RuntimeError("wechat_consent_revoked")
        if original_was_running:
            emit("quitting_original")
            subprocess.run(["osascript", "-e", 'tell application id "com.tencent.xinWeChat" to quit'],
                           capture_output=True, text=True)
            until = time.monotonic() + 20
            while running_wechat() and time.monotonic() < until:
                time.sleep(0.5)
            if running_wechat():
                raise RuntimeError("quit_wechat_manually")
            restore_original = True
        if consent_id(state) != active_consent_id:
            raise RuntimeError("wechat_consent_revoked")
        emit("preparing_wechat_data")
        # The only real-data snapshot is taken after normal quit has flushed
        # WeChat's databases and WAL files. Live writes are expected at preflight.
        storage = storage_module.create_private_storage(state, consent_id=active_consent_id)
        environment = storage_environment(storage, lldb_path)
        capture = Path(__file__).with_name("capture_keys.py")
        emit("awaiting_wechat_login")
        process = subprocess.Popen([
            sys.executable, str(capture), "--executable", str(shadow / "Contents/MacOS/WeChat"),
            "--root", str(root), "--output", str(next_keys),
            "--consent-file", str(state / "consent.json"),
            "--consent-id", active_consent_id, "--seconds", str(args.seconds),
        ], env=environment, stdout=subprocess.PIPE, text=True)
        code, helper_category = wait_for_capture(process)
        category = capture_failure_category(code, next_keys.exists(), helper_category)
        if category:
            raise RuntimeError(category)
        reader = Path(__file__).with_name("read_messages.py")
        emit("verifying_databases")
        baseline = command([
            sys.executable, str(reader), "baseline", "--root", str(root),
            "--keys", str(next_keys), "--library", str(library),
        ])
        result = json.loads(baseline)
        if not result.get("databaseCount") or result.get("messages"):
            raise RuntimeError("database_baseline_failed")
        if consent_id(state) != active_consent_id:
            raise RuntimeError("wechat_consent_revoked")
        if not resume:
            private_save(next_cursor, result["nextCursor"])
        if consent_id(state) != active_consent_id:
            raise RuntimeError("wechat_consent_revoked")
        os.replace(next_keys, state / "keys.json")
        # Baseline still verifies the captured keys, but reconnect must not
        # acknowledge rows that have not been durably accepted by History.
        # Leave the existing file untouched, including any concurrent poll ack.
        if not resume:
            os.replace(next_cursor, state / "cursor.json")
        private_save(state / "account.json", {"databaseRoot": str(root),
                                              "consentId": active_consent_id,
                                              "connectedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        emit("connected", verified_message_databases=result["databaseCount"])
        return 0
    except Exception as error:
        # Report the cause before restoration updates the observable phase.
        emit("connection_error", category=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        raise
    finally:
        if "process" in locals() and process.poll() is None:
            try:
                process.send_signal(signal.SIGINT)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        signature_ok = False
        try:
            signature_ok = command(["codesign", "-dvv", str(app)]) == signature
        except RuntimeError:
            pass
        temporary_running = temporary_copy_running(shadow)
        cleanup_error = None
        if temporary_running:
            emit("manual_restore_required", reason="temporary_wechat_still_running")
        else:
            if storage is not None:
                try:
                    storage_module.cleanup(storage["sessionPath"], state)
                except (OSError, RuntimeError) as error:
                    cleanup_error = error
            # Retain only the inert connection executable; session data is gone.
            if restore_original and not running_wechat():
                reopened = subprocess.run(["open", "-a", "/Applications/WeChat.app"], capture_output=True)
                emit("original_reopened", success=reopened.returncode == 0)
        next_keys.unlink(missing_ok=True)
        next_keys.with_suffix(".pending").unlink(missing_ok=True)
        next_cursor.unlink(missing_ok=True)
        if consent_id(state) != active_consent_id:
            (state / "keys.json").unlink(missing_ok=True)
            (state / "account.json").unlink(missing_ok=True)
        if not signature_ok:
            raise RuntimeError("original_signature_check_failed")
        if temporary_running:
            raise RuntimeError("temporary_wechat_still_running")
        if cleanup_error is not None:
            raise RuntimeError("wechat_private_storage_cleanup_failed") from cleanup_error


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        emit("connection_error", category=str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        raise SystemExit(2)
