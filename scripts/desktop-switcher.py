import ctypes
from ctypes import wintypes
import os
import sys
import tempfile
import time
import subprocess
import winreg

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

DESKTOP_SWITCHDESKTOP = 0x0100
DESKTOP_READOBJECTS = 0x0001
DESKTOP_WRITEOBJECTS = 0x0080
GENERIC_ALL = 0x10000000
DESKTOP_NAME = "WeChatBotDesktop"

SIGNAL_FILE = os.path.join(tempfile.gettempdir(), "hakimi_desktop_switch_back.sig")

def open_default_desktop():
    for mask in [0x0100 | 0x0001 | 0x0080, 0x0100, GENERIC_ALL, 0x02000000]:
        h = user32.OpenDesktopW("Default", 0, False, mask)
        if h:
            return h
    return 0

def find_weixin_path():
    candidates = [
        os.environ.get("WEIXIN_PATH"),
        r"C:\Program Files\Tencent\Weixin\Weixin.exe",
        r"C:\Program Files (x86)\Tencent\Weixin\Weixin.exe",
        r"D:\Program Files\Tencent\Weixin\Weixin.exe",
        r"D:\Program Files (x86)\Tencent\Weixin\Weixin.exe",
        r"E:\Program Files\Tencent\Weixin\Weixin.exe",
        r"E:\Program Files (x86)\Tencent\Weixin\Weixin.exe",
    ]
    for root in [winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE]:
        for subkey in [r"Software\Tencent\Weixin", r"SOFTWARE\WOW6432Node\Tencent\Weixin"]:
            try:
                k = winreg.OpenKey(root, subkey)
                val, _ = winreg.QueryValueEx(k, "InstallPath")
                winreg.CloseKey(k)
                if val:
                    p = os.path.join(val, "Weixin.exe")
                    if os.path.exists(p):
                        return p
            except Exception:
                pass
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return r"C:\Program Files\Tencent\Weixin\Weixin.exe"

WEIXIN_PATH = find_weixin_path()

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
    # 0. 清理旧信号文件
    if os.path.exists(SIGNAL_FILE):
        try:
            os.remove(SIGNAL_FILE)
        except Exception:
            pass

    # 1. 在主桌面常驻并持有主桌面句柄
    h_default = open_default_desktop()
    h_bot = user32.OpenDesktopW(DESKTOP_NAME, 0, False, GENERIC_ALL)
    if not h_bot:
        h_bot = user32.CreateDesktopW(DESKTOP_NAME, None, None, 0, GENERIC_ALL, None)

    # 2. 确保微信在后台桌面已经启动
    ensure_weixin_running(h_bot)

    # 3. 在后台桌面启动“悬浮返回主桌面”导航条
    python_exe = sys.executable
    helper_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "desktop-floating-bar.py")
    
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

    print("[+] 悬浮返回工具条与双向安全看门狗已就绪，正在切入微信桌面...")
    time.sleep(0.5)
    
    # 4. 执行桌面切换
    user32.SwitchDesktop(h_bot)

    # 5. 【核心防卡死守护】主桌面看门狗常驻监听
    # 无论虚拟桌面内发生任何异常（误关窗口、闪退、找不到按钮），60秒或收到信号均必定切回主桌面！
    start_time = time.time()
    max_duration = 60  # 60秒保底倒计时
    print(f"[*] 主桌面看门狗已激活 (最长等待 {max_duration} 秒或扫码后返回)...")

    while time.time() - start_time < max_duration:
        time.sleep(0.3)
        # 监听虚拟桌面的返回信号
        if os.path.exists(SIGNAL_FILE):
            print("[+] 收到虚拟桌面返回指令，正在切换回日常主桌面...")
            break

    # 6. 超时或收到信号后，主桌面看门狗强制执行切回主桌面
    for handle in [h_default, open_default_desktop()]:
        if handle:
            try:
                user32.SwitchDesktop(handle)
                user32.SetThreadDesktop(handle)
                break
            except Exception:
                pass

    # 清理信号文件
    try:
        if os.path.exists(SIGNAL_FILE):
            os.remove(SIGNAL_FILE)
    except Exception:
        pass

    print("[+] 已安全返回日常电脑主屏幕！")

if __name__ == "__main__":
    switch_with_gui_bar()
