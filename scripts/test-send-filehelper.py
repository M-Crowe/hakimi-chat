import ctypes
from ctypes import wintypes
import time
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
    time.sleep(0.05)
    user32.keybd_event(vk, 0, 2, 0) # KEYEVENTF_KEYUP
    time.sleep(0.05)

def send_shortcut(mod, key):
    user32.keybd_event(mod, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(key, 0, 0, 0)
    time.sleep(0.05)
    user32.keybd_event(key, 0, 2, 0)
    time.sleep(0.05)
    user32.keybd_event(mod, 0, 2, 0)
    time.sleep(0.05)

def main():
    h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, GENERIC_ALL)
    if not h_bot:
        print("[-] 无法打开微信后台桌面")
        return

    # 绑定线程到后台桌面
    user32.SetThreadDesktop(h_bot)

    # 寻找微信窗口
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
        return

    print(f"[+] 找到微信窗口 HWND: {target_hwnd}，准备在后台发送测试消息...")
    
    # 激活后台微信窗口并置顶（仅在后台桌面置顶，主桌面不可见）
    user32.ShowWindow(target_hwnd, 9) # SW_RESTORE
    user32.SetForegroundWindow(target_hwnd)
    time.sleep(0.5)

    # 1. 触发搜索快捷键 Ctrl + F 查找“文件传输助手”
    print("[1/4] 搜索 '文件传输助手'...")
    send_shortcut(VK_CONTROL, VK_F)
    time.sleep(0.3)
    pyperclip.copy("文件传输助手")
    send_shortcut(VK_CONTROL, VK_V)
    time.sleep(0.5)
    
    # 2. 按回车进入聊天
    print("[2/4] 按回车进入对话...")
    send_key(VK_RETURN)
    time.sleep(0.5)

    # 3. 输入测试内容
    test_text = "哈基米伴聊大脑已连接！微信4.1后台测试成功~"
    print(f"[3/4] 写入测试消息: {test_text}")
    pyperclip.copy(test_text)
    send_shortcut(VK_CONTROL, VK_V)
    time.sleep(0.3)

    # 4. 按回车发送
    print("[4/4] 按回车发送！")
    send_key(VK_RETURN)
    time.sleep(0.5)

    print("[SUCCESS] 消息已在后台微信 4.1 发送！请查看你的手机微信文件传输助手！")

if __name__ == "__main__":
    main()
