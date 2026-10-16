import ctypes
import hashlib
import hmac
import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[4] / "src/tools/computer-history/win/weixin_keys.py"
spec = importlib.util.spec_from_file_location("weixin_keys", MODULE_PATH)
keys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keys)


def page_for(raw_key, salt=None):
    salt = salt or bytes(range(16))
    body = bytes((index * 3) % 256 for index in range(4016))
    mac_salt = bytes(byte ^ 0x3A for byte in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", raw_key, mac_salt, 2, 32)
    digest = hmac.new(mac_key, body + b"\x01\x00\x00\x00", hashlib.sha512).digest()
    return salt + body + digest


class MapMemory(keys.ProcessMemory):
    def __init__(self, base, data):
        self.base = base
        self.data = data

    def regions(self):
        return [(self.base, len(self.data))]

    def read(self, address, size):
        start = address - self.base
        if start < 0 or start + size > len(self.data):
            return b""
        return self.data[start:start + size]


def cipher_image(raw_key, salt):
    literal = b"x'" + (raw_key.hex() + salt.hex()).encode() + b"'"
    blob = keys.xor_repeat(literal, keys.CIPHER_MASK)
    assert len(blob) == 99
    base = 0x200000
    size = 0x1000
    data = bytearray(size)
    needle = 0x100
    data[needle:needle + len(keys.CIPHER_NAME)] = keys.CIPHER_NAME
    pair = 0x220
    node = pair - 0x10
    struct.pack_into("<Q", data, node + 0x10, base + needle)
    struct.pack_into("<Q", data, node + 0x18, len(keys.CIPHER_NAME))
    config_ptr = base + 0x400
    struct.pack_into("<Q", data, node + 0x28, config_ptr)
    data_ptr = base + 0x800
    struct.pack_into("<Q", data, 0x400 + 0x88 + 0x8, data_ptr)
    struct.pack_into("<Q", data, 0x400 + 0x88 + 0x10, 99)
    data[0x800:0x800 + 99] = blob
    return MapMemory(base, bytes(data))


class WeixinKeyCheck(unittest.TestCase):
    def test_page_check_accepts_only_the_real_key(self):
        raw_key = bytes(range(32))
        page = page_for(raw_key)
        self.assertTrue(keys.authenticated_page(raw_key, page))
        self.assertFalse(keys.authenticated_page(bytes(range(1, 33)), page))

    def test_config_cipher_scan_keeps_a_key_only_after_the_page_matches(self):
        raw_key = bytes((index * 7 + 3) % 256 for index in range(32))
        salt = bytes(range(16, 32))
        page = page_for(raw_key, salt)
        found, stats = keys.scan_config_cipher(
            cipher_image(raw_key, salt),
            {"message/message_0.db": page},
        )
        self.assertEqual(found, {"message/message_0.db": raw_key.hex()})
        self.assertEqual(stats["cipher_string_hits"], 1)
        self.assertGreaterEqual(stats["candidates"], 1)

        wrong = bytes((index * 7 + 4) % 256 for index in range(32))
        found, _stats = keys.scan_config_cipher(
            cipher_image(wrong, salt),
            {"message/message_0.db": page},
        )
        self.assertEqual(found, {})

    def test_raw_literal_scan_matches_salt_and_page(self):
        raw_key = bytes((index * 5 + 1) % 256 for index in range(32))
        salt = bytes(range(8, 24))
        page = page_for(raw_key, salt)
        literal = b"x'" + (raw_key.hex() + salt.hex()).encode() + b"'"
        memory = MapMemory(0x300000, literal + b"\x00" * 16)
        self.assertEqual(
            keys.scan_raw_literals(memory, {"message/message_0.db": page}),
            {"message/message_0.db": raw_key.hex()},
        )

    def test_decrypt_page_restores_the_sqlite_header(self):
        def identity(_key, _iv, data):
            return data

        page = b"\x22" * 4096
        restored = keys.decrypt_page(b"k" * 32, page, 1, identity)
        self.assertEqual(len(restored), 4096)
        self.assertTrue(restored.startswith(b"SQLite format 3\x00"))
        self.assertEqual(
            keys.aes_cbc_decrypt(
                bytes.fromhex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4"),
                bytes.fromhex("000102030405060708090a0b0c0d0e0f"),
                bytes.fromhex("f58c4c04d6e5f1ba779eabfb5f7bfbd6"),
            ),
            bytes.fromhex("6bc1bee22e409f96e93d7e117393172a"),
        )
        self.assertEqual(keys.decode_text(1, "你好".encode()), "你好")
        self.assertIsNone(keys.decode_text(3, b"image"))
        self.assertEqual(keys.message_kind(25769803825), 49)
        self.assertEqual(keys.labeled_name("wxid_friend", {"wxid_friend": {"remark": "小王", "nick": "王先生"}}), "小王(备注)")
        self.assertEqual(keys.labeled_name("wxid_friend", {"wxid_friend": {"remark": "", "nick": "王先生"}}), "王先生(昵称)")
        self.assertEqual(keys.labeled_name("wxid_friend", {}), "wxid_friend(无备注无昵称)")
        self.assertEqual(keys.labeled_name("wxid_me", {}, "wxid_me"), "自己")
        self.assertEqual(
            keys.message_preview(25769803825, "<msg><appmsg><title><![CDATA[note.txt]]></title></appmsg></msg>".encode()),
            "file=note.txt",
        )

    def test_selected_cipher_matches_the_reference_implementation_across_blocks(self):
        key = bytes((index * 11 + 5) % 256 for index in range(32))
        iv = bytes(range(16))
        data = bytes((index * 7) % 256 for index in range(4016))
        self.assertEqual(keys.aes_cbc_decrypt(key, iv, data), keys.python_aes_cbc_decrypt(key, iv, data))
        # Reusing a cached native key must not carry the previous IV forward.
        self.assertEqual(keys.aes_cbc_decrypt(key, iv, data[:32]), keys.python_aes_cbc_decrypt(key, iv, data[:32]))

    def test_database_image_rejects_a_key_that_does_not_authenticate_page_one(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "message_0.db"
            database.write_bytes(page_for(bytes(range(32))))
            self.assertTrue(keys.database_image(database, bytes(range(32)), lambda _k, _iv, data: data))
            with self.assertRaisesRegex(RuntimeError, "database_key_rejected"):
                keys.database_image(database, bytes(range(1, 33)), lambda _k, _iv, data: data)


def wal_bytes(frames, salt=(7, 9), big_endian=False):
    magic = 0x377F0683 if big_endian else 0x377F0682
    header = struct.pack(">6I", magic, 3007000, keys.PAGE_SIZE, 0, *salt)
    checksum = keys._wal_checksum(header, big_endian)
    output = bytearray(header + struct.pack(">2I", *checksum))
    for number, commit, page in frames:
        start = struct.pack(">2I", number, commit)
        checksum = keys._wal_checksum(page, big_endian, *keys._wal_checksum(start, big_endian, *checksum))
        output += start + struct.pack(">2I", *salt) + struct.pack(">2I", *checksum) + page
    return bytes(output)


class WalMerge(unittest.TestCase):
    def page(self, value):
        return bytes([value]) * keys.PAGE_SIZE

    def test_committed_frames_replace_and_extend_main_file_pages(self):
        main = self.page(1) + self.page(2)
        wal = wal_bytes([(2, 0, self.page(20)), (3, 3, self.page(30))])
        self.assertEqual(keys.committed_pages(main, wal), [self.page(1), self.page(20), self.page(30)])

    def test_frames_after_the_last_commit_are_ignored(self):
        main = self.page(1) + self.page(2)
        wal = wal_bytes([(2, 2, self.page(20)), (1, 0, self.page(10))])
        self.assertEqual(keys.committed_pages(main, wal), [self.page(1), self.page(20)])

    def test_a_broken_checksum_ends_the_wal_at_the_previous_commit(self):
        main = self.page(1) + self.page(2)
        wal = bytearray(wal_bytes([(2, 2, self.page(20)), (1, 2, self.page(10))], big_endian=True))
        wal[-1] ^= 0xFF
        self.assertEqual(keys.committed_pages(main, bytes(wal)), [self.page(1), self.page(20)])

    def test_frames_from_an_earlier_wal_generation_are_ignored(self):
        main = self.page(1) + self.page(2)
        old = wal_bytes([(2, 2, self.page(20))], salt=(1, 1))
        restarted = wal_bytes([], salt=(2, 2))
        self.assertEqual(keys.committed_pages(main, restarted + old[32:]), [self.page(1), self.page(2)])

    def test_a_damaged_or_missing_wal_header_leaves_the_main_file(self):
        main = self.page(1) + self.page(2)
        wal = bytearray(wal_bytes([(2, 2, self.page(20))]))
        wal[16] ^= 0x01
        self.assertEqual(keys.committed_pages(main, bytes(wal)), [self.page(1), self.page(2)])
        self.assertEqual(keys.committed_pages(main, b""), [self.page(1), self.page(2)])

    def test_windows_reader_accepts_empty_optional_wal_but_not_empty_database(self):
        database = Path("message_0.db")
        wal = Path("message_0.db-wal")
        files = {str(database): self.page(1), str(wal): b""}
        handles = {}
        next_handle = iter(range(100, 110))

        def create_file(path, *_args):
            handle = next(next_handle)
            handles[handle] = files[path]
            return handle

        def get_file_size(handle, output):
            ctypes.cast(output, ctypes.POINTER(ctypes.c_uint64))[0] = len(handles[handle])
            return 1

        def read_file(handle, buffer, requested, output, _overlapped):
            data = handles[handle]
            self.assertEqual(requested, len(data))
            ctypes.memmove(buffer, data, len(data))
            ctypes.cast(output, ctypes.POINTER(ctypes.c_uint32))[0] = len(data)
            return 1

        kernel32 = mock.Mock()
        kernel32.CreateFileW.side_effect = create_file
        kernel32.GetFileSizeEx.side_effect = get_file_size
        kernel32.ReadFile.side_effect = read_file
        with mock.patch.object(keys, "sys", mock.Mock(platform="win32")), \
                mock.patch.object(keys.ctypes, "WinDLL", return_value=kernel32, create=True):
            self.assertEqual(keys.read_with_wal(database), (self.page(1), b""))
            self.assertEqual(kernel32.ReadFile.call_count, 1)
            files[str(database)] = b""
            with self.assertRaisesRegex(RuntimeError, "database_unreadable"):
                keys.read_shared(database)
            self.assertEqual(kernel32.ReadFile.call_count, 1)

    def test_a_reader_never_pairs_the_main_file_with_a_restarted_wal(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "message_0.db"
            database.write_bytes(self.page(1))
            wal = Path(str(database) + "-wal")
            generations = iter([wal_bytes([(1, 1, self.page(10))], salt=(1, 1)),
                                wal_bytes([(1, 1, self.page(11))], salt=(2, 2))] * 3)

            def read(path, allow_empty=False):
                return next(generations) if path == wal else Path(path).read_bytes()

            with mock.patch.object(keys, "read_shared", side_effect=read), mock.patch.object(keys.time, "sleep"):
                with self.assertRaisesRegex(RuntimeError, "readonly_database_snapshot_busy"):
                    keys.read_with_wal(database)


if __name__ == "__main__":
    unittest.main()
