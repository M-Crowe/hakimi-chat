"""
哈基米聊天系统 - 微信虚拟桌面彻底关闭与销毁工具
- 确保当前屏幕切回默认主桌面 (Default)
- 彻底终止后台虚拟桌面 WeChatBotDesktop 内的所有运行进程 (包括 Weixin.exe)
- 释放全部桌面句柄，使 Windows 内核自动销毁隔离虚拟桌面
"""

import ctypes
from ctypes import wintypes
import os
import sys
import subprocess

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
GENERIC_ALL = 0x10000000
DESKTOP_NAME = "WeChatBotDesktop"

def open_default_desktop():
    for mask in [0x0100 | 0x0001 | 0x0080, 0x0100, GENERIC_ALL, 0x02000000]:
        h = user32.OpenDesktopW("Default", 0, False, mask)
        if h:
            return h
    return 0

def close_desktop_and_wechat():
    print("[*] 正在安全切回主桌面并关闭微信虚拟桌面...")

    # 1. 确保切回主桌面 (Default)
    h_default = open_default_desktop()
    if h_default:
        user32.SwitchDesktop(h_default)
        user32.SetThreadDesktop(h_default)

    # 2. 检查微信虚拟桌面是否存在
    h_bot = user32.OpenDesktopW(DESKTOP_NAME, 0, False, GENERIC_ALL)
    if not h_bot:
        print("[*] 微信虚拟桌面未在运行中。")
        # 仍然检查是否有残留的后台 Weixin.exe
        subprocess.run("taskkill /F /IM Weixin.exe >nul 2>&1", shell=True)
        return

    # 3. 查找该虚拟桌面内的所有窗口 PID
    pids_to_kill = set()
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def enum_proc(hwnd, lparam):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value > 0:
            pids_to_kill.add(pid.value)
        return True

    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)

    # 4. 彻底终止这些 PID
    for pid in pids_to_kill:
        try:
            subprocess.run(f"taskkill /F /T /PID {pid} >nul 2>&1", shell=True)
        except Exception:
            pass

    # 5. 确保微信进程彻底结束
    subprocess.run("taskkill /F /IM Weixin.exe >nul 2>&1", shell=True)

    # 6. 关闭桌面句柄
    user32.CloseDesktop(h_bot)
    if h_default:
        user32.CloseDesktop(h_default)

    print("✅ 微信虚拟桌面已成功关闭与销毁，微信进程已完全退出！")

if __name__ == "__main__":
    close_desktop_and_wechat()
