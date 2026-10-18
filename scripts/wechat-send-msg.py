import ctypes
from ctypes import wintypes
import time
import sys
import pyperclip

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

GENERIC_ALL = 0x10000000
VK_CONTROL = 0x11
VK_F = 0x46
VK_V = 0x56
VK_RETURN = 0x0D

def send_key(vk):
    user32.keybd_event(vk, 0, 0, 0)
    time.sleep(0.06)
    user32.keybd_event(vk, 0, 2, 0)
    time.sleep(0.06)

def send_shortcut(mod, key):
    user32.keybd_event(mod, 0, 0, 0)
    time.sleep(0.06)
    user32.keybd_event(key, 0, 0, 0)
    time.sleep(0.06)
    user32.keybd_event(key, 0, 2, 0)
    time.sleep(0.06)
    user32.keybd_event(mod, 0, 2, 0)
    time.sleep(0.06)

def send_wechat_message(target_who, message_text):
    h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, GENERIC_ALL)
    if not h_bot:
        print("[-] 无法打开 WeChatBotDesktop")
        return False

    user32.SetThreadDesktop(h_bot)

    # 找到微信窗口
    target_hwnd = None
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        nonlocal target_hwnd
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        if title.value.strip() == "微信":
            target_hwnd = hwnd
            return False
        return True

    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)
    if not target_hwnd:
        print("[-] 未在后台桌面找到微信主窗口")
        return False

    # 激活并置顶
    user32.ShowWindow(target_hwnd, 9)
    user32.SetForegroundWindow(target_hwnd)
    time.sleep(0.4)

    # 1. 搜索目标会话
    print(f"[*] 搜索目标联系人/群聊: {target_who}")
    send_shortcut(VK_CONTROL, VK_F)
    time.sleep(0.3)
    pyperclip.copy(target_who)
    send_shortcut(VK_CONTROL, VK_V)
    time.sleep(0.5)

    # 2. 回车选中会话进入聊天
    send_key(VK_RETURN)
    time.sleep(0.5)

    # 3. 粘贴消息内容
    print(f"[*] 写入消息内容: {message_text}")
    pyperclip.copy(message_text)
    send_shortcut(VK_CONTROL, VK_V)
    time.sleep(0.4)

    # 4. 回车发送
    send_key(VK_RETURN)
    time.sleep(0.3)
    print(f"[+] 消息已成功发送给 '{target_who}'！")
    return True

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "文件传输助手"
    msg = sys.argv[2] if len(sys.argv) > 2 else "哈基米伴聊大脑已连接！微信4.0后台全自动发送测试成功~"
    send_wechat_message(target, msg)
