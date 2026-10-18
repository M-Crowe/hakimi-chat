import ctypes
from ctypes import wintypes
import time
import tkinter as tk
from tkinter import font

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
GENERIC_ALL = 0x10000000

# 保证当前线程桌面为微信桌面
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, GENERIC_ALL)
if h_bot:
    user32.SetThreadDesktop(h_bot)

h_default = user32.OpenDesktopW("Default", 0, False, GENERIC_ALL)

# 寻找微信窗口并置顶激活
def bring_weixin_to_front():
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        t = title.value.strip()
        if t in ["微信", "Weixin"]:
            # 还原并置顶
            user32.ShowWindow(hwnd, 9) # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            return False
        return True
    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)

bring_weixin_to_front()

# 创建悬浮窗
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

def do_switch_back():
    if h_default:
        user32.SwitchDesktop(h_default)
    root.destroy()

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

# 监听 ESC 键
root.bind("<Escape>", lambda e: do_switch_back())

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
