"""Private storage launch isolation; uses fake LLDB and never starts WeChat."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat"


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, SOURCE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capture = load_module("wechat_capture_storage_environment", "capture_keys.py")
connect = load_module("wechat_connect_storage_environment", "connect.py")


class CaptureStorageEnvironmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.app = self.directory / "state/connection-helper/Memmy WeChat Reader.app"
        self.executable = self.app / "Contents/MacOS/WeChat"
        self.executable.parent.mkdir(parents=True)
        self.executable.write_bytes(b"fake-executable")
        self.bridge = self.app / "Contents/Frameworks/MemmyWeChatPrivateStorage.dylib"
        self.bridge.parent.mkdir(parents=True)
        self.bridge.write_bytes(b"fake-interposer")
        self.mapping_environment = {
            "MEMMY_WECHAT_CONTAINER_SOURCE": str(self.directory / "original/Library/Containers/com.tencent.xinWeChat"),
            "MEMMY_WECHAT_CONTAINER_COPY": str(self.directory / "private/Library/Containers/com.tencent.xinWeChat"),
            "MEMMY_WECHAT_GROUP_SOURCE": str(self.directory / "original/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"),
            "MEMMY_WECHAT_GROUP_COPY": str(self.directory / "private/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"),
        }

    def expected_entries(self):
        return ["DYLD_INSERT_LIBRARIES=" + str(self.bridge)] + [
            key + "=" + value for key, value in self.mapping_environment.items()
        ]

    def test_owned_regular_bridge_in_managed_app_adds_only_target_injection_and_four_mappings(self):
        environment = {"PATH": "/usr/bin", "LANG": "en_US.UTF-8", **self.mapping_environment}
        with mock.patch.dict(os.environ, environment, clear=True):
            before = dict(os.environ)
            entries = capture.private_storage_launch_environment(self.executable)
            self.assertEqual(entries, self.expected_entries())
            self.assertEqual(dict(os.environ), before)
            self.assertNotIn("DYLD_INSERT_LIBRARIES", os.environ)

    def test_rejects_executables_outside_the_managed_app_layout(self):
        candidates = [
            self.directory / "state/connection-helper/WeChat.app/Contents/MacOS/WeChat",
            self.directory / "state/other/Memmy WeChat Reader.app/Contents/MacOS/WeChat",
            self.app / "Contents/MacOS/Other",
            self.app / "Contents/Resources/WeChat",
        ]
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True):
            for executable in candidates:
                with self.subTest(executable=str(executable)):
                    with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                        capture.private_storage_launch_environment(executable)

    def test_rejects_symbolic_link_bridge(self):
        library = self.directory / "outside.dylib"
        library.write_bytes(b"outside")
        self.bridge.unlink()
        self.bridge.symlink_to(library)
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                capture.private_storage_launch_environment(self.executable)

    def test_rejects_bridge_behind_symbolic_link_directory(self):
        frameworks = self.bridge.parent
        actual = self.app / "Contents/ActualFrameworks"
        frameworks.rename(actual)
        frameworks.symlink_to(actual, target_is_directory=True)
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                capture.private_storage_launch_environment(self.executable)

    def test_rejects_non_regular_bridge(self):
        self.bridge.unlink()
        self.bridge.mkdir()
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                capture.private_storage_launch_environment(self.executable)

    def test_rejects_bridge_owned_by_another_user(self):
        owner = self.bridge.stat().st_uid
        with mock.patch.dict(os.environ, self.mapping_environment, clear=True), \
                mock.patch.object(capture.os, "getuid", return_value=owner + 1):
            with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                capture.private_storage_launch_environment(self.executable)

    def test_requires_every_non_empty_container_and_group_mapping(self):
        for key in self.mapping_environment:
            for absent in (None, ""):
                environment = dict(self.mapping_environment)
                if absent is None:
                    del environment[key]
                else:
                    environment[key] = absent
                with self.subTest(key=key, value=absent), \
                        mock.patch.dict(os.environ, environment, clear=True):
                    with self.assertRaisesRegex(RuntimeError, "wechat_private_storage_unsafe"):
                        capture.private_storage_launch_environment(self.executable)

    def test_main_injects_launch_info_without_mutating_python_environment(self):
        root = self.directory / "databases"
        root.mkdir()
        listener = mock.Mock()
        listener.WaitForEvent.return_value = True
        debugger = mock.Mock()
        debugger.GetListener.return_value = listener
        launch = mock.Mock()
        process = mock.Mock()
        process.IsValid.return_value = True
        process.GetState.return_value = 5
        target = mock.Mock()
        target.BreakpointCreateByName.return_value.IsValid.return_value = True
        target.Launch.return_value = process
        error = mock.Mock()
        error.Fail.return_value = False
        lldb = types.SimpleNamespace(
            SBDebugger=types.SimpleNamespace(Create=mock.Mock(return_value=debugger), Destroy=mock.Mock()),
            SBLaunchInfo=mock.Mock(return_value=launch),
            SBError=mock.Mock(return_value=error),
            SBEvent=mock.Mock(),
            SBProcess=types.SimpleNamespace(
                EventIsProcessEvent=mock.Mock(return_value=True),
                GetStateFromEvent=mock.Mock(return_value=5),
            ),
            eStateExited=5, eStateCrashed=6, eStateDetached=7, eStateInvalid=0, eStateStopped=2,
        )
        arguments = [
            "capture_keys.py", "--executable", str(self.executable), "--root", str(root),
            "--output", str(self.directory / "keys.json"),
            "--consent-file", str(self.directory / "consent.json"), "--consent-id", "explicit-consent",
        ]
        environment = {"PATH": "/usr/bin", "PYTHONPATH": "/fake/lldb", **self.mapping_environment}
        observed_parent = []

        def launched(launch_info, launch_error):
            self.assertIs(launch_info, launch)
            observed_parent.append(dict(os.environ))
            return process

        target.Launch.side_effect = launched
        with mock.patch.dict(os.environ, environment, clear=True), \
                mock.patch.dict(sys.modules, {"lldb": lldb}), \
                mock.patch.object(sys, "argv", arguments), \
                mock.patch.object(capture, "consent_enabled", return_value=True), \
                mock.patch.object(capture, "encrypted_pages", return_value={"message.db": b"x" * 4096}), \
                mock.patch.object(capture, "create_debug_target", return_value=target), \
                mock.patch.object(capture, "emit"):
            before = dict(os.environ)
            self.assertEqual(capture.main(), 3)
            launch.SetEnvironmentEntries.assert_called_once_with(self.expected_entries(), True)
            target.Launch.assert_called_once_with(launch, error)
            self.assertEqual(observed_parent, [before])
            self.assertEqual(dict(os.environ), before)
            self.assertNotIn("DYLD_INSERT_LIBRARIES", os.environ)
        lldb.SBDebugger.Destroy.assert_called_once_with(debugger)
        process.Kill.assert_not_called()


class ConnectStorageEnvironmentTests(unittest.TestCase):
    def test_cleans_ambient_injection_and_regenerates_exact_four_mapping_variables(self):
        container = "/Users/test/Library/Containers/com.tencent.xinWeChat"
        group = "/Users/test/Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat"
        mappings = {container: "/private/session/container", group: "/private/session/group"}
        normal = {"PATH": "/usr/bin", "HOME": "/Users/test", "LANG": "zh_CN.UTF-8", "MEMMY_OTHER": "keep"}
        ambient = {
            **normal,
            "PYTHONPATH": "/ambient/python", "PYTHONDONTWRITEBYTECODE": "0",
            "DYLD_INSERT_LIBRARIES": "/ambient/inject.dylib", "DYLD_LIBRARY_PATH": "/ambient/libs",
            "DYLD_FRAMEWORK_PATH": "/ambient/frameworks", "DYLD_UNKNOWN": "remove",
            "MEMMY_WECHAT_CONTAINER_SOURCE": "/ambient/source",
            "MEMMY_WECHAT_GROUP_COPY": "/ambient/copy", "MEMMY_WECHAT_OTHER": "remove",
        }
        with mock.patch.dict(os.environ, ambient, clear=True):
            before = dict(os.environ)
            environment = connect.storage_environment({"mappings": mappings}, "/selected/lldb")
            self.assertEqual(dict(os.environ), before)
        self.assertEqual(environment, {
            **normal, "PYTHONPATH": "/selected/lldb", "PYTHONDONTWRITEBYTECODE": "1",
            "MEMMY_WECHAT_CONTAINER_SOURCE": container,
            "MEMMY_WECHAT_CONTAINER_COPY": mappings[container],
            "MEMMY_WECHAT_GROUP_SOURCE": group,
            "MEMMY_WECHAT_GROUP_COPY": mappings[group],
        })
        self.assertFalse(any(key.startswith("DYLD_") for key in environment))
        self.assertEqual(sum(key.startswith("MEMMY_WECHAT_") for key in environment), 4)


if __name__ == "__main__":
    unittest.main()
