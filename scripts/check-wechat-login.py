import ctypes
import os
import sys

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
GENERIC_ALL = 0x10000000

h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, GENERIC_ALL)
if not h_bot:
    print("NO_DESKTOP")
    sys.exit(0)

user32.SetThreadDesktop(h_bot)

is_logged_in = False
has_login_window = False

class RECT(ctypes.Structure):
    _fields_ = [
        ('left', ctypes.c_long),
        ('top', ctypes.c_long),
        ('right', ctypes.c_long),
        ('bottom', ctypes.c_long)
    ]

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

def enum_proc(hwnd, lparam):
    global is_logged_in, has_login_window
    length = user32.GetWindowTextLengthW(hwnd)
    if length > 0:
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        t = buf.value.strip()
        if t in ["微信", "Weixin"]:
            rect = RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = rect.right - rect.left
            if w >= 500:
                is_logged_in = True
                return False
            else:
                has_login_window = True
    return True

user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)

if is_logged_in:
    print("LOGGED_IN")
elif has_login_window:
    print("LOGIN_WINDOW_FOUND")
else:
    print("NOT_RUNNING")
