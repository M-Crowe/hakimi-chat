import ctypes
from ctypes import wintypes
import time

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

print("[*] 正在通过 wxauto4 连接已登录的微信 4.0...")
import wxauto4

wx = wxauto4.WeChat()
print(f"[+] wxauto4 连接成功！当前微信对象: {wx}")

# 尝试获取当前微信登录的昵称或基本信息
try:
    print(f"[+] 当前打开的聊天会话: {wx.CurrentChat()}")
except Exception as e:
    print(f"[*] 获取 CurrentChat 提示: {e}")

try:
    # 尝试列出当前左侧最近会话列表
    sessions = wx.GetSessionList()
    print(f"[+] 最近会话列表 (前 5 个): {sessions[:5]}")
except Exception as e:
    print(f"[*] GetSessionList 提示: {e}")
