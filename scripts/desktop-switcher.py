import ctypes
from ctypes import wintypes
import os
import sys
import time
import subprocess

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

GENERIC_ALL = 0x10000000
DESKTOP_NAME = "WeChatBotDesktop"
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

def check_process_running(proc_name):
    # 检查进程名是否在运行
    cmd = f'tasklist /FI "IMAGENAME eq {proc_name}"'
    res = subprocess.run(cmd, capture_output=True, text=True, shell=True)
    return proc_name.lower() in res.stdout.lower()

def ensure_weixin_running(h_bot):
    user32.SetThreadDesktop(h_bot)
    has_win = False
    
    def enum_proc(hwnd, lparam):
        nonlocal has_win
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        if title.value.strip() in ["微信", "Weixin"]:
            has_win = True
            return False
        return True

    cb = WNDENUMPROC(enum_proc)
    user32.EnumDesktopWindows(h_bot, cb, 0)
    
    if not has_win or not check_process_running("Weixin.exe"):
        print("[*] 后台微信未运行，正在为你自动拉起微信 4.0...")
        si = STARTUPINFO()
        si.cb = ctypes.sizeof(STARTUPINFO)
        si.lpDesktop = DESKTOP_NAME
        pi = PROCESS_INFORMATION()
        working_dir = os.path.dirname(WEIXIN_PATH)
        
        kernel32.CreateProcessW(
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
        kernel32.CloseHandle(pi.hProcess)
        kernel32.CloseHandle(pi.hThread)
        print("[*] 微信 4.0 正在载入界面 (等待 4 秒)...")
        time.sleep(4)

def switch_with_gui_bar():
    h_default = user32.OpenDesktopW("Default", 0, False, GENERIC_ALL)
    h_bot = user32.OpenDesktopW(DESKTOP_NAME, 0, False, GENERIC_ALL)
    
    if not h_bot:
        h_bot = user32.CreateDesktopW(DESKTOP_NAME, None, None, 0, GENERIC_ALL, None)

    # 1. 确保微信在后台桌面已经启动
    ensure_weixin_running(h_bot)

    # 2. 在后台桌面启动一个醒目的“悬浮返回主桌面”图形按钮
    python_exe = sys.executable
    helper_script = os.path.abspath(r"d:\dsh\agy\chat\scripts\desktop-floating-bar.py")
    
    si = STARTUPINFO()
    si.cb = ctypes.sizeof(STARTUPINFO)
    si.lpDesktop = DESKTOP_NAME
    pi = PROCESS_INFORMATION()

    cmd = f'"{python_exe}" "{helper_script}"'
    kernel32.CreateProcessW(
        None,
        cmd,
        None,
        None,
        False,
        0,
        None,
        os.path.dirname(helper_script),
        ctypes.byref(si),
        ctypes.byref(pi)
    )
    kernel32.CloseHandle(pi.hProcess)
    kernel32.CloseHandle(pi.hThread)

    print("[+] 悬浮返回工具条已就绪，正在切入微信桌面...")
    time.sleep(0.5)
    
    # 3. 执行桌面切换
    user32.SwitchDesktop(h_bot)

if __name__ == "__main__":
    switch_with_gui_bar()
