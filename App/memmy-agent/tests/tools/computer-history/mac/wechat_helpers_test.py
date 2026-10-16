import contextlib
import importlib.util
import io
import json
from pathlib import Path
import signal
import subprocess
import sys
import types
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[4] / "src/tools/computer-history/mac/wechat"


def load_helper(name):
    spec = importlib.util.spec_from_file_location(name, SOURCE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


capture = load_helper("capture_keys")
connect = load_helper("connect")


class CommandResult:
    success = True

    def Succeeded(self):
        return self.success


class DebuggerError:
    def Fail(self):
        return False


class TargetCreationTests(unittest.TestCase):
    def setUp(self):
        self.settings = []
        self.lldb = types.SimpleNamespace(SBCommandReturnObject=CommandResult, SBError=DebuggerError)
        self.target = mock.Mock()
        self.target.IsValid.return_value = True
        self.target.GetTriple.return_value = "arm64-apple-macosx15.0.0"
        self.debugger = mock.Mock()
        self.debugger.GetCommandInterpreter.return_value.HandleCommand.side_effect = (
            lambda command, result: self.settings.append(command)
        )

        def create_target(filename, triple, platform, dependencies, error):
            # Simulate the affected LLDB refusing dependency/symbol preloading.
            if dependencies or "settings set target.preload-symbols false" not in self.settings:
                raise AssertionError("unsafe symbol preloading")
            return self.target

        self.debugger.CreateTarget.side_effect = create_target

    def test_creates_executable_only_after_disabling_symbol_preloading(self):
        target = capture.create_debug_target(self.lldb, self.debugger, Path("/example/WeChat"))
        self.assertIs(target, self.target)
        self.assertFalse(self.debugger.CreateTarget.call_args.args[3])
        self.debugger.Launch.assert_not_called()

    def test_configuration_failure_stops_before_creating_target(self):
        def reject_setting(command, result):
            result.success = False

        self.debugger.GetCommandInterpreter.return_value.HandleCommand.side_effect = reject_setting
        with self.assertRaisesRegex(RuntimeError, "^debugger_configuration_failed$"):
            capture.create_debug_target(self.lldb, self.debugger, Path("/example/WeChat"))
        self.debugger.CreateTarget.assert_not_called()

    def test_failed_target_creation_is_reported(self):
        self.target.IsValid.return_value = False
        with self.assertRaisesRegex(RuntimeError, "^debug_target_creation_failed$"):
            capture.create_debug_target(self.lldb, self.debugger, Path("/example/WeChat"))

    def test_missing_lldb_bindings_are_reported_without_starting_capture(self):
        with mock.patch.dict(sys.modules, {"lldb": None}):
            with self.assertRaisesRegex(RuntimeError, "^lldb_unavailable$"):
                capture.main()


class CaptureResultTests(unittest.TestCase):
    def test_native_crash_takes_priority_over_missing_output_or_old_error(self):
        self.assertEqual(
            connect.capture_failure_category(-signal.SIGBUS, False, "wechat_login_required"),
            "key_capture_crashed",
        )

    def test_helper_error_survives_the_connection_wrapper(self):
        lines = [
            json.dumps({"event": "waiting_for_login"}),
            "not a status",
            json.dumps({"event": "capture_error", "category": "lldb_unavailable"}),
        ]
        child = subprocess.Popen(
            [sys.executable, "-c", "import sys; print(sys.argv[1]); sys.exit(2)", "\n".join(lines)],
            stdout=subprocess.PIPE, text=True,
        )
        try:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code, category = connect.wait_for_capture(child)
            self.assertEqual(code, 2)
            self.assertEqual(output.getvalue().splitlines(), lines)
            self.assertEqual(connect.capture_failure_category(code, False, category), "lldb_unavailable")
        finally:
            child.stdout.close()
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_no_verified_keys_is_distinct_from_helper_failure(self):
        self.assertEqual(connect.capture_failure_category(3, False), "key_capture_no_keys")
        self.assertEqual(connect.capture_failure_category(2, False), "key_capture_failed")
        self.assertEqual(connect.capture_failure_category(0, False), "key_capture_output_missing")
        self.assertIsNone(connect.capture_failure_category(0, True))

    def test_missing_developer_tools_are_reported_before_connecting(self):
        for result in (
                subprocess.CompletedProcess([], 1, "", "developer tools missing"),
                subprocess.CompletedProcess([], 0, "", "")):
            with self.subTest(result=result), mock.patch.object(connect.subprocess, "run", return_value=result):
                with self.assertRaisesRegex(RuntimeError, "^lldb_unavailable$"):
                    connect.lldb_python_path()
        with mock.patch.object(connect.subprocess, "run", side_effect=FileNotFoundError):
            with self.assertRaisesRegex(RuntimeError, "^lldb_unavailable$"):
                connect.lldb_python_path()


class ToolSelectionTests(unittest.TestCase):
    def setUp(self):
        self.versions = {"/selected/lldb": "lldb-1703.0.236.103", "/Applications/Xcode.app/lldb": "lldb-2103.0.34.103"}
        self.calls = []
        self.import_failures = set()
        self.patches = [
            mock.patch.object(connect, "lldb_candidates", side_effect=lambda: [Path(path) for path in self.versions]),
            mock.patch.object(connect.platform, "mac_ver", return_value=("27.0.1", ("", "", ""), "arm64")),
            mock.patch.object(connect.subprocess, "run", side_effect=self.run_tool),
            mock.patch.object(Path, "is_dir", return_value=True),
        ]
        for patch in self.patches:
            patch.start()
            self.addCleanup(patch.stop)

    def run_tool(self, arguments, **options):
        self.calls.append(arguments)
        if arguments[-1] == "--version":
            return subprocess.CompletedProcess(arguments, 0, self.versions[arguments[0]], "")
        if arguments[-1] == "-P":
            return subprocess.CompletedProcess(arguments, 0, arguments[0] + "-bindings", "")
        self.assertEqual(arguments, [sys.executable, "-c", "import lldb"])
        location = options["env"]["PYTHONPATH"]
        return subprocess.CompletedProcess(arguments, int(location in self.import_failures), "", "")

    def test_parses_apple_lldb_build_from_multiline_version(self):
        self.assertEqual(connect.lldb_version("lldb-2103.0.34.103\nApple Swift version 6.4"), (2103, 0, 34, 103))
        self.assertIsNone(connect.lldb_version("developer tools not available"))

    def test_newest_installed_lldb_is_preferred_without_changing_selected_tools(self):
        self.assertEqual(connect.lldb_python_path(), "/Applications/Xcode.app/lldb-bindings")
        self.assertNotIn(["/selected/lldb", "-P"], self.calls)
        self.assertIn([sys.executable, "-c", "import lldb"], self.calls)

    def test_known_incompatible_tools_are_stopped_before_import_on_macos_27(self):
        self.versions = {"/selected/lldb": "lldb-1703.0.236.103"}
        with self.assertRaisesRegex(RuntimeError, "^lldb_incompatible$"):
            connect.lldb_python_path()
        self.assertEqual(self.calls, [["/selected/lldb", "--version"]])

    def test_current_selected_tools_still_work_on_older_macos(self):
        self.versions = {"/selected/lldb": "lldb-1703.0.236.103"}
        with mock.patch.object(connect.platform, "mac_ver", return_value=("26.0", ("", "", ""), "arm64")):
            self.assertEqual(connect.lldb_python_path(), "/selected/lldb-bindings")

    def test_python_binding_failure_tries_next_compatible_candidate(self):
        self.versions["/Applications/Xcode-beta.app/lldb"] = "lldb-2104.0.1"
        self.import_failures.add("/Applications/Xcode-beta.app/lldb-bindings")
        self.assertEqual(connect.lldb_python_path(), "/Applications/Xcode.app/lldb-bindings")

    def test_no_usable_python_bindings_reports_unavailable(self):
        self.import_failures.add("/Applications/Xcode.app/lldb-bindings")
        with self.assertRaisesRegex(RuntimeError, "^lldb_unavailable$"):
            connect.lldb_python_path()
        self.assertNotIn(["/selected/lldb", "-P"], self.calls)

    def test_no_installed_tools_reports_unavailable(self):
        self.versions = {}
        with self.assertRaisesRegex(RuntimeError, "^lldb_unavailable$"):
            connect.lldb_python_path()


class ToolDiscoveryTests(unittest.TestCase):
    def test_no_tools_never_invokes_installation_shim(self):
        selected = subprocess.CompletedProcess([], 1, "", "no active developer directory")
        with mock.patch.object(connect.subprocess, "run", return_value=selected) as run:
            with mock.patch.object(Path, "is_file", return_value=False), mock.patch.object(Path, "glob", return_value=[]):
                self.assertEqual(connect.lldb_candidates(), [])
        run.assert_called_once_with(["/usr/bin/xcode-select", "-p"], capture_output=True, text=True, timeout=5)

    def test_discovers_selected_xcode_and_command_line_tools_without_duplicates(self):
        developer = Path("/Applications/Xcode.app/Contents/Developer")
        selected = subprocess.CompletedProcess([], 0, str(developer), "")
        xcode = developer / "usr/bin/lldb"
        with mock.patch.object(connect.subprocess, "run", return_value=selected):
            with mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(Path, "glob", return_value=[xcode]):
                with mock.patch.object(connect.os, "access", return_value=True):
                    self.assertEqual(connect.lldb_candidates(), [xcode, Path("/Library/Developer/CommandLineTools/usr/bin/lldb")])


if __name__ == "__main__":
    unittest.main()
