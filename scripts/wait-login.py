import ctypes
from ctypes import wintypes
import time
import win32gui

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

print("[*] 正在常驻保持 WeChatBotDesktop 桌面，等待手机微信扫码登录...")

def check_login():
    main_found = False
    def enum_proc(hwnd, lparam):
        nonlocal main_found
        t = win32gui.GetWindowText(hwnd)
        if t.strip() == "微信":
            l, top, r, b = win32gui.GetWindowRect(hwnd)
            w, h = r - l, b - top
            if w > 500:
                main_found = True
                return False
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)
    return main_found

for i in range(120): # 最多等待 120 秒
    if check_login():
        print(f"\n[SUCCESS] 微信 4.1 登录成功！主窗口已展开（耗时 {i*2}s）")
        break
    time.sleep(2)
