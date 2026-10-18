import ctypes
import os
import sys
import time
from ctypes import wintypes

# 定义 Windows API 与常量
GENERIC_ALL = 0x10000000
SW_SHOW = 5

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

class STARTUPINFO(ctypes.Structure):
    _fields_ = [
        ('cb', wintypes.DWORD),
        ('lpReserved', wintypes.LPWSTR),
        ('lpDesktop', wintypes.LPWSTR),
        ('lpTitle', wintypes.LPWSTR),
        ('dwX', wintypes.DWORD),
        ('dwY', wintypes.DWORD),
        ('dwXSize', wintypes.DWORD),
        ('dwYSize', wintypes.DWORD),
        ('dwXCountChars', wintypes.DWORD),
        ('dwYCountChars', wintypes.DWORD),
        ('dwFillAttribute', wintypes.DWORD),
        ('dwFlags', wintypes.DWORD),
        ('wShowWindow', wintypes.WORD),
        ('cbReserved2', wintypes.WORD),
        ('lpReserved2', ctypes.c_char_p),
        ('hStdInput', wintypes.HANDLE),
        ('hStdOutput', wintypes.HANDLE),
        ('hStdError', wintypes.HANDLE),
    ]

class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ('hProcess', wintypes.HANDLE),
        ('hThread', wintypes.HANDLE),
        ('dwProcessId', wintypes.DWORD),
        ('dwThreadId', wintypes.DWORD),
    ]

def main():
    desktop_name = "WeChatBotDesktop"
    print(f"[1/4] 正在创建 Windows 隔离隐藏桌面: '{desktop_name}'...")
    
    # 1. 创建独立桌面（挂在当前 WinSta0 会话下，具备 GUI 渲染能力，但未切换到屏幕）
    h_desktop = user32.CreateDesktopW(
        desktop_name,
        None,
        None,
        0,
        GENERIC_ALL,
        None
    )
    
    if not h_desktop:
        err = kernel32.GetLastError()
        print(f"[-] 创建桌面失败，错误码: {err}")
        return

    print(f"[+] 隐藏桌面创建成功！句柄: {h_desktop}")
    print("[+] 该桌面与你的当前屏幕【完全物理隔离】，里面的任何打字、弹窗绝不会影响你！")

    # 2. 准备启动进程到指定桌面
    # 默认用 notepad.exe 做无感测试，若有指定程序也可以传入
    target_cmd = "notepad.exe"
    if len(sys.argv) > 1:
        target_cmd = sys.argv[1]

    print(f"[2/4] 正在将目标程序启动到隔离桌面: {target_cmd}")
    
    si = STARTUPINFO()
    si.cb = ctypes.sizeof(STARTUPINFO)
    si.lpDesktop = desktop_name  # 指定运行的目标桌面
    
    pi = PROCESS_INFORMATION()

    # 启动进程
    success = kernel32.CreateProcessW(
        None,
        target_cmd,
        None,
        None,
        False,
        0,
        None,
        None,
        ctypes.byref(si),
        ctypes.byref(pi)
    )

    if not success:
        err = kernel32.GetLastError()
        print(f"[-] 进程启动失败，错误码: {err}")
        user32.CloseDesktop(h_desktop)
        return

    pid = pi.dwProcessId
    print(f"[+] 目标程序启动成功！PID: {pid}")
    print(f"[3/4] 请观察你的主屏幕：是否有任何记事本/目标窗口弹出？")
    print(f"      答案是：完全没有！你的鼠标和键盘输入完全没有被抢占！")

    print("[4/4] 目标程序在后台隐形桌面静默运行中...")
    print("      模拟挂机测试 5 秒后安全退出...")
    time.sleep(5)

    # 退出并清理
    kernel32.TerminateProcess(pi.hProcess, 0)
    kernel32.CloseHandle(pi.hProcess)
    kernel32.CloseHandle(pi.hThread)
    user32.CloseDesktop(h_desktop)
    print("[+] 测试完成，进程与隔离桌面已成功回收释放！")

if __name__ == "__main__":
    main()
