import ctypes
import os
import sys
import time
from ctypes import wintypes
from PIL import Image, ImageGrab

GENERIC_ALL = 0x10000000
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
gdi32 = ctypes.windll.gdi32

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

def launch_weixin_in_desktop():
    desktop_name = "WeChatBotDesktop"
    print(f"[*] 检查/创建独立桌面: {desktop_name}...")
    
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

    print(f"[+] 独立桌面就绪，句柄: {h_desktop}")
    
    if not os.path.exists(WEIXIN_PATH):
        print(f"[-] 未找到微信程序: {WEIXIN_PATH}")
        return

    si = STARTUPINFO()
    si.cb = ctypes.sizeof(STARTUPINFO)
    si.lpDesktop = desktop_name
    pi = PROCESS_INFORMATION()

    print(f"[*] 正在将微信 4.0 启动到后台隐藏桌面: {WEIXIN_PATH}")
    # 关键：指定微信工作目录
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

    print(f"[+] 微信 4.0 成功在后台隔离桌面启动！PID: {pi.dwProcessId}")
    print("[*] 提示：请观察你的屏幕，应该【没有任何微信窗口弹出】，完全不影响你当前使用！")

    # 保持一小会观察微信是否正常存活
    print("[*] 正在等待微信加载初始化 (5秒)...")
    time.sleep(5)
    
    # 检查进程是否还在运行
    exit_code = wintypes.DWORD()
    kernel32.GetExitCodeProcess(pi.hProcess, ctypes.byref(exit_code))
    if exit_code.value == 259: # STILL_ACTIVE
        print("[+] 微信 4.0 正在隔离桌面稳定运行中（STILL_ACTIVE）！")
    else:
        print(f"[*] 微信进程退出码: {exit_code.value}（可能拉起了子进程或已有主进程）")

    kernel32.CloseHandle(pi.hProcess)
    kernel32.CloseHandle(pi.hThread)

if __name__ == "__main__":
    launch_weixin_in_desktop()
