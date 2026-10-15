"""Consent-gated copy-on-write storage for a private WeChat connection session.

Only the current user's two fixed WeChat containers are accepted. Source data is
never written, decoded, or emitted. There is deliberately no bulk-copy fallback.
"""
import ctypes
import errno
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import stat
import tempfile
import time


_CONTAINER = "Library/Containers/com.tencent.xinWeChat"
_GROUP = "Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"
_SESSION = re.compile(r"storage-session-[0-9a-f]{32}\Z")
_MARKER = ".memmy-private-storage.json"
_LIBRARY_ALIASES = (
    "Filters", "Calendars", "PDF Services", "Keychains", "ColorPickers", "KeyBindings",
    "ColorSync", "QuickLook", "Mail", "Compositions", "Favorites", "FontCollections",
    "Sounds", "Components", "Audio", "Keyboard Layouts", "Colors", "Dictionaries",
    "Fonts", "Spelling", "Input Methods", "Application Support/SyncServices",
    "Application Support/AddressBook", "Application Support/iCloud",
    "Application Scripts/com.tencent.xinWeChat", "Images/People",
)
_LIBRARY_FILE_ALIASES = ("Preferences/com.apple.security.plist", "Preferences/com.apple.security_common.plist")
_GROUP_SCRIPT_ALIAS = Path("Library/Application Scripts/5A4RE8SF68.com.tencent.xinWeChat")
_HOME_ALIASES = ("Music", "Pictures", "Desktop", "Movies", "Downloads", ".CFUserTextEncoding")
_METADATA_ATTEMPTS = 2
_METADATA_SECONDS = 120


class WeChatMetadataAccessError(RuntimeError):
    """A stable category and content-free context for interrupted source metadata."""

    def __init__(self, category, operation, error_number, source):
        super().__init__(category)
        self.diagnostic = {"operation": operation, "errno": error_number, "source": source}


class _SourceMetadata:
    def __init__(self, guard, home):
        self.guard = guard
        self.home = home
        self.elapsed = 0

    def _source(self, root):
        if root == self.home / _CONTAINER:
            return "container"
        if root == self.home / _GROUP:
            return "group_container"
        return "unknown"

    def _check_time(self, operation, root):
        if self.elapsed >= _METADATA_SECONDS:
            raise WeChatMetadataAccessError("wechat_data_access_timeout", operation,
                                           errno.ETIMEDOUT, self._source(root))

    def _once(self, operation, root, action):
        self.guard()
        self._check_time(operation, root)
        started = time.monotonic()
        try:
            result = action()
        finally:
            # Count only guarded source metadata calls, not cloning or writing a
            # potentially large snapshot. A synchronous OS call may return late;
            # check its elapsed time before any subsequent work or retry.
            self.elapsed += max(0, time.monotonic() - started)
        if operation == "scandir" and self.elapsed >= _METADATA_SECONDS:
            result.close()
        self._check_time(operation, root)
        return result

    def call(self, operation, root, action):
        for attempt in range(_METADATA_ATTEMPTS):
            try:
                return self._once(operation, root, action)
            except OSError as error:
                if error.errno != errno.EINTR:
                    raise
                self._check_time(operation, root)
                if attempt + 1 == _METADATA_ATTEMPTS:
                    raise WeChatMetadataAccessError("wechat_data_access_interrupted", operation,
                                                   errno.EINTR, self._source(root)) from None

    def entries(self, source, root):
        for attempt in range(_METADATA_ATTEMPTS):
            operation = "scandir"
            try:
                # Recheck the source directory on a restarted enumeration too.
                _source_directory(source, root, self)
                with self._once(operation, root, lambda: os.scandir(source)) as entries:
                    names = []
                    operation = "scandir_next"
                    while True:
                        try:
                            entry = self._once(operation, root, lambda: next(entries))
                        except StopIteration:
                            break
                        names.append(entry.name)
                self._check_time(operation, root)
                return names
            except OSError as error:
                if error.errno != errno.EINTR:
                    raise
                self._check_time(operation, root)
                if attempt + 1 == _METADATA_ATTEMPTS:
                    raise WeChatMetadataAccessError("wechat_data_access_interrupted", operation,
                                                   errno.EINTR, self._source(root)) from None
                # CPython can close a scandir iterator after EINTR. Discard the
                # partial enumeration and reopen it; never retry next() on the
                # failed iterator or expose partial names to validation/copying.


def _lstat(path, metadata=None, root=None):
    return metadata.call("lstat", root, path.lstat) if metadata else path.lstat()


def _real_home():
    return Path(pwd.getpwuid(os.getuid()).pw_dir)


def _absolute(path):
    path = Path(path)
    if ".." in path.parts:
        raise RuntimeError("wechat_private_storage_unsafe_path")
    return Path(os.path.abspath(path))


def _ancestors(path):
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError("wechat_private_storage_unsafe_path")
        if item != path and (not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022):
            # A sticky system temporary ancestor is safe only because the
            # managed state itself must be owned, private and already present.
            if not (stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & stat.S_ISVTX):
                raise RuntimeError("wechat_private_storage_unsafe_path")
        if info.st_uid not in (0, os.getuid()):
            raise RuntimeError("wechat_private_storage_unsafe_path")


def _directory(path, private=False, metadata=None, root=None):
    if metadata:
        return metadata.call("lstat", root, lambda: _directory(path, private=private))
    _ancestors(path)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & (0o077 if private else 0o022)):
        raise RuntimeError("wechat_private_storage_unsafe_path")
    return info


def _source_directory(path, root, metadata=None):
    if metadata:
        # One guarded, read-only validation per attempt. If any stat is
        # interrupted, rerun every ancestry/ownership check after rechecking
        # consent instead of reading consent again for each ancestor.
        return metadata.call("lstat", root, lambda: _source_directory(path, root))
    # The fixed container root and its ancestors remain private to the user.
    # Within it, WeChat creates ordinary caches with shared modes (even 0777).
    # Source modes do not carry into the independent private snapshot.
    path.relative_to(root)
    _directory(root)
    for item in (path, *path.parents):
        if item == root:
            break
        info = item.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("wechat_private_storage_unsafe_path")
    return path.lstat()


def _read_private_json(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.getuid() or info.st_mode & 0o077):
            raise RuntimeError("wechat_private_storage_unsafe_path")
        value = os.read(descriptor, 4097)
        if len(value) > 4096:
            raise ValueError("oversized private storage metadata")
        return json.loads(value)
    finally:
        os.close(descriptor)


def _consent(state, identifier, initial=False):
    valid = False
    try:
        _directory(state, private=True)
        value = _read_private_json(state / "consent.json")
        valid = (isinstance(identifier, str) and bool(identifier) and isinstance(value, dict)
                 and value.get("version") == 1 and value.get("enabled") is True
                 and bool(value.get("consentedAt")) and value.get("consentId") == identifier)
    except (OSError, ValueError, RuntimeError):
        pass
    if not valid:
        raise RuntimeError("wechat_consent_required" if initial else "wechat_consent_revoked")


def _write_private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())


def _clone_file(source, destination, metadata=None, root=None):
    source_descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    destination_descriptor = None
    try:
        info = os.fstat(source_descriptor)
        expected = _lstat(source, metadata, root)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or (info.st_dev, info.st_ino) != (expected.st_dev, expected.st_ino)):
            raise RuntimeError("wechat_private_storage_unsafe_path")
        # F_GETPATH is public Darwin fcntl(2). It binds the open descriptor to
        # the fixed source spelling rather than following a raced ancestor link.
        actual_path = fcntl.fcntl(source_descriptor, 50, b"\0" * 1024).split(b"\0", 1)[0]
        if os.fsdecode(actual_path) != str(source):
            raise RuntimeError("wechat_private_storage_unsafe_path")
        destination_descriptor = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        function = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True).fclonefileat
        function.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        function.restype = ctypes.c_int
        # CLONE_NOOWNERCOPY | CLONE_NOFOLLOW_ANY; never clone source ACLs.
        if function(source_descriptor, destination_descriptor, os.fsencode(destination.name), 0x0002 | 0x0008) != 0:
            raise RuntimeError("wechat_private_storage_clone_failed")
        after = os.fstat(source_descriptor)
        if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (info.st_size, info.st_mtime_ns, info.st_ctime_ns):
            raise RuntimeError("wechat_private_storage_source_changed")
        cloned = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            copied = os.fstat(cloned)
            if (not stat.S_ISREG(copied.st_mode) or copied.st_uid != os.getuid() or copied.st_nlink != 1
                    or (copied.st_dev, copied.st_ino) == (info.st_dev, info.st_ino)):
                raise RuntimeError("wechat_private_storage_unsafe_path")
            os.fchmod(cloned, 0o600)
        finally:
            os.close(cloned)
    except (OSError, AttributeError):
        raise RuntimeError("wechat_private_storage_clone_failed") from None
    finally:
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        os.close(source_descriptor)


def _standard_alias(relative, target, home, root=None):
    if Path(target).is_absolute():
        return False
    if root == home / _GROUP:
        return (relative == _GROUP_SCRIPT_ALIAS
                and Path(os.path.normpath(root / relative.parent / target)) == home / _GROUP_SCRIPT_ALIAS)
    aliases = {Path("Data") / name: home / name for name in _HOME_ALIASES}
    aliases.update({Path("Data/Library") / name: home / "Library" / name for name in _LIBRARY_ALIASES})
    aliases.update({Path("Data/Library") / name: home / "Library" / name for name in _LIBRARY_FILE_ALIASES})
    expected = aliases.get(relative)
    if expected is None:
        return False
    original_parent = home / _CONTAINER / relative.parent
    return Path(os.path.normpath(original_parent / target)) == expected


def _source_item(path, root, home, metadata=None):
    info = _lstat(path, metadata, root)
    if info.st_uid != os.getuid():
        raise RuntimeError("wechat_private_storage_unsafe_path")
    if stat.S_ISLNK(info.st_mode):
        target = metadata.call("readlink", root, lambda: os.readlink(path)) if metadata else os.readlink(path)
        relative = path.relative_to(root)
        if root in (home / _CONTAINER, home / _GROUP) and _standard_alias(relative, target, home, root):
            return info, target, True
        if Path(target).is_absolute():
            raise RuntimeError("wechat_private_storage_unsafe_path")
        try:
            path.resolve(strict=False).relative_to(root)
        except (ValueError, RuntimeError):
            raise RuntimeError("wechat_private_storage_unsafe_path") from None
        return info, target, False
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        raise RuntimeError("wechat_private_storage_unsafe_path")
    return info, None, False


def _preflight_tree(source, root, home, guard, metadata):
    guard()
    for name in metadata.entries(source, root):
        guard()
        path = source / name
        try:
            info, _, _ = _source_item(path, root, home, metadata)
            if stat.S_ISDIR(info.st_mode):
                _preflight_tree(path, root, home, guard, metadata)
        except FileNotFoundError:
            # WeChat may remove a live cache entry after enumeration. The
            # fixed roots are checked again below; final cloning is strict.
            continue
    guard()


def _preflight_clone(state, roots, guard, metadata):
    device = _directory(state, private=True).st_dev
    if any(_directory(root, metadata=metadata, root=root).st_dev != device for root in roots):
        raise RuntimeError("wechat_private_storage_clone_failed")
    # Prove copy-on-write support using our own inert bytes on the same volume.
    # Never clone changing chat data or create a file in the source containers.
    with tempfile.TemporaryDirectory(prefix="clone-preflight-", dir=state) as temporary:
        directory = Path(temporary)
        source = directory / "source"
        descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(b"Memmy private storage clone preflight\n")
        guard()
        _clone_file(source, directory / "copy")
        guard()


def preflight_private_storage(state, consent_id):
    """Check paths and inert clone support before normally quitting WeChat."""
    state = _absolute(state)
    home = _absolute(_real_home())
    _directory(state, private=True)
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise RuntimeError("root_execution_refused")
    _consent(state, consent_id, initial=True)
    guard = lambda: _consent(state, consent_id)
    metadata = _SourceMetadata(guard, home)
    container = home / _CONTAINER
    _preflight_tree(container, container, home, guard, metadata)
    roots = [container]
    group = home / _GROUP
    try:
        _lstat(group, metadata, group)
    except FileNotFoundError:
        pass
    else:
        _preflight_tree(group, group, home, guard, metadata)
        roots.append(group)
    _preflight_clone(state, roots, guard, metadata)


def _clone_tree(source, destination, root, home, guard, metadata):
    guard()
    original = _source_directory(source, root, metadata)
    names = metadata.entries(source, root)
    destination.mkdir(mode=0o700)
    for name in names:
        guard()
        path = source / name
        copy = destination / name
        info, target, standard_alias = _source_item(path, root, home, metadata)
        if stat.S_ISLNK(info.st_mode):
            relative = path.relative_to(root)
            if standard_alias:
                if relative == Path("Data/.CFUserTextEncoding") or relative in {
                        Path("Data/Library") / name for name in _LIBRARY_FILE_ALIASES}:
                    descriptor = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    os.close(descriptor)
                else:
                    copy.mkdir(mode=0o700)
                continue
            copy.symlink_to(target)
        elif stat.S_ISDIR(info.st_mode):
            _clone_tree(path, copy, root, home, guard, metadata)
        elif stat.S_ISREG(info.st_mode):
            _clone_file(path, copy, metadata=metadata, root=root)
            copied_descriptor = os.open(copy, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                copied = os.fstat(copied_descriptor)
                if (not stat.S_ISREG(copied.st_mode) or copied.st_uid != os.getuid() or copied.st_nlink != 1
                        or (copied.st_dev, copied.st_ino) == (info.st_dev, info.st_ino)):
                    raise RuntimeError("wechat_private_storage_unsafe_path")
                os.fchmod(copied_descriptor, 0o600)
            finally:
                os.close(copied_descriptor)
        else:
            raise RuntimeError("wechat_private_storage_unsafe_path")
    after = _lstat(source, metadata, root)
    if (after.st_dev, after.st_ino, after.st_mtime_ns, after.st_ctime_ns) != (
            original.st_dev, original.st_ino, original.st_mtime_ns, original.st_ctime_ns):
        raise RuntimeError("wechat_private_storage_source_changed")
    guard()


def create_private_storage(state, original_container=None, optional_group=None, consent_id=None):
    state = _absolute(state)
    home = _absolute(_real_home())
    _directory(state, private=True)
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise RuntimeError("root_execution_refused")
    _consent(state, consent_id, initial=True)
    guard = lambda: _consent(state, consent_id)
    metadata = _SourceMetadata(guard, home)
    container = home / _CONTAINER
    group = home / _GROUP
    if original_container is not None and _absolute(original_container) != container:
        raise RuntimeError("wechat_private_storage_source_refused")
    if optional_group is not None and _absolute(optional_group) != group:
        raise RuntimeError("wechat_private_storage_source_refused")
    _directory(container, metadata=metadata, root=container)
    try:
        _lstat(group, metadata, group)
    except FileNotFoundError:
        has_group = False
    else:
        has_group = True
    if has_group:
        _directory(group, metadata=metadata, root=group)
    try:
        state.relative_to(container)
        raise RuntimeError("wechat_private_storage_unsafe_path")
    except ValueError:
        pass
    try:
        state.relative_to(group)
        raise RuntimeError("wechat_private_storage_unsafe_path")
    except ValueError:
        pass
    session = state / ("storage-session-" + secrets.token_hex(16))
    session.mkdir(mode=0o700)
    original_session = session.lstat()
    try:
        _write_private_json(session / _MARKER, {"version": 1, "session": session.name, "state": str(state)})
        private_home = session / "home"
        for directory in (private_home, private_home / "Library", private_home / "Library/Containers",
                          private_home / "Library/Group Containers"):
            directory.mkdir(mode=0o700)
        private_container = private_home / _CONTAINER
        private_group = private_home / _GROUP
        _clone_tree(container, private_container, container, home, guard, metadata)
        mappings = {str(container): str(private_container), str(group): str(private_group)}
        if has_group:
            _clone_tree(group, private_group, group, home, guard, metadata)
        else:
            private_group.mkdir(mode=0o700)
        guard()
        return {"sessionPath": str(session), "privateHome": str(private_home),
                "containerPath": str(private_container), "groupPath": str(private_group),
                "mappings": mappings}
    except BaseException:
        # Only this freshly created inode may be removed on a partial failure.
        try:
            _directory(state, private=True)
            info = session.lstat()
            if stat.S_ISDIR(info.st_mode) and (info.st_dev, info.st_ino) == (original_session.st_dev, original_session.st_ino):
                shutil.rmtree(session)
        except OSError:
            pass
        raise


def cleanup(path, state):
    state = _absolute(state)
    candidate = _absolute(path)
    _directory(state, private=True)
    if candidate.parent != state or not _SESSION.fullmatch(candidate.name):
        raise RuntimeError("wechat_private_storage_unsafe_path")
    if not candidate.exists() and not candidate.is_symlink():
        return False
    _directory(candidate, private=True)
    try:
        marker = _read_private_json(candidate / _MARKER)
    except (OSError, ValueError):
        raise RuntimeError("wechat_private_storage_unsafe_path") from None
    if marker != {"version": 1, "session": candidate.name, "state": str(state)}:
        raise RuntimeError("wechat_private_storage_unsafe_path")
    shutil.rmtree(candidate)
    return True
