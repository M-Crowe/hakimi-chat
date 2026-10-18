import ctypes
import os
import sys
import time
from ctypes import wintypes

GENERIC_ALL = 0x10000000
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

WEIXIN_PATH = r"D:\Program Files\Tencent\Weixin\Weixin.exe"

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

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

def check_desktop_windows(h_desktop):
    windows = []
    def enum_proc(hwnd, lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, 256)
        
        is_visible = user32.IsWindowVisible(hwnd)
        windows.append((hwnd, title.value, class_name.value, is_visible))
        return True

    cb = WNDENUMPROC(enum_proc)
    user32.EnumDesktopWindows(h_desktop, cb, 0)
    return windows

def main():
    desktop_name = "WeChatBotDesktop"
    h_desktop = user32.CreateDesktopW(
        desktop_name,
        None,
        None,
        0,
        GENERIC_ALL,
        None
    )
    if not h_desktop:
        print(f"[-] 创建桌面失败: {kernel32.GetLastError()}")
        return

    print(f"[+] 独立桌面句柄: {h_desktop}")
    
    # 将当前 Python 线程的桌面切换到 WeChatBotDesktop，以便能直接对该桌面进行窗口枚举和 UI 操作！
    user32.SetThreadDesktop(h_desktop)

    si = STARTUPINFO()
    si.cb = ctypes.sizeof(STARTUPINFO)
    si.lpDesktop = desktop_name
    pi = PROCESS_INFORMATION()

    working_dir = os.path.dirname(WEIXIN_PATH)
    success = kernel32.CreateProcessW(
        None,
        WEIXIN_PATH,
        None,
        None,
        False,
        0,
        None,
        working_dir,
        ctypes.byref(si),
        ctypes.byref(pi)
    )

    if not success:
        print(f"[-] 微信启动失败: {kernel32.GetLastError()}")
        return

    print(f"[+] 微信 PID: {pi.dwProcessId} 启动成功")
    
    # 轮询 15 秒监控微信窗口产生情况
    for i in range(15):
        time.sleep(1)
        wins = check_desktop_windows(h_desktop)
        active_wins = [w for w in wins if w[1] or w[2]]
        print(f"[{i+1}s] 后台桌面窗口数: {len(wins)}, 有效窗口: {[w[1] for w in active_wins if w[1]]}")
        
        exit_code = wintypes.DWORD()
        kernel32.GetExitCodeProcess(pi.hProcess, ctypes.byref(exit_code))
        if exit_code.value != 259:
            print(f"[-] 微信主进程在第 {i+1} 秒退出，代码: {exit_code.value}")
            break

    kernel32.CloseHandle(pi.hProcess)
    kernel32.CloseHandle(pi.hThread)

if __name__ == "__main__":
    main()
