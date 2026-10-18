import ctypes
from ctypes import wintypes
import os
import sys
import time
from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32
dwmapi = ctypes.windll.dwmapi

GENERIC_ALL = 0x10000000
PW_RENDERFULLCONTENT = 0x00000002
DWMWA_EXTENDED_FRAME_BOUNDS = 9
WEIXIN_PATH = r"D:\Program Files\Tencent\Weixin\Weixin.exe"
DESKTOP_NAME = "WeChatBotDesktop"
PREVIEW_FILE = os.path.abspath(r"d:\dsh\agy\chat\public\wechat_preview.png")

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

def capture_window_to_file(hwnd, save_path):
    rect = RECT()
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

def get_desktop_windows(h_desktop):
    windows = []
    def enum_proc(hwnd, lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, 256)
        
        is_visible = user32.IsWindowVisible(hwnd)
        windows.append((hwnd, title.value.strip(), class_name.value.strip(), is_visible))
        return True

    cb = WNDENUMPROC(enum_proc)
    user32.EnumDesktopWindows(h_desktop, cb, 0)
    return windows

def main():
    h_desktop = get_or_create_desktop()
    user32.SetThreadDesktop(h_desktop)
    
    # 检查是否已有微信窗口
    wins = get_desktop_windows(h_desktop)
    wx_wins = [w for w in wins if w[1] in ["微信", "Weixin"] and w[3]]
    
    if not wx_wins:
        print("[*] 正在后台物理隔离桌面启动微信 4.0...")
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
            print(f"[-] 微信启动失败: {kernel32.GetLastError()}")
            return
        print(f"[+] 微信进程已启动，PID: {pi.dwProcessId}")
        time.sleep(3)
        wins = get_desktop_windows(h_desktop)
        wx_wins = [w for w in wins if w[1] in ["微信", "Weixin"] and w[3]]

    if not wx_wins:
        print("[-] 未能检测到微信窗口，可能仍在初始化中...")
        return

    target_hwnd = wx_wins[0][0]
    capture_window_to_file(target_hwnd, PREVIEW_FILE)
    print(f"[SUCCESS_QR_READY] 二维码已刷新，保存至: {PREVIEW_FILE}")
    sys.stdout.flush()

    # 持续守护监控登录态
    print("[*] 正在等待手机微信扫码并确认登录 (守护中)...")
    sys.stdout.flush()
    
    logged_in = False
    for check_count in range(300): # 最多等待 10 分钟
        time.sleep(2)
        wins = get_desktop_windows(h_desktop)
        # 判断窗口尺寸变化或是否有主界面出现
        rect = RECT()
        user32.GetWindowRect(target_hwnd, ctypes.byref(rect))
        w = rect.right - rect.left
        h = rect.bottom - rect.top
        
        # 登录成功后，微信 4.0 窗口通常会从小的二维码登录框 (约 380x540) 扩展为大尺寸主界面 (通常宽 > 700, 高 > 500)
        if w > 600 and h > 450:
            print(f"[SUCCESS_LOGGED_IN] 检测到微信主界面已展开 (尺寸: {w}x{h})，登录成功！")
            logged_in = True
            break
            
        # 偶尔更新一次二维码预览以防失效
        if check_count % 15 == 0 and check_count > 0:
            capture_window_to_file(target_hwnd, PREVIEW_FILE)

    if logged_in:
        print("[+] 微信 4.0 现已完全进入登录态，保持后台常驻！")
    else:
        print("[-] 等待扫码超时。")

if __name__ == "__main__":
    main()
