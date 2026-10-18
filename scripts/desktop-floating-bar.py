import ctypes
from ctypes import wintypes
import os
import sys
import tempfile
import time

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

    # 屏幕顶部居中
    screen_w = root.winfo_screenwidth()
    bar_w = 420
    bar_h = 70
    pos_x = (screen_w - bar_w) // 2
    pos_y = 20
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

    root.after(1000, update_timer)
    root.mainloop()

except Exception as err:
    # 如果系统没有 tkinter 或图形初始化异常，使用轻量循环进行 60s 应急兜底
    print(f"[!] 图形导航条加载提示: {err}，启动轻量倒计时守护...")
    for _ in range(60):
        time.sleep(1)
        if os.path.exists(SIGNAL_FILE):
            break
    do_switch_back()
