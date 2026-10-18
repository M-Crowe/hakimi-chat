import ctypes
from ctypes import wintypes
import time
import pyperclip

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

GENERIC_ALL = 0x10000000
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
WM_PASTE = 0x0302
VK_RETURN = 0x0D

def main():
    h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, GENERIC_ALL)
    user32.SetThreadDesktop(h_bot)

    # 寻找微信主窗口
    main_hwnd = 8260788
    # 枚举其子窗口找 MMUIRenderSubWindowHW
    sub_hwnd = None
    def enum_child(hwnd, lparam):
        nonlocal sub_hwnd
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        if "MMUIRender" in cls.value:
            sub_hwnd = hwnd
            return False
        return True

    cb = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(enum_child)
    user32.EnumChildWindows(main_hwnd, cb, 0)
    
    target = sub_hwnd if sub_hwnd else main_hwnd
    print(f"[+] 目标输入窗口 HWND: {target} (sub: {sub_hwnd})")

    rect = wintypes.RECT()
    user32.GetWindowRect(target, ctypes.byref(rect))
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    print(f"[+] 窗口尺寸: {w}x{h}")

    # 将内容放入剪贴板
    test_msg = "哈基米智子后台 PostMessage 静默发送成功~"
    pyperclip.copy(test_msg)

    # 点击输入框位置：右半部分偏下，大约在 x = int(w * 0.6), y = int(h * 0.85)
    click_x = int(w * 0.6)
    click_y = int(h * 0.85)
    lparam = (click_y << 16) | (click_x & 0xFFFF)

    print(f"[*] 点击输入框区域: ({click_x}, {click_y})")
    user32.PostMessageW(target, WM_LBUTTONDOWN, 1, lparam)
    time.sleep(0.05)
    user32.PostMessageW(target, WM_LBUTTONUP, 0, lparam)
    time.sleep(0.2)

    # 模拟按下 Ctrl+V
    # 微信 Qt / Chromium 窗口支持通过发送按键或者 WM_PASTE
    print("[*] 触发粘贴...")
    user32.PostMessageW(target, WM_PASTE, 0, 0)
    
    # 也向窗口直接发送字符以防 WM_PASTE 被忽略
    time.sleep(0.2)
    # 按回车发送
    print("[*] 触发回车发送...")
    user32.PostMessageW(target, WM_KEYDOWN, VK_RETURN, 0x001C0001)
    time.sleep(0.05)
    user32.PostMessageW(target, WM_KEYUP, VK_RETURN, 0xC01C0001)
    
    print("[+] 发送指令完成！")

if __name__ == "__main__":
    main()
