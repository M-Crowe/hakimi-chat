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

    if box is not None:
        crop_left = max(left, int(box[0]))
        crop_top = max(top, int(box[1]))
        crop_right = min(right, int(box[2]))
        crop_bottom = min(bottom, int(box[3]))
        if crop_right > crop_left and crop_bottom > crop_top:
            image = image.crop((crop_left - left, crop_top - top, crop_right - left, crop_bottom - top))
    return image

WeChatGUI._grab_screen = lambda self, box=None: _capture_window_region(int(getattr(self, "main_hwnd", 0) or getattr(self, "hwnd", 0) or 0), box)

print("[*] 正在通过 wechatauto 初始化并热激活 UIA 树...")
wx = wechatauto.WeChat(start_listener=False)
uia = wx._gui._get_uia()

print(f"[+] UIA 驱动就绪: {uia}")
current = uia.current_chat()
print(f"[+] 当前活动聊天: {current}")

input_ctrl = uia._chat_input()
print(f"[+] 找到输入框控件: {input_ctrl}")

if input_ctrl:
    test_text = "哈基米智子后台测试：微信4.1 UIA树物化成功！"
    try:
        vp = input_ctrl.GetValuePattern()
        vp.SetValue(test_text)
        print(f"[+] ValuePattern 注入成功，读取输入框: {repr(vp.Value)}")
    except Exception as e:
        print(f"[-] SetValue 异常: {e}")

    # 发送回车
    try:
        input_ctrl.SendKeys("{Enter}")
        print("[+] 触发回车发送！")
    except Exception as e:
        print(f"[-] 回车异常: {e}")
