import ctypes
import os
import sys

# 关键：在导入任何 COM / UIA / wxauto 模块之前，先将线程桌面切换到 WeChatBotDesktop！
user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
if not h_bot:
    print("[-] 无法打开 WeChatBotDesktop")
    sys.exit(1)

res = user32.SetThreadDesktop(h_bot)
print(f"[+] 线程桌面切换到隔离桌面状态: {res}")

import wxauto4

print("[*] 正在初始化 WeChat 实例...")
wx = wxauto4.WeChat(ads=False)
print(f"[SUCCESS] wxauto4 成功连接微信 4.0 实例: {wx}")

try:
    current = wx.CurrentChat()
    print(f"[+] 当前活动会话: {current}")
except Exception as e:
    print(f"[*] CurrentChat: {e}")

try:
    sessions = wx.GetSessionList()
    print(f"[+] 会话列表 (前 5 个): {sessions[:5]}")
except Exception as e:
    print(f"[*] GetSessionList: {e}")
