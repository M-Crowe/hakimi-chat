import ctypes
from ctypes import wintypes
import time
import os
import win32gui
import win32ui
from PIL import Image

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
DESKTOP_NAME = "WeChatBotDesktop"
WEIXIN_PATH = r"D:\Program Files\Tencent\Weixin\Weixin.exe"

h_bot = user32.OpenDesktopW(DESKTOP_NAME, 0, False, 0x10000000)
if not h_bot:
    h_bot = user32.CreateDesktopW(DESKTOP_NAME, None, None, 0, 0x10000000, None)
user32.SetThreadDesktop(h_bot)

def _capture_window_region(hwnd: int, box=None):
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width, height = right - left, bottom - top
    hwnd_dc = win32gui.GetWindowDC(hwnd)
    source_dc = win32ui.CreateDCFromHandle(hwnd_dc)
    memory_dc = source_dc.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    bitmap.CreateCompatibleBitmap(source_dc, width, height)
    memory_dc.SelectObject(bitmap)

    captured = bool(ctypes.windll.user32.PrintWindow(hwnd, memory_dc.GetSafeHdc(), 2))
    if not captured:
        captured = bool(ctypes.windll.user32.PrintWindow(hwnd, memory_dc.GetSafeHdc(), 0))
    info = bitmap.GetInfo()
    data = bitmap.GetBitmapBits(True)
    image = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), data, "raw", "BGRX", 0, 1)

    win32gui.DeleteObject(bitmap.GetHandle())
    memory_dc.DeleteDC()
    source_dc.DeleteDC()
    win32gui.ReleaseDC(hwnd, hwnd_dc)

    if box is not None:
        crop_left = max(left, int(box[0]))
        crop_top = max(top, int(box[1]))
        crop_right = min(right, int(box[2]))
        crop_bottom = min(bottom, int(box[3]))
        if crop_right > crop_left and crop_bottom > crop_top:
            image = image.crop((crop_left - left, crop_top - top, crop_right - left, crop_bottom - top))
    return image

import wechatauto
from wechatauto.guia import WeChatGUI
from wechatauto.uia_driver import WeChatUIA, _title_is_main

WeChatGUI._grab_screen = lambda self, box=None: _capture_window_region(int(getattr(self, "main_hwnd", 0) or getattr(self, "hwnd", 0) or 0), box)

def patched_wechat_hwnds(self, diag=None):
    res = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        title = win32gui.GetWindowText(hwnd)
        if win32gui.IsWindowVisible(hwnd) and _title_is_main(title):
            pid = self._pid_from_hwnd(hwnd)
            if pid and self._weixin_dll_module(pid):
                l, t, r, b = win32gui.GetWindowRect(hwnd)
                res.append(((r - l) * (b - t), hwnd))
        return True
    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)
    res.sort(reverse=True)
    return [h for _, h in res]

WeChatUIA._wechat_hwnds = patched_wechat_hwnds

def patched_find_main_window(self, title):
    main_hwnd = 0
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        nonlocal main_hwnd
        t = win32gui.GetWindowText(hwnd)
        if t.strip() == "微信":
            main_hwnd = hwnd
            return False
        return True
    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)
    return main_hwnd

WeChatGUI._find_main_window = patched_find_main_window

print("[*] 正在连接微信客户端...")
wx = wechatauto.WeChat(start_listener=False)
print(f"[+] 微信连接就绪，当前登录人: {wx.nickname}")

target = "道馆馆"
print(f"[*] 注册监听群聊: [{target}]...")
try:
    wx.AddListenChat(who=target)
    print(f"[+] 成功注册监听: [{target}]")
except Exception as e:
    print(f"[-] 注册监听异常: {e}")

print("[*] 开始轮询监听消息 (测试 10 秒)...")
for i in range(10):
    try:
        msgs = wx.GetListenMessage()
        if msgs:
            print(f"[{i+1}s] 收到消息: {msgs}")
        else:
            print(f"[{i+1}s] 无新消息")
    except Exception as e:
        print(f"[{i+1}s] 轮询异常: {e}")
    time.sleep(1)

print("[*] 监听测试完成")
