import ctypes
import os
import sys
import time
from ctypes import wintypes
import win32gui
import win32ui
from PIL import Image

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
if not h_bot:
    print("[-] 无法打开 WeChatBotDesktop 桌面")
    sys.exit(1)
user32.SetThreadDesktop(h_bot)

# 1. 注入后台窗口 PrintWindow 截图补丁
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
WeChatGUI._grab_screen = lambda self, box=None: _capture_window_region(int(getattr(self, "main_hwnd", 0) or getattr(self, "hwnd", 0) or 0), box)

print("[*] 正在初始化 WeChat 客户端...")
wx = wechatauto.WeChat(start_listener=False)
print(f"[+] WeChat 初始化完成，昵称: {wx.nickname}")

gui = getattr(wx, "_gui", None)
uia = gui._get_uia(refresh=True)
if not uia.is_materialized():
    print("[*] 正在物化 UIA 树...")
    uia.ensure_materialized(timeout=8, force=True)

main = uia._find_main()
if main:
    uia._win = main
    uia._activate(main)
    print(f"[+] UIA 树物化成功，主窗口: {main}")
else:
    print("[-] 未找到主窗口 UIA 元素")

print(f"[+] 当前聊天: {uia.current_chat()}")

# 测试发送消息到 道馆馆
room = "道馆馆"
print(f"[*] 准备向 [{room}] 发送测试消息...")
current = uia.current_chat() or ""
if room not in current:
    print(f"[*] 切换聊天至: {room}")
    wx.ChatWith(room)
    time.sleep(1)

input_ctrl = uia._chat_input()
if input_ctrl:
    vp = input_ctrl.GetValuePattern()
    msg = "智子测试：后台桌面端到端连通验证成功！"
    vp.SetValue(msg)
    time.sleep(0.1)
    input_ctrl.SendKeys("{Enter}")
    print("[SUCCESS] 消息已注入并触发回车发送！")
else:
    print("[-] 未找到输入框")
