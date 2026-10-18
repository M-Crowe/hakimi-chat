import ctypes
from ctypes import wintypes
import os
import sys
import time
from PIL import Image
import win32gui
import win32ui

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

import wechatauto
from wechatauto.guia import WeChatGUI

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

WeChatGUI._grab_screen = lambda self, box=None: _capture_window_region(int(getattr(self, "main_hwnd", 0) or getattr(self, "hwnd", 0) or 0), box)

gui = WeChatGUI(hwnd=8260788)

print("[*] 正在通过 OCR 识别发送按钮绝对坐标...")
res = gui.ocr(gui.send_button_region)
print(f"[+] OCR 识别结果: {res}")

for item in res:
    text, x, y, w, h = item
    if '发送' in text:
        click_x = gui.origin_x + x + w // 2
        click_y = gui.origin_y + y + h // 2
        print(f"[+] 找到发送按钮！精准点击坐标: ({click_x}, {click_y})")
        gui.wx_click(click_x, click_y)
        time.sleep(0.5)
        print("[+] 已执行精准点击！")
        break
