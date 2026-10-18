import ctypes
import os
import sys
import time

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

import wechatauto
from wechatauto.guia import WeChatGUI
from PIL import Image
import win32gui
import win32ui

# 注入 PrintWindow 截图补丁
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
    return image

WeChatGUI._grab_screen = lambda self, box=None: _capture_window_region(int(getattr(self, "main_hwnd", 0) or getattr(self, "hwnd", 0) or 0), box)

print("[*] 正在连接微信...")
wx = wechatauto.WeChat(start_listener=False)
gui = wx._gui

# 计算绿色发送按钮绝对坐标
ratio = getattr(gui, 'send_button_ratio', [0.9068, 0.9, 0.9795, 0.9604])
rx = (ratio[0] + ratio[2]) / 2
ry = (ratio[1] + ratio[3]) / 2

rect = getattr(gui, 'rect', (600, 221, 1920, 1181))
width = rect[2] - rect[0]
height = rect[3] - rect[1]

btn_x = int(rect[0] + width * rx)
btn_y = int(rect[1] + height * ry)

print(f"[*] 准备点击绿色发送按钮: 坐标 ({btn_x}, {btn_y})")
gui.wx_click(btn_x, btn_y)
time.sleep(0.5)

print("[+] 发送按钮点击完成！")
