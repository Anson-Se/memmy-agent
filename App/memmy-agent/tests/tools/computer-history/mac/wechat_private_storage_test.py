import errno
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat/private_storage.py"


class CloseOnInterruptedScandir:
    """Model CPython closing its iterator when readdir fails after one entry."""

    def __init__(self, entries, before_interrupt=None):
        self.entries = entries
        self.before_interrupt = before_interrupt
        self.closed = False
        self.yielded = 0

    def __enter__(self):
        return self

    def __exit__(self, *arguments):
        self.close()

    def __iter__(self):
        return self

    def __next__(self):
        if self.closed:
            raise StopIteration
        if self.yielded == 1:
            self.close()
            if self.before_interrupt:
                self.before_interrupt()
            raise InterruptedError(errno.EINTR, "synthetic private source detail")
        entry = next(self.entries)
        self.yielded += 1
        return entry

    def close(self):
        self.closed = True
        self.entries.close()


class PrivateStorageTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("wechat_private_storage", SOURCE)
        self.helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.helper)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.container = self.home / self.helper._CONTAINER
        self.container.mkdir(parents=True, mode=0o700)
        self.data = self.container / "Data/Documents"
        self.data.mkdir(parents=True, mode=0o700)
        self.file = self.data / "fixture.db"
        self.file.write_bytes(b"only synthetic fixture bytes")
        self.file.chmod(0o600)
        self.group = self.home / self.helper._GROUP
        self.native_clone = self.helper._clone_file
        self.write_consent()
        patches = [
            mock.patch.object(self.helper, "_real_home", return_value=self.home),
            mock.patch.object(self.helper, "_clone_file", side_effect=self.copy_fixture),
        ]
        self.clone = None
        for patch in patches:
            value = patch.start()
            self.addCleanup(patch.stop)
            if patch.attribute == "_clone_file":
                self.clone = value

    def write_consent(self, enabled=True, identifier="authorized", mode=0o600):
        consent = self.state / "consent.json"
        consent.write_text(json.dumps({"version": 1, "enabled": enabled,
                                       "consentedAt": "fixture-time", "consentId": identifier}))
        consent.chmod(mode)

    def copy_fixture(self, source, destination, metadata=None, root=None):
        if source.is_relative_to(self.state):
            self.assertEqual(source.parent.parent, self.state)
            self.assertTrue(source.parent.name.startswith("clone-preflight-"))
            self.assertEqual(source.read_bytes(), b"Memmy private storage clone preflight\n")
        else:
            source.relative_to(self.home)
        shutil.copyfile(source, destination)

    def create(self, **options):
        return self.helper.create_private_storage(self.state, consent_id="authorized", **options)

    def sessions(self):
        return list(self.state.glob("storage-session-*"))

    def test_clones_fixed_container_into_private_layout_and_maps_original(self):
        original = self.file.read_bytes()
        result = self.create()
        session = Path(result["sessionPath"])
        copied = Path(result["containerPath"])
        self.assertEqual(copied, Path(result["privateHome"]) / self.helper._CONTAINER)
        self.assertEqual(result["mappings"], {str(self.container): str(copied), str(self.group): result["groupPath"]})
        private_group = Path(result["groupPath"])
        self.assertEqual(private_group, Path(result["privateHome"]) / self.helper._GROUP)
        self.assertTrue(private_group.is_dir())
        self.assertEqual(list(private_group.iterdir()), [])
        self.assertFalse(self.group.exists())
        self.assertEqual((copied / "Data/Documents/fixture.db").read_bytes(), original)
        for item in (session, *session.rglob("*")):
            if item.is_dir():
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o700, item)
            elif item.is_file():
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600, item)
        (copied / "Data/Documents/fixture.db").write_bytes(b"private modification")
        self.assertEqual(self.file.read_bytes(), original)
        self.assertTrue(self.helper.cleanup(session, self.state))
        self.assertFalse(session.exists())
        self.assertFalse(self.helper.cleanup(session, self.state))

    def test_optional_fixed_group_is_cloned_when_present(self):
        self.group.mkdir(parents=True, mode=0o700)
        (self.group / "fixture.plist").write_text("synthetic group")
        result = self.create(optional_group=self.group)
        self.assertEqual(result["mappings"][str(self.group)], result["groupPath"])
        self.assertEqual((Path(result["groupPath"]) / "fixture.plist").read_text(), "synthetic group")

    def test_standard_group_application_scripts_alias_becomes_empty_private_directory(self):
        self.group.mkdir(parents=True, mode=0o700)
        alias = self.group / self.helper._GROUP_SCRIPT_ALIAS
        alias.parent.mkdir(parents=True)
        external = self.home / self.helper._GROUP_SCRIPT_ALIAS
        alias.symlink_to(os.path.relpath(external, alias.parent))
        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        result = self.create()
        placeholder = Path(result["groupPath"]) / self.helper._GROUP_SCRIPT_ALIAS
        self.assertTrue(placeholder.is_dir())
        self.assertFalse(placeholder.is_symlink())
        self.assertEqual(list(placeholder.iterdir()), [])
        self.assertEqual(stat.S_IMODE(placeholder.stat().st_mode), 0o700)
        self.assertFalse(external.exists())

    def test_group_scripts_alias_with_another_destination_is_rejected_before_copy(self):
        self.group.mkdir(parents=True, mode=0o700)
        alias = self.group / self.helper._GROUP_SCRIPT_ALIAS
        alias.parent.mkdir(parents=True)
        alias.symlink_to(os.path.relpath(self.home / "Desktop", alias.parent))
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])

    def test_source_paths_cannot_be_changed_to_other_personal_data(self):
        for argument in ("original_container", "optional_group"):
            with self.subTest(argument=argument), self.assertRaisesRegex(RuntimeError, "source_refused"):
                self.create(**{argument: self.home})
        self.assertEqual(self.sessions(), [])
        self.clone.assert_not_called()

    def test_initial_consent_must_be_enabled_private_and_have_exact_id(self):
        for enabled, identifier, mode in ((False, "authorized", 0o600), (True, "other", 0o600),
                                          (True, "authorized", 0o644)):
            with self.subTest(enabled=enabled, identifier=identifier, mode=mode):
                self.write_consent(enabled, identifier, mode)
                with self.assertRaisesRegex(RuntimeError, "^wechat_consent_required$"):
                    self.create()
                self.assertEqual(self.sessions(), [])
        self.clone.assert_not_called()

    def test_revocation_during_clone_cleans_partial_session(self):
        def revoke(source, destination, **options):
            self.copy_fixture(source, destination)
            self.write_consent(enabled=False)
        self.clone.side_effect = revoke
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.create()
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_consent_id_change_during_clone_cleans_partial_session(self):
        def replace_consent(source, destination, **options):
            self.copy_fixture(source, destination)
            self.write_consent(identifier="new-authorization")
        self.clone.side_effect = replace_consent
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.create()
        self.assertEqual(self.sessions(), [])

    def test_clone_failure_has_no_copy_fallback_and_cleans_partial_session(self):
        self.clone.side_effect = RuntimeError("wechat_private_storage_clone_failed")
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
            self.create()
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_keyboard_interrupt_cleans_partial_session(self):
        self.clone.side_effect = KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            self.create()
        self.assertEqual(self.sessions(), [])

    def test_internal_relative_symlink_is_retained_inside_private_container(self):
        (self.data / "internal-link").symlink_to("fixture.db")
        result = self.create()
        link = Path(result["containerPath"]) / "Data/Documents/internal-link"
        self.assertEqual(os.readlink(link), "fixture.db")
        self.assertEqual(link.read_bytes(), b"only synthetic fixture bytes")

    def test_unknown_external_or_absolute_symlink_is_rejected(self):
        link = self.data / "unexpected"
        for target in (str(self.file), "../../../../../../outside", str(self.home / "Desktop")):
            with self.subTest(target=target):
                link.symlink_to(target)
                with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
                    self.create()
                link.unlink()
                self.assertEqual(self.sessions(), [])

    def test_regular_hardlinks_are_cloned_as_independent_private_files(self):
        os.link(self.file, self.data / "hardlink")
        result = self.create()
        copied = Path(result["containerPath"]) / "Data/Documents"
        for name in ("fixture.db", "hardlink"):
            item = copied / name
            self.assertNotEqual(item.stat().st_ino, self.file.stat().st_ino)
            self.assertEqual(item.stat().st_nlink, 1)
            self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600)
        (copied / "hardlink").write_bytes(b"private change")
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")
        self.assertEqual((copied / "fixture.db").read_bytes(), b"only synthetic fixture bytes")

    def test_wechat_shared_file_and_cache_modes_stay_private_in_the_copy(self):
        self.file.chmod(0o664)
        self.data.chmod(0o777)
        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        result = self.create()
        copied = Path(result["containerPath"]) / "Data/Documents"
        self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((copied / "fixture.db").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o664)
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o777)

    def test_fifo_is_rejected_without_opening_it(self):
        os.mkfifo(self.data / "pipe", 0o600)
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.create()
        self.assertEqual(self.sessions(), [])

    def test_unsafe_state_symlink_or_permissions_are_rejected(self):
        alias = self.root / "alias"
        alias.symlink_to(self.state, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.helper.create_private_storage(alias, consent_id="authorized")
        self.state.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.create()
        self.clone.assert_not_called()

    def test_source_directory_symlink_is_rejected(self):
        moved = self.container.with_name("other-container")
        self.container.rename(moved)
        self.container.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.create()
        self.clone.assert_not_called()

    def test_foreign_owned_source_is_rejected(self):
        with mock.patch.object(self.helper.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
                self.create()
        self.assertEqual(self.sessions(), [])

    def test_standard_sandbox_aliases_become_empty_private_placeholders(self):
        aliases = {Path("Data") / name: self.home / name for name in self.helper._HOME_ALIASES}
        aliases.update({Path("Data/Library") / name: self.home / "Library" / name
                        for name in self.helper._LIBRARY_ALIASES})
        file_aliases = {Path("Data/Library") / name for name in self.helper._LIBRARY_FILE_ALIASES}
        aliases.update({relative: self.home / "Library" / relative.relative_to("Data/Library")
                        for relative in file_aliases})
        for relative, target in aliases.items():
            link = self.container / relative
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(os.path.relpath(target, link.parent))
        result = self.create()
        private = Path(result["containerPath"])
        for relative in aliases:
            item = private / relative
            self.assertFalse(item.is_symlink(), relative)
            if relative.name == ".CFUserTextEncoding" or relative in file_aliases:
                self.assertEqual(item.read_bytes(), b"")
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o600)
            else:
                self.assertTrue(item.is_dir(), relative)
                self.assertEqual(list(item.iterdir()), [])
                self.assertEqual(stat.S_IMODE(item.stat().st_mode), 0o700)

    def test_standard_alias_with_wrong_destination_is_not_whitelisted(self):
        (self.container / "Data/Desktop").symlink_to("../../../../Documents")
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.create()
        self.assertEqual(self.sessions(), [])

    def test_preflight_checks_metadata_and_clones_only_inert_private_bytes(self):
        link = self.container / "Data/Library/Application Support/AddressBook"
        link.parent.mkdir(parents=True)
        link.symlink_to(os.path.relpath(self.home / "Library/Application Support/AddressBook", link.parent))
        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_called_once()
        source, destination = self.clone.call_args.args
        self.assertEqual(source.parent.parent, self.state)
        self.assertEqual(source.parent, destination.parent)
        self.assertFalse(source.parent.exists())
        self.assertEqual(self.sessions(), [])
        self.assertFalse((self.home / "Library/Application Support/AddressBook").exists())
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_preflight_skips_live_child_that_disappears_after_enumeration(self):
        disappearing = self.data / "live-cache"
        disappearing.mkdir(mode=0o700)
        original_item = self.helper._source_item

        def remove_cache(path, root, home, metadata=None):
            if path == disappearing:
                path.rmdir()
            return original_item(path, root, home, metadata)

        with mock.patch.object(self.helper, "_source_item", side_effect=remove_cache):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_called_once()
        self.assertEqual(self.sessions(), [])

    def test_preflight_missing_fixed_root_is_not_skipped(self):
        shutil.rmtree(self.container)
        with self.assertRaises(FileNotFoundError):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()

    def test_preflight_does_not_swallow_permission_errors_on_live_children(self):
        original_item = self.helper._source_item

        def deny(path, root, home, metadata=None):
            if path == self.file:
                raise PermissionError("synthetic permission denial")
            return original_item(path, root, home, metadata)

        with mock.patch.object(self.helper, "_source_item", side_effect=deny), self.assertRaises(PermissionError):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()

    def test_interrupted_source_lstat_recovers_in_preflight_and_snapshot(self):
        original_lstat = Path.lstat
        for stage in ("preflight", "snapshot"):
            with self.subTest(stage=stage):
                attempts = 0

                def interrupted_once(path, *arguments, **options):
                    nonlocal attempts
                    if path == self.file:
                        attempts += 1
                        if attempts == 1:
                            raise InterruptedError(errno.EINTR, "synthetic private source detail")
                    return original_lstat(path, *arguments, **options)

                with mock.patch.object(Path, "lstat", interrupted_once):
                    if stage == "preflight":
                        self.helper.preflight_private_storage(self.state, consent_id="authorized")
                    else:
                        result = self.create()
                self.assertEqual(attempts, 2)
                if stage == "snapshot":
                    self.assertEqual((Path(result["containerPath"]) / "Data/Documents/fixture.db").read_bytes(),
                                     b"only synthetic fixture bytes")
                    self.helper.cleanup(result["sessionPath"], self.state)
                self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_repeated_source_interruption_is_bounded_private_and_cleans_snapshot(self):
        original_lstat = Path.lstat
        for stage in ("preflight", "snapshot"):
            with self.subTest(stage=stage):
                attempts = 0
                self.clone.reset_mock()

                def interrupted(path, *arguments, **options):
                    nonlocal attempts
                    if path == self.file:
                        attempts += 1
                        raise InterruptedError(errno.EINTR, "synthetic private source detail")
                    return original_lstat(path, *arguments, **options)

                with mock.patch.object(Path, "lstat", interrupted):
                    with self.assertRaises(self.helper.WeChatMetadataAccessError) as failure:
                        if stage == "preflight":
                            self.helper.preflight_private_storage(self.state, consent_id="authorized")
                        else:
                            self.create()
                self.assertEqual(attempts, 2)
                self.assertEqual(str(failure.exception), "wechat_data_access_interrupted")
                self.assertEqual(failure.exception.diagnostic,
                                 {"operation": "lstat", "errno": errno.EINTR, "source": "container"})
                self.assertNotIn("synthetic private", json.dumps(failure.exception.diagnostic))
                self.assertEqual(self.sessions(), [])
                self.clone.assert_not_called()
                self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_interrupted_readlink_recovers_without_changing_alias_validation(self):
        link = self.data / "internal-link"
        link.symlink_to("fixture.db")
        original_readlink = os.readlink
        attempts = 0

        def interrupted_once(path, *arguments, **options):
            nonlocal attempts
            if Path(path) == link:
                attempts += 1
                if attempts == 1:
                    raise InterruptedError(errno.EINTR, "synthetic private source detail")
            return original_readlink(path, *arguments, **options)

        with mock.patch.object(self.helper.os, "readlink", interrupted_once):
            result = self.create()
        self.assertGreaterEqual(attempts, 2)
        self.assertEqual(os.readlink(Path(result["containerPath"]) / "Data/Documents/internal-link"), "fixture.db")
        self.assertEqual(os.readlink(link), "fixture.db")
        self.helper.cleanup(result["sessionPath"], self.state)

    def test_interrupted_scandir_acquisition_recovers_before_processing_entries(self):
        original_scandir = os.scandir
        attempts = 0

        def interrupted_once(path):
            nonlocal attempts
            if path == self.data:
                attempts += 1
                if attempts == 1:
                    raise InterruptedError(errno.EINTR, "synthetic private source detail")
            return original_scandir(path)

        with mock.patch.object(self.helper.os, "scandir", interrupted_once):
            result = self.create()
        self.assertEqual(attempts, 2)
        self.assertEqual([call.args[0] for call in self.clone.call_args_list], [self.file])
        self.helper.cleanup(result["sessionPath"], self.state)

    def test_closed_interrupted_iterator_is_reopened_without_lost_or_duplicate_entries(self):
        expected = {self.file, self.data / "second.db", self.data / "third.db"}
        for path in expected - {self.file}:
            path.write_bytes(b"synthetic extra source")
        original_scandir = os.scandir
        original_item = self.helper._source_item
        for stage in ("preflight", "snapshot"):
            with self.subTest(stage=stage):
                attempts = 0
                closed_iterators = []
                validated = []
                self.clone.reset_mock()

                def interrupted_once(path):
                    nonlocal attempts
                    entries = original_scandir(path)
                    if path == self.data:
                        attempts += 1
                        if attempts == 1:
                            interrupted = CloseOnInterruptedScandir(entries)
                            closed_iterators.append(interrupted)
                            return interrupted
                    return entries

                def track(path, root, home, metadata=None):
                    if path in expected:
                        validated.append(path)
                    return original_item(path, root, home, metadata)

                with mock.patch.object(self.helper.os, "scandir", interrupted_once), \
                        mock.patch.object(self.helper, "_source_item", side_effect=track):
                    if stage == "preflight":
                        self.helper.preflight_private_storage(self.state, consent_id="authorized")
                    else:
                        result = self.create()
                self.assertEqual(attempts, 2)
                self.assertTrue(closed_iterators[0].closed)
                self.assertCountEqual(validated, expected)
                if stage == "snapshot":
                    self.assertCountEqual([call.args[0] for call in self.clone.call_args_list], expected)
                    copied = Path(result["containerPath"]) / "Data/Documents"
                    self.assertEqual({item.name for item in copied.iterdir()}, {item.name for item in expected})
                    self.helper.cleanup(result["sessionPath"], self.state)
                self.assertEqual(self.sessions(), [])

    def test_repeated_iterator_interruption_fails_without_partial_copy(self):
        original_scandir = os.scandir
        attempts = 0

        def interrupted(path):
            nonlocal attempts
            entries = original_scandir(path)
            if path == self.data:
                attempts += 1
                return CloseOnInterruptedScandir(entries)
            return entries

        with mock.patch.object(self.helper.os, "scandir", interrupted):
            with self.assertRaises(self.helper.WeChatMetadataAccessError) as failure:
                self.create()
        self.assertEqual(attempts, 2)
        self.assertEqual(str(failure.exception), "wechat_data_access_interrupted")
        self.assertEqual(failure.exception.diagnostic,
                         {"operation": "scandir_next", "errno": errno.EINTR, "source": "container"})
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_iterator_reopen_checks_consent_and_replaced_source_before_access(self):
        original_scandir = os.scandir
        for change in ("revoke", "replace"):
            with self.subTest(change=change):
                self.write_consent()
                attempts = 0
                moved = self.data.with_name("Documents-original")
                outside = self.root / "outside"
                outside.mkdir(exist_ok=True)

                def interrupt_action():
                    if change == "revoke":
                        self.write_consent(enabled=False)
                    else:
                        self.data.rename(moved)
                        self.data.symlink_to(outside, target_is_directory=True)

                def interrupted(path):
                    nonlocal attempts
                    entries = original_scandir(path)
                    if path == self.data:
                        attempts += 1
                        return CloseOnInterruptedScandir(entries, interrupt_action)
                    return entries

                category = "wechat_consent_revoked" if change == "revoke" else "wechat_private_storage_unsafe_path"
                with mock.patch.object(self.helper.os, "scandir", interrupted):
                    with self.assertRaisesRegex(RuntimeError, "^" + category + "$"):
                        self.create()
                self.assertEqual(attempts, 1)
                self.clone.assert_not_called()
                self.assertEqual(self.sessions(), [])
                if change == "replace":
                    self.data.unlink()
                    moved.rename(self.data)
                self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_consent_revocation_stops_before_retrying_interrupted_metadata(self):
        original_lstat = Path.lstat
        attempts = 0

        def revoke_then_interrupt(path, *arguments, **options):
            nonlocal attempts
            if path == self.file:
                attempts += 1
                self.write_consent(enabled=False)
                raise InterruptedError(errno.EINTR, "synthetic private source detail")
            return original_lstat(path, *arguments, **options)

        with mock.patch.object(Path, "lstat", revoke_then_interrupt):
            with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
                self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.assertEqual(attempts, 1)
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])

    def test_source_directory_batch_revalidates_all_ancestors_and_consent_on_retry(self):
        original_lstat = Path.lstat
        for revoke in (False, True):
            with self.subTest(revoke=revoke):
                self.write_consent()
                attempted_leaf = 0
                checked_root = 0

                def interrupt_after_root_checks(path, *arguments, **options):
                    nonlocal attempted_leaf, checked_root
                    if path == self.container:
                        checked_root += 1
                    if path == self.data:
                        attempted_leaf += 1
                        if attempted_leaf == 1:
                            if revoke:
                                self.write_consent(enabled=False)
                            raise InterruptedError(errno.EINTR, "synthetic private source detail")
                    return original_lstat(path, *arguments, **options)

                metadata = self.helper._SourceMetadata(
                    lambda: self.helper._consent(self.state, "authorized"), self.home)
                with mock.patch.object(Path, "lstat", interrupt_after_root_checks):
                    if revoke:
                        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
                            self.helper._source_directory(self.data, self.container, metadata)
                    else:
                        result = self.helper._source_directory(self.data, self.container, metadata)
                        self.assertTrue(stat.S_ISDIR(result.st_mode))
                # The first attempt completed both root checks before the leaf
                # failed. A permitted retry repeats both; revoked consent stops
                # before any second root/leaf validation.
                self.assertEqual(checked_root, 2 if revoke else 4)
                self.assertEqual(attempted_leaf, 1 if revoke else 3)
                self.clone.assert_not_called()
                self.assertEqual(self.sessions(), [])

    def test_metadata_deadline_stops_after_slow_call_without_retry_or_copy(self):
        original_lstat = Path.lstat
        now = [0]
        attempts = 0

        def slow_metadata(path, *arguments, **options):
            nonlocal attempts
            if path == self.file:
                attempts += 1
                now[0] += self.helper._METADATA_SECONDS
            return original_lstat(path, *arguments, **options)

        with mock.patch.object(self.helper.time, "monotonic", side_effect=lambda: now[0]), \
                mock.patch.object(Path, "lstat", slow_metadata):
            with self.assertRaises(self.helper.WeChatMetadataAccessError) as failure:
                self.create()
        self.assertEqual(attempts, 1)
        self.assertEqual(str(failure.exception), "wechat_data_access_timeout")
        self.assertEqual(failure.exception.diagnostic,
                         {"operation": "lstat", "errno": errno.ETIMEDOUT, "source": "container"})
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_long_clone_duration_does_not_consume_source_metadata_budget(self):
        now = [0]

        def slow_clone(source, destination, **options):
            now[0] += self.helper._METADATA_SECONDS * 10
            self.copy_fixture(source, destination)

        self.clone.side_effect = slow_clone
        with mock.patch.object(self.helper.time, "monotonic", side_effect=lambda: now[0]):
            result = self.create()
        self.assertEqual(self.clone.call_count, 1)
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")
        self.helper.cleanup(result["sessionPath"], self.state)

    def test_metadata_time_is_bounded_across_container_and_group_traversals(self):
        self.group.mkdir(parents=True, mode=0o700)
        group_file = self.group / "fixture.plist"
        group_file.write_text("synthetic group")
        original_lstat = Path.lstat
        now = [0]

        def slow_metadata(path, *arguments, **options):
            if path in (self.file, group_file):
                now[0] += self.helper._METADATA_SECONDS * 0.6
            return original_lstat(path, *arguments, **options)

        with mock.patch.object(self.helper.time, "monotonic", side_effect=lambda: now[0]), \
                mock.patch.object(Path, "lstat", slow_metadata):
            with self.assertRaises(self.helper.WeChatMetadataAccessError) as failure:
                self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.assertEqual(str(failure.exception), "wechat_data_access_timeout")
        self.assertEqual(failure.exception.diagnostic,
                         {"operation": "lstat", "errno": errno.ETIMEDOUT, "source": "group_container"})
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])

    def test_metadata_timeout_closes_newly_acquired_directory_iterator(self):
        original_scandir = os.scandir
        now = [0]
        acquired = []

        def slow_scandir(path):
            entries = original_scandir(path)
            if path == self.data:
                acquired.append(entries)
                now[0] += self.helper._METADATA_SECONDS
            return entries

        with mock.patch.object(self.helper.time, "monotonic", side_effect=lambda: now[0]), \
                mock.patch.object(self.helper.os, "scandir", slow_scandir):
            with self.assertRaises(self.helper.WeChatMetadataAccessError) as failure:
                self.create()
        self.assertEqual(failure.exception.diagnostic["operation"], "scandir")
        self.assertEqual(len(acquired), 1)
        with self.assertRaises(StopIteration):
            next(acquired[0])
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])

    def test_other_source_os_errors_and_clone_interruption_are_not_retried(self):
        original_lstat = Path.lstat
        attempts = 0

        def denied(path, *arguments, **options):
            nonlocal attempts
            if path == self.file:
                attempts += 1
                raise PermissionError(errno.EACCES, "synthetic private source detail")
            return original_lstat(path, *arguments, **options)

        with mock.patch.object(Path, "lstat", denied), self.assertRaises(PermissionError):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.assertEqual(attempts, 1)
        self.clone.assert_not_called()
        self.clone.side_effect = InterruptedError(errno.EINTR, "synthetic clone interruption")
        with self.assertRaises(InterruptedError):
            self.create()
        self.assertEqual(self.clone.call_count, 1)
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_group_source_interruption_reports_only_fixed_group_category(self):
        self.group.mkdir(parents=True, mode=0o700)
        group_file = self.group / "fixture.plist"
        group_file.write_text("synthetic group")
        original_lstat = Path.lstat

        def interrupted(path, *arguments, **options):
            if path == group_file:
                raise InterruptedError(errno.EINTR, "synthetic private source detail")
            return original_lstat(path, *arguments, **options)

        with mock.patch.object(Path, "lstat", interrupted):
            with self.assertRaises(self.helper.WeChatMetadataAccessError) as failure:
                self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.assertEqual(failure.exception.diagnostic,
                         {"operation": "lstat", "errno": errno.EINTR, "source": "group_container"})
        self.clone.assert_not_called()

    def test_preflight_requires_each_fixed_source_on_the_state_volume(self):
        self.group.mkdir(parents=True, mode=0o700)
        original_directory = self.helper._directory
        for other_volume in (self.container, self.group):
            with self.subTest(source=other_volume):
                def directory(path, private=False, **options):
                    info = original_directory(path, private=private, **options)
                    return mock.Mock(st_dev=info.st_dev + 1) if path == other_volume else info

                with mock.patch.object(self.helper, "_directory", side_effect=directory):
                    with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
                        self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()
        self.assertEqual(list(self.state.glob("clone-preflight-*")), [])

    def test_failed_inert_preflight_clone_cleans_private_fixture(self):
        self.clone.side_effect = RuntimeError("wechat_private_storage_clone_failed")
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_clone_failed$"):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.assertEqual(list(self.state.glob("clone-preflight-*")), [])
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_revocation_during_inert_preflight_clone_cleans_private_fixture(self):
        def revoke(source, destination):
            self.copy_fixture(source, destination)
            self.write_consent(enabled=False)

        self.clone.side_effect = revoke
        with self.assertRaisesRegex(RuntimeError, "^wechat_consent_revoked$"):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.assertEqual(list(self.state.glob("clone-preflight-*")), [])
        self.assertEqual(self.sessions(), [])

    def test_final_snapshot_source_change_is_rejected_and_partial_session_removed(self):
        def change(source, destination, **options):
            self.copy_fixture(source, destination)
            # This synthetic new entry exercises the strict directory check.
            (source.parent / "later-cache-entry").write_bytes(b"synthetic cache write")

        self.clone.side_effect = change
        with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_source_changed$"):
            self.create()
        self.assertEqual(self.sessions(), [])
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    def test_preflight_rejects_unknown_external_symlink_without_creating_a_session(self):
        (self.data / "external").symlink_to(self.home / "Desktop")
        with self.assertRaisesRegex(RuntimeError, "unsafe_path"):
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        self.clone.assert_not_called()
        self.assertEqual(self.sessions(), [])

    def test_cleanup_rejects_other_paths_symlinks_and_unmarked_sessions(self):
        unmarked = self.state / ("storage-session-" + "a" * 32)
        unmarked.mkdir(mode=0o700)
        alias = self.state / ("storage-session-" + "b" * 32)
        alias.symlink_to(self.container, target_is_directory=True)
        for candidate in (self.state, self.container, self.root, unmarked, alias):
            with self.subTest(candidate=candidate), self.assertRaisesRegex(RuntimeError, "unsafe_path"):
                self.helper.cleanup(candidate, self.state)
        self.assertTrue(self.file.exists())

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clone_retries_only_source_metadata_before_single_clone(self):
        destination = self.state / "clone-fixture.db"
        original_lstat = Path.lstat
        attempts = 0

        def interrupted_once(path, *arguments, **options):
            nonlocal attempts
            if path == self.file:
                attempts += 1
                if attempts == 1:
                    raise InterruptedError(errno.EINTR, "synthetic private source detail")
            return original_lstat(path, *arguments, **options)

        metadata = self.helper._SourceMetadata(lambda: self.helper._consent(self.state, "authorized"), self.home)
        with mock.patch.object(Path, "lstat", interrupted_once), \
                mock.patch.object(self.helper.ctypes, "CDLL", wraps=self.helper.ctypes.CDLL) as library:
            self.native_clone(self.file, destination, metadata=metadata, root=self.container)
        self.assertEqual(attempts, 2)
        self.assertEqual(library.call_count, 1)
        self.assertEqual(destination.read_bytes(), b"only synthetic fixture bytes")
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_preflight_clone_uses_only_its_own_synthetic_fixture(self):
        with mock.patch.object(self.helper, "_clone_file", side_effect=self.native_clone) as clone:
            self.helper.preflight_private_storage(self.state, consent_id="authorized")
        source, destination = clone.call_args.args
        self.assertEqual(source.parent.parent, self.state)
        self.assertEqual(source.parent, destination.parent)
        self.assertFalse(source.parent.exists())
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clone_rejects_source_metadata_change(self):
        destination = self.state / "clone-fixture.db"
        original_fstat = self.helper.os.fstat
        observations = 0

        def changed_metadata(descriptor):
            nonlocal observations
            info = original_fstat(descriptor)
            observations += 1
            if observations == 2:
                return mock.Mock(st_size=info.st_size, st_mtime_ns=info.st_mtime_ns + 1,
                                 st_ctime_ns=info.st_ctime_ns)
            return info

        with mock.patch.object(self.helper.os, "fstat", side_effect=changed_metadata):
            with self.assertRaisesRegex(RuntimeError, "^wechat_private_storage_source_changed$"):
                self.native_clone(self.file, destination)
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clonefile_uses_copy_on_write_only_on_small_synthetic_fixture(self):
        destination = self.state / "clone-fixture.db"
        self.native_clone(self.file, destination)
        self.assertEqual(destination.read_bytes(), self.file.read_bytes())
        self.assertNotEqual(destination.stat().st_ino, self.file.stat().st_ino)
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        destination.write_bytes(b"private fixture change")
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")

    @unittest.skipUnless(sys.platform == "darwin", "public APFS clone API is Darwin-only")
    def test_native_clone_accepts_owned_source_hardlinks_and_shared_modes_without_sharing_inode(self):
        self.file.chmod(0o664)
        os.link(self.file, self.data / "fixture-linked.db")
        destination = self.state / "cloned-hardlink.db"
        self.native_clone(self.file, destination)
        self.assertNotEqual(destination.stat().st_ino, self.file.stat().st_ino)
        self.assertEqual(destination.stat().st_nlink, 1)
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
        destination.write_bytes(b"private copy write")
        self.assertEqual(self.file.read_bytes(), b"only synthetic fixture bytes")


if __name__ == "__main__":
    unittest.main()
