import ctypes
from ctypes import wintypes
import os
import sys
import time
from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
kernel32 = ctypes.windll.kernel32

GENERIC_ALL = 0x10000000
PW_RENDERFULLCONTENT = 0x00000002

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

def capture_window(hwnd, save_path):
    rect = RECT()
    dwmapi = ctypes.windll.dwmapi
    dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect))
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    
    if width <= 0 or height <= 0:
        width = 295
        height = 387

    print(f"[*] 捕捉窗口 HWND: {hwnd}, 尺寸: {width}x{height}")
    
    hwnd_dc = user32.GetWindowDC(hwnd)
    mem_dc = gdi32.CreateCompatibleDC(hwnd_dc)
    bitmap = gdi32.CreateCompatibleBitmap(hwnd_dc, width, height)
    gdi32.SelectObject(mem_dc, bitmap)

    # 尝试 PrintWindow
    res = user32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT)
    if not res:
        res = user32.PrintWindow(hwnd, mem_dc, 0)
    
    # 获取位图数据
    bmpinfo = BITMAPINFOHEADER()
    bmpinfo.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmpinfo.biWidth = width
    bmpinfo.biHeight = -height  # top-down
    bmpinfo.biPlanes = 1
    bmpinfo.biBitCount = 32
    bmpinfo.biCompression = 0 # BI_RGB

    buffer_size = width * height * 4
    buffer = ctypes.create_string_buffer(buffer_size)

    gdi32.GetDIBits(mem_dc, bitmap, 0, height, buffer, ctypes.byref(bmpinfo), 0)

    # 清理 GDI 资源
    gdi32.DeleteObject(bitmap)
    gdi32.DeleteDC(mem_dc)
    user32.ReleaseDC(hwnd, hwnd_dc)

    # 用 PIL 生成图片并保存
    img = Image.frombuffer('RGBA', (width, height), buffer, 'raw', 'BGRA', 0, 1)
    # 转 RGB 保证兼容
    rgb_img = Image.new("RGB", img.size, (255, 255, 255))
    rgb_img.paste(img, mask=img.split()[3]) # alpha 通道 mask
    
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    rgb_img.save(save_path)
    print(f"[+] 截图已保存至: {save_path}")
    return True

def main():
    desktop_name = "WeChatBotDesktop"
    h_desktop = user32.OpenDesktopW(desktop_name, 0, False, GENERIC_ALL)
    if not h_desktop:
        print(f"[-] 打开桌面失败: {kernel32.GetLastError()}")
        return

    user32.SetThreadDesktop(h_desktop)

    target_hwnd = None
    target_title = None

    def enum_proc(hwnd, lparam):
        nonlocal target_hwnd, target_title
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        
        is_visible = user32.IsWindowVisible(hwnd)
        # 优先选择不是弹窗的主窗口（尺寸较大或者title是微信）
        t = title.value.strip()
        if t == "微信":
            target_hwnd = hwnd
            target_title = t
            return False
        return True

    cb = WNDENUMPROC(enum_proc)
    user32.EnumDesktopWindows(h_desktop, cb, 0)

    if not target_hwnd:
        print("[-] 未在隐藏桌面上找到 '微信' 窗口")
        return

    out_path = os.path.abspath(r"d:\dsh\agy\chat\public\wechat_preview.png")
    capture_window(target_hwnd, out_path)

if __name__ == "__main__":
    main()
