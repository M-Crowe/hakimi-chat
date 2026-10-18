import ctypes
import os
import sys

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

import wechatauto

print("[*] 正在通过 wechatauto 连接微信 4.1...")
try:
    wx = wechatauto.WeChat(start_listener=False)
    print(f"[SUCCESS] wechatauto 连接成功！实例: {wx}")
    print(f"[+] 当前登录账号/昵称: {getattr(wx, 'nickname', '未知')}")
    print(f"[+] 微信窗口 HWND: {getattr(wx, 'hwnd', '未知')}")
except Exception as e:
    import traceback
    print(f"[-] 连接失败: {e}")
    traceback.print_exc()
