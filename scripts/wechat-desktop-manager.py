import ctypes
from ctypes import wintypes
import os
import sys
import time
from PIL import Image

GENERIC_ALL = 0x10000000
PW_RENDERFULLCONTENT = 0x00000002

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

WEIXIN_PATH = r"D:\Program Files\Tencent\Weixin\Weixin.exe"
DESKTOP_NAME = "WeChatBotDesktop"

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

class RECT(ctypes.Structure):
    _fields_ = [
        ('left', wintypes.LONG),
        ('top', wintypes.LONG),
        ('right', wintypes.LONG),
        ('bottom', wintypes.LONG)
    ]

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ('biSize', wintypes.DWORD),
        ('biWidth', wintypes.LONG),
        ('biHeight', wintypes.LONG),
        ('biPlanes', wintypes.WORD),
        ('biBitCount', wintypes.WORD),
        ('biCompression', wintypes.DWORD),
        ('biSizeImage', wintypes.DWORD),
        ('biXPelsPerMeter', wintypes.LONG),
        ('biYPelsPerMeter', wintypes.LONG),
        ('biClrUsed', wintypes.DWORD),
        ('biClrImportant', wintypes.DWORD)
    ]

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

def get_or_create_desktop():
    h_desktop = user32.OpenDesktopW(DESKTOP_NAME, 0, False, GENERIC_ALL)
    if not h_desktop:
        h_desktop = user32.CreateDesktopW(
            DESKTOP_NAME,
            None,
            None,
            0,
            GENERIC_ALL,
            None
        )
    return h_desktop

def find_weixin_window(h_desktop):
    user32.SetThreadDesktop(h_desktop)
    found = []

    def enum_proc(hwnd, lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, 256)
        
        t = title.value.strip()
        c = class_name.value.strip()
        if t in ["微信", "Weixin"] or "WeChat" in c or "Weixin" in c:
            found.append((hwnd, t, c))
        return True

    cb = WNDENUMPROC(enum_proc)
    user32.EnumDesktopWindows(h_desktop, cb, 0)
    return found

dwmapi = ctypes.windll.dwmapi
DWMWA_EXTENDED_FRAME_BOUNDS = 9

def capture_window_to_file(hwnd, save_path):
    rect = RECT()
    # 优先使用 DWM 获取包含高清缩放的真实窗口矩形
    hr = dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect))
    if hr != 0:
        user32.GetWindowRect(hwnd, ctypes.byref(rect))

    width = rect.right - rect.left
    height = rect.bottom - rect.top
    
    if width <= 0 or height <= 0:
        width = 380
        height = 540

    hwnd_dc = user32.GetWindowDC(hwnd)
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bitmap = gdi32.CreateCompatibleBitmap(hwnd_dc, width, height)
    gdi32.SelectObject(mem_dc, bitmap)

    res = user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)
    if not res:
        user32.PrintWindow(hwnd, mem_dc, 0)

    bmpinfo = BITMAPINFOHEADER()
    bmpinfo.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmpinfo.biWidth = width
    bmpinfo.biHeight = -height
    bmpinfo.biPlanes = 1
    bmpinfo.biBitCount = 32
    bmpinfo.biCompression = 0

    buffer_size = width * height * 4
    buffer = ctypes.create_string_buffer(buffer_size)
    gdi32.GetDIBits(mem_dc, bitmap, 0, height, buffer, ctypes.byref(bmpinfo), 0)

    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(hwnd, hwnd_dc)

    img = Image.frombuffer('RGBA', (width, height), buffer, 'raw', 'BGRA', 0, 1)
    rgb_img = Image.new("RGB", img.size, (255, 255, 255))
    rgb_img.paste(img, mask=img.split()[3])
    
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    rgb_img.save(save_path)
    return True

def cmd_launch():
    h_desktop = get_or_create_desktop()
    print(f"[+] 独立隔离桌面句柄: {h_desktop}")
    
    si = STARTUPINFO()
    si.cb = ctypes.sizeof(STARTUPINFO)
    si.lpDesktop = DESKTOP_NAME
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
        print(f"[-] 微信 4.0 启动失败: {kernel32.GetLastError()}")
        return None

    print(f"[+] 微信 4.0 启动成功 (PID: {pi.dwProcessId})，运行在后台桌面 '{DESKTOP_NAME}' 中")
    print("[+] 你的主屏幕没有任何弹窗，不影响正常工作！")
    
    # 等待窗口出现并自动截图
    print("[*] 等待微信窗口渲染 (3秒)...")
    time.sleep(3)
    
    wins = find_weixin_window(h_desktop)
    if wins:
        target_hwnd = wins[0][0]
        preview_file = os.path.abspath(r"d:\dsh\agy\chat\public\wechat_preview.png")
        capture_window_to_file(target_hwnd, preview_file)
        print(f"[+] 已截取微信后台画面至: {preview_file}")
    else:
        print("[-] 尚未检测到微信窗口，可在稍后执行 preview 截取。")
        
    return pi.dwProcessId

def cmd_switch():
    h_desktop = get_or_create_desktop()
    h_orig = user32.GetThreadDesktop(kernel32.GetCurrentThreadId())
    print("[*] 正在切换到微信机器人桌面（查看画面）...")
    user32.SwitchDesktop(h_desktop)
    print("[*] 已经切入后台桌面！按回车键立即切回你的主屏幕...")
    sys.stdin.readline()
    user32.SwitchDesktop(h_orig)
    print("[+] 已成功切回默认桌面！")

def cmd_preview():
    h_desktop = get_or_create_desktop()
    wins = find_weixin_window(h_desktop)
    if not wins:
        print("[-] 未在后台桌面找到微信窗口，请先运行 launch 启动微信。")
        return
    target_hwnd = wins[0][0]
    preview_file = os.path.abspath(r"d:\dsh\agy\chat\public\wechat_preview.png")
    capture_window_to_file(target_hwnd, preview_file)
    print(f"[+] 画面已刷新至: {preview_file}")

if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "launch"
    if action == "launch":
        cmd_launch()
    elif action == "preview":
        cmd_preview()
    elif action == "switch":
        cmd_switch()
