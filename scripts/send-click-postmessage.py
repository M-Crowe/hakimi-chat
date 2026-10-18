import ctypes
from ctypes import wintypes
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

import wechatauto
from wechatauto.guia import WeChatGUI

gui = WeChatGUI(hwnd=8260788)
render_hwnd = gui.render_hwnd

print(f"[+] 主窗口 HWND: {gui.main_hwnd}, 渲染窗口 HWND: {render_hwnd}")
print(f"[+] 布局范围: {gui.send_button_region}")

# 计算相对于 render_hwnd 的相对坐标
rx = (gui.send_button_region[0] + gui.send_button_region[2]) // 2
ry = (gui.send_button_region[1] + gui.send_button_region[3]) // 2
print(f"[*] 相对渲染窗口的点击坐标: ({rx}, {ry})")

GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
old_ex = user32.GetWindowLongW(render_hwnd, GWL_EXSTYLE)
if old_ex & WS_EX_TRANSPARENT:
    user32.SetWindowLongW(render_hwnd, GWL_EXSTYLE, old_ex & ~WS_EX_TRANSPARENT)
    time.sleep(0.05)

try:
    lparam = (ry << 16) | (rx & 0xFFFF)
    # 模拟鼠标移动到目标
    user32.PostMessageW(render_hwnd, 0x0200, 0, lparam) # WM_MOUSEMOVE
    time.sleep(0.05)
    # 模拟按下与释放
    user32.PostMessageW(render_hwnd, 0x0201, 1, lparam) # WM_LBUTTONDOWN
    time.sleep(0.05)
    user32.PostMessageW(render_hwnd, 0x0202, 0, lparam) # WM_LBUTTONUP
    time.sleep(0.5)
finally:
    if old_ex & WS_EX_TRANSPARENT:
        user32.SetWindowLongW(render_hwnd, GWL_EXSTYLE, old_ex)

print("[SUCCESS] PostMessage 穿透点击指令已投递完成！")
