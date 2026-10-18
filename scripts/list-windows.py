import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

windows = []
def enum_proc(hwnd, lparam):
    length = user32.GetWindowTextLengthW(hwnd)
    title = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, title, length + 1)
    
    cls = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, cls, 256)
    
    vis = user32.IsWindowVisible(hwnd)
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    
    windows.append((hwnd, title.value, cls.value, vis, w, h))
    return True

cb = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(enum_proc)
user32.EnumDesktopWindows(h_bot, cb, 0)

for w in windows:
    if w[3] and (w[1] or w[4] > 50):
        print(f"HWND: {w[0]}, Title: '{w[1]}', Class: '{w[2]}', Size: {w[4]}x{w[5]}")
