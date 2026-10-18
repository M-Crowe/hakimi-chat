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

# --- 注入 deepseekgirl 的 safe_grab_screen 兼容补丁 ---
def _capture_window_region(hwnd: int, box: tuple[int, int, int, int] | None = None):
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
    if not captured:
        raise RuntimeError("PrintWindow 截图失败")

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

def safe_grab_screen(self, box=None):
    hwnd = int(getattr(self, "main_hwnd", 0) or getattr(self, "hwnd", 0) or 0)
    return _capture_window_region(hwnd, box)

WeChatGUI._grab_screen = safe_grab_screen
print("[+] 已成功注入后台物理隔离桌面 PrintWindow 截图补丁！")

print("[*] 正在连接微信 4.1...")
wx = wechatauto.WeChat(start_listener=False)
print(f"[+] 连接成功，登录账号: {wx.nickname}")

target = "文件传输助手"
message = "哈基米智子大脑已成功接管微信 4.1！虚拟桌面隔离驱动成功~"

print(f"[*] 准备向 [{target}] 发送消息: {message}")
send_func = getattr(wx, 'send_msg', None) or getattr(wx, 'SendMsg', None)
res = send_func(msg=message, who=target)
print(f"[+] 发送完成，结果: {res}")
