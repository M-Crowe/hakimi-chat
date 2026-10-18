import ctypes
from ctypes import wintypes
import time

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

main_hwnd = 8260788
render_hwnd = 15405926

WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
VK_RETURN = 0x0D

print(f"[*] 正在向 main_hwnd={main_hwnd} 与 render_hwnd={render_hwnd} 投递回车发送消息...")

for target in [render_hwnd, main_hwnd]:
    # 模拟回车按下与松开
    user32.PostMessageW(target, WM_KEYDOWN, VK_RETURN, 0x001C0001)
    time.sleep(0.05)
    user32.PostMessageW(target, WM_CHAR, VK_RETURN, 0x001C0001)
    time.sleep(0.05)
    user32.PostMessageW(target, WM_KEYUP, VK_RETURN, 0xC01C0001)
    time.sleep(0.1)

print("[+] 回车指令投递完毕！")
