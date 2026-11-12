import unittest
from pathlib import PurePosixPath
from stage import windows_key, safe_name

class WindowsPaths(unittest.TestCase):
    def test_normal_unicode_and_case_collision_key(self):
        self.assertEqual(windows_key(PurePosixPath('程序 Files/CHAT.json')), windows_key(PurePosixPath('程序 Files/chat.json')))
    def test_reserved_device_names_and_trailing_characters(self):
        for value in ['CON.txt', 'a/aux', 'COM9.log', 'a/LPT1', 'tail.', 'tail ', 'a/b:c', 'a/why?.js']:
            with self.subTest(value=value), self.assertRaises(ValueError): windows_key(PurePosixPath(value))
    def test_archive_escape_refused(self):
        for value in ['../outside', '/absolute', 'package/../../outside', 'package\\outside']:
            with self.subTest(value=value), self.assertRaises(ValueError): safe_name(value)

if __name__ == '__main__': unittest.main()
