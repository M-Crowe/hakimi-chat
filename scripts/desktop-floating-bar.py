import ctypes
from ctypes import wintypes
import os
import sys
import tempfile
import time

# 启用 DPI 感知，避免高分屏坐标错位
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

DESKTOP_SWITCHDESKTOP = 0x0100
DESKTOP_READOBJECTS = 0x0001
DESKTOP_WRITEOBJECTS = 0x0080
GENERIC_ALL = 0x10000000

SIGNAL_FILE = os.path.join(tempfile.gettempdir(), "hakimi_desktop_switch_back.sig")

def open_default_desktop():
    for mask in [0x0100 | 0x0001 | 0x0080, 0x0100, GENERIC_ALL, 0x02000000]:
        h = user32.OpenDesktopW("Default", 0, False, mask)
        if h:
            return h
    return 0

# 保证当前线程桌面为微信桌面
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, GENERIC_ALL)
if not h_bot:
    h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x0100 | 0x0001 | 0x0080)
if h_bot:
    user32.SetThreadDesktop(h_bot)

h_default = open_default_desktop()

def bring_weixin_to_front():
    if not h_bot:
        return
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        t = title.value.strip()
        if t in ["微信", "Weixin"]:
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            return False
        return True
    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)

bring_weixin_to_front()

def send_switch_signal():
    try:
        with open(SIGNAL_FILE, "w", encoding="utf-8") as f:
            f.write(f"switch_back_{time.time()}")
    except Exception:
        pass

def do_switch_back():
    send_switch_signal()
    # 双重确保切回主桌面
    for handle in [h_default, open_default_desktop()]:
        if handle:
            try:
                user32.SwitchDesktop(handle)
            except Exception:
                pass
    try:
        if root:
            root.destroy()
    except Exception:
        pass
    sys.exit(0)

# 尝试创建图形悬浮导航条
root = None
try:
    import tkinter as tk
    from tkinter import font

    root = tk.Tk()
    root.title("桌面穿梭导航条")
    root.attributes("-topmost", True)
    root.attributes("-toolwindow", True)
    root.resizable(False, False)

    # 用系统物理分辨率计算，彻底规避缩放错位导致窗口飘出屏幕
    screen_w = user32.GetSystemMetrics(0)
    if screen_w <= 0:
        screen_w = root.winfo_screenwidth()
    bar_w = 440
    bar_h = 74
    pos_x = max(10, (screen_w - bar_w) // 2)
    pos_y = 15
    root.geometry(f"{bar_w}x{bar_h}+{pos_x}+{pos_y}")
    root.configure(bg="#1E1E1E")

    remaining = 60

    btn_font = font.Font(family="Microsoft YaHei", size=12, weight="bold")
    btn = tk.Button(
        root,
        text=f"🏠 点击立即返回主电脑屏幕 ({remaining}s)",
        font=btn_font,
        bg="#10B981",
        fg="white",
        activebackground="#059669",
        activeforeground="white",
        relief="flat",
        cursor="hand2",
        command=do_switch_back
    )
    btn.pack(fill="both", expand=True, padx=8, pady=8)

    # 绑定所有可能的退出交互：点右上角 X、按 ESC、按回车、按空格
    root.protocol("WM_DELETE_WINDOW", do_switch_back)
    root.bind("<Escape>", lambda e: do_switch_back())
    root.bind("<Return>", lambda e: do_switch_back())
    root.bind("<space>", lambda e: do_switch_back())

    def update_timer():
        global remaining
        remaining -= 1
        if remaining <= 0:
            do_switch_back()
            return
        btn.config(text=f"🏠 点击立即返回主电脑屏幕 ({remaining}s)")
        root.after(1000, update_timer)

    # 循环强化置顶，防止微信窗口弹起时遮挡导航条
    def keep_on_top():
        try:
            root.lift()
            root.attributes("-topmost", True)
            root.after(1000, keep_on_top)
        except Exception:
            pass

    root.after(1000, update_timer)
    root.after(500, keep_on_top)
    root.mainloop()

except Exception as err:
    # 核心降级：若系统缺失 Tkinter 或图形库初始化失败，直接调起 Windows 原生系统级 MessageBox！
    # MB_OK | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND = 0x00000040 | 0x00040000 | 0x00010000
    MB_FLAGS = 0x00000040 | 0x00040000 | 0x00010000
    user32.MessageBoxW(
        0,
        "【哈基米微信伴聊 - 隔离桌面穿梭助手】\n\n"
        "您已成功进入后台隔离桌面！请在此窗口扫码登录微信。\n\n"
        "👉 扫码完成后，请点击下方的【确定】按钮或按【回车键/ESC】，\n"
        "即可立即安全切回您的日常电脑主屏幕。",
        "桌面穿梭返回助手 (原生安全模式)",
        MB_FLAGS
    )
    do_switch_back()
