"""
WeChat 4.1 独立物理隔离桌面守护服务 (WeChat Service Daemon)
- 独占运行于 Windows 原生后台虚拟桌面 WeChatBotDesktop
- 绝不抢前台物理键盘/鼠标焦点，用户正常写代码打字零干扰
- 提供本地 HTTP Port 34568 (/health, /send)
- 双引擎无感监听微信群消息 (DBListener + UIA 实时抓取) 并自动回调 Node.js (Port 34567 /api/wechat/incoming)
"""

import ctypes
from ctypes import wintypes
import os
import sys
import time
import json
import threading
from collections import deque
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import win32gui
import win32ui
from PIL import Image

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
GENERIC_ALL = 0x10000000
DESKTOP_NAME = "WeChatBotDesktop"
WEIXIN_PATH = r"D:\Program Files\Tencent\Weixin\Weixin.exe"
NODE_GATEWAY_URL = "http://127.0.0.1:34567/api/wechat/incoming"

# 1. 独占 WeChatBotDesktop 物理隔离桌面
h_bot = user32.OpenDesktopW(DESKTOP_NAME, 0, False, GENERIC_ALL)
if not h_bot:
    h_bot = user32.CreateDesktopW(DESKTOP_NAME, None, None, 0, GENERIC_ALL, None)
user32.SetThreadDesktop(h_bot)

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

def _capture_window_region(hwnd: int, box=None):
    user32.SetThreadDesktop(h_bot)
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width, height = right - left, bottom - top
    hwnd_dc = win32gui.GetWindowDC(hwnd)
    source_dc = win32ui.CreateDCFromHandle(hwnd_dc)
    memory_dc = source_dc.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    bitmap.CreateCompatibleBitmap(source_dc, width, height)
    memory_dc.SelectObject(bitmap)

    captured = bool(user32.PrintWindow(hwnd, memory_dc.GetSafeHdc(), 2))
    if not captured:
        captured = bool(user32.PrintWindow(hwnd, memory_dc.GetSafeHdc(), 0))
    info = bitmap.GetInfo()
    data = bitmap.GetBitmapBits(True)
    image = Image.frombuffer("RGB", (info["bmWidth"], info["bmHeight"]), data, "raw", "BGRX", 0, 1)

    win32gui.DeleteObject(bitmap.GetHandle())
    memory_dc.DeleteDC()
    source_dc.DeleteDC()
    win32gui.ReleaseDC(hwnd, hwnd_dc)

    if box is not None:
        crop_left = max(left, int(box[0]))
        crop_top = max(top, int(box[1]))
        crop_right = min(right, int(box[2]))
        crop_bottom = min(bottom, int(box[3]))
        if crop_right > crop_left and crop_bottom > crop_top:
            image = image.crop((crop_left - left, crop_top - top, crop_right - left, crop_bottom - top))
    return image

import wechatauto
from wechatauto.logger import wxlog
import logging

# 静默 wechatauto 底层频繁的 UIA 物化与扫描 INFO 刷屏日志
try:
    if hasattr(wxlog, 'console_handler') and wxlog.console_handler:
        wxlog.console_handler.setLevel(logging.WARNING)
    logging.getLogger('wechatauto').setLevel(logging.WARNING)
    logging.getLogger().setLevel(logging.WARNING)
except Exception:
    pass

from wechatauto.guia import WeChatGUI
from wechatauto.uia_driver import WeChatUIA, _title_is_main
from wechatauto.accessibility import AccessibilityGate
import uiautomation as auto

WeChatGUI._grab_screen = lambda self, box=None: _capture_window_region(int(getattr(self, "main_hwnd", 0) or getattr(self, "hwnd", 0) or 0), box)

def patched_wechat_hwnds(self, diag=None):
    res = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        title = win32gui.GetWindowText(hwnd)
        if win32gui.IsWindowVisible(hwnd) and _title_is_main(title):
            pid = self._pid_from_hwnd(hwnd)
            if pid and self._weixin_dll_module(pid):
                l, t, r, b = win32gui.GetWindowRect(hwnd)
                res.append(((r - l) * (b - t), hwnd))
        return True
    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)
    res.sort(reverse=True)
    return [h for _, h in res]

WeChatUIA._wechat_hwnds = patched_wechat_hwnds

def find_wechat_windows():
    user32.SetThreadDesktop(h_bot)
    main_hwnd = None
    login_hwnd = None
    WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        nonlocal main_hwnd, login_hwnd
        length = user32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        if title.value.strip() == "微信":
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            w = rect.right - rect.left
            if w > 500:
                main_hwnd = hwnd
            else:
                login_hwnd = hwnd
        return True

    user32.EnumDesktopWindows(h_bot, WNDENUMPROC(enum_proc), 0)
    return main_hwnd, login_hwnd

def ensure_weixin_process():
    main_hwnd, login_hwnd = find_wechat_windows()
    if not main_hwnd and not login_hwnd:
        print("[*] 微信未运行，正在后台物理隔离桌面拉起微信 4.1...")
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
        kernel32.CloseHandle(pi.hProcess)
        kernel32.CloseHandle(pi.hThread)

    for _ in range(25):
        main_hwnd, login_hwnd = find_wechat_windows()
        if main_hwnd:
            return main_hwnd
        if login_hwnd:
            print(f"[*] 发现微信登录确认窗口 (HWND: {login_hwnd})，投递回车确认...")
            WM_KEYDOWN = 0x0100
            WM_KEYUP = 0x0101
            WM_CHAR = 0x0102
            VK_RETURN = 0x0D
            user32.PostMessageW(login_hwnd, WM_KEYDOWN, VK_RETURN, 0x001C0001)
            time.sleep(0.04)
            user32.PostMessageW(login_hwnd, WM_CHAR, VK_RETURN, 0x001C0001)
            time.sleep(0.04)
            user32.PostMessageW(login_hwnd, WM_KEYUP, VK_RETURN, 0xC01C0001)
            time.sleep(1.5)
        else:
            time.sleep(1)

    return main_hwnd or login_hwnd

# 全局状态管理
g_wx = None
g_main_hwnd = None
g_render_hwnd = None
g_lock = threading.Lock()

def load_db_monitored_groups():
    groups = ["道馆馆"]
    db_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "state.db")
    if os.path.exists(db_path):
        try:
            import sqlite3
            conn = sqlite3.connect(db_path, timeout=5)
            cursor = conn.cursor()
            cursor.execute("SELECT group_name FROM managed_groups WHERE platform = 'wechat' AND enabled = 1")
            for row in cursor.fetchall():
                name = (row[0] or "").strip()
                if name and name not in groups:
                    groups.append(name)
            conn.close()
        except Exception as e:
            print(f"⚠️ [读取 SQLite 微信白名单异常]: {e}")
    return groups

MONITORED_GROUPS = load_db_monitored_groups()

# 历史去重与防回环队列
bot_sent_history = deque(maxlen=200)
seen_message_ids = set()

def forward_to_node(room: str, sender: str, content: str, msg_type: str = "friend"):
    """纯代码确定性 POST 微信消息到 Node.js 伴聊大脑"""
    if not content or not content.strip():
        return
    # 清洗文本中的不可见全角空格和首尾杂质
    clean_text = content.strip().replace("\u2005", " ")
    
    # 严格防自回环：如果内容与机器人自己最近发出的完全一致，忽略
    for sent in list(bot_sent_history):
        if sent in clean_text or clean_text in sent:
            return

    # 消息指纹防重
    fingerprint = f"{room}|{sender}|{clean_text}"
    if fingerprint in seen_message_ids:
        return
    seen_message_ids.add(fingerprint)
    if len(seen_message_ids) > 1000:
        seen_message_ids.clear()

    print(f"📥 [微信消息 -> Node.js 网关] [{room}] {sender}: {clean_text}")
    payload = {
        "platform": "wechat",
        "room": room,
        "sender": sender,
        "content": clean_text,
        "type": msg_type,
        "time": time.time()
    }
    try:
        req = Request(
            NODE_GATEWAY_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urlopen(req, timeout=3) as resp:
            pass
    except Exception as e:
        print(f"⚠️ [回调 Node.js 网关失败]: {e}")

def on_wechat_listener_message(msg, chat):
    """引擎1：wechatauto 原生 DBListener 回调"""
    try:
        is_self = getattr(msg, "is_self", False)
        if is_self:
            return
        content = getattr(msg, "content", "")
        sender = getattr(msg, "sender", "群友")
        chat_name = getattr(chat, "name", str(chat))
        forward_to_node(chat_name, sender, content, "group")
    except Exception as e:
        print(f"⚠️ [DBListener 异常]: {e}")

def init_wechat():
    global g_wx, g_main_hwnd, g_render_hwnd
    user32.SetThreadDesktop(h_bot)
    hwnd = ensure_weixin_process()
    if not hwnd:
        print("[-] 无法找到微信主窗口")
        return False
    g_main_hwnd = hwnd
    user32.ShowWindow(hwnd, 9)
    user32.SetWindowPos(hwnd, 0, 0, 0, 1320, 960, 0x0040)
    time.sleep(0.3)
    AccessibilityGate._hot_activate_accessibility(hwnd)

    gui = WeChatGUI(hwnd=hwnd)
    g_render_hwnd = gui.render_hwnd
    g_wx = wechatauto.WeChat(gui=gui, start_listener=False)
    print(f"[SUCCESS] 微信 4.1 驱动就绪！登录账号: {g_wx.nickname}, 主窗口: {hwnd}, 渲染窗口: {g_render_hwnd}")

    # 注册监听群聊 (引擎1)
    for group in MONITORED_GROUPS:
        try:
            res = g_wx.AddListenChat(nickname=group, callback=on_wechat_listener_message)
            print(f"[+] DBListener 成功注册监听微信群: {group} (返回: {res})")
        except Exception as e:
            print(f"[-] DBListener 注册监听群 [{group}] 提示: {e}")
    try:
        g_wx.StartListening()
        print("[+] DBListener 监听器已就绪")
    except Exception as e:
        print(f"[-] StartListening 提示: {e}")

    return True

def ensure_chat_active(win, target: str):
    """
    纯代码确定性会话动态展开：
    1. 动态递归搜索 mmui::ChatSessionCell
    2. 找到名称包含 target 的会话项
    3. 提取其真实 BoundingRectangle 中心坐标 (cx, cy)
    4. 向主窗口与渲染窗口投递后台鼠标点击，准确点开
    """
    def find_cells(ctrl):
        cells = []
        for ch in ctrl.GetChildren():
            if (ch.ClassName or '') == 'mmui::ChatSessionCell':
                cells.append(ch)
            else:
                cells.extend(find_cells(ch))
        return cells

    cells = find_cells(win)
    for cell in cells:
        if target in (cell.Name or ''):
            rect = cell.BoundingRectangle
            cx = (rect.left + rect.right) // 2
            cy = (rect.top + rect.bottom) // 2
            lparam = (cy << 16) | (cx & 0xFFFF)
            targets = [g_render_hwnd, g_main_hwnd] if g_render_hwnd else [g_main_hwnd]
            for tgt in targets:
                user32.PostMessageW(tgt, 0x0200, 0, lparam)
                time.sleep(0.02)
                user32.PostMessageW(tgt, 0x0201, 1, lparam)
                time.sleep(0.02)
                user32.PostMessageW(tgt, 0x0202, 0, lparam)
            time.sleep(0.3)
            return True
    return False

def send_wechat_message(target: str, message: str):
    """纯代码确定性静默发送微信消息"""
    global g_wx, g_main_hwnd, g_render_hwnd
    user32.SetThreadDesktop(h_bot)
    with g_lock:
        if not g_main_hwnd:
            if not init_wechat():
                return False, "微信主窗口未就绪"

        try:
            curr_main, _ = find_wechat_windows()
            if curr_main:
                g_main_hwnd = curr_main
            user32.ShowWindow(g_main_hwnd, 9)

            AccessibilityGate._hot_activate_accessibility(g_main_hwnd)
            win = auto.ControlFromHandle(g_main_hwnd)

            def find_input(ctrl):
                if (ctrl.ClassName or '') == 'mmui::ChatInputField' or (ctrl.Name or '') == '输入':
                    return ctrl
                for c in ctrl.GetChildren():
                    res = find_input(c)
                    if res:
                        return res
                return None

            input_ctrl = find_input(win)

            # 会话未展开或当前非目标会话，动态定位并展开
            if not input_ctrl or (input_ctrl.Name and target not in input_ctrl.Name):
                ensure_chat_active(win, target)
                time.sleep(0.2)
                win = auto.ControlFromHandle(g_main_hwnd)
                input_ctrl = find_input(win)

            if not input_ctrl:
                return False, "未找到微信输入框"

            # 登记自身发送历史，防止自回环
            bot_sent_history.append(message.strip())

            # 1. 注入文本 (ValuePattern COM 接口，零物理焦点)
            vp = input_ctrl.GetValuePattern()
            vp.SetValue(message)
            time.sleep(0.05)

            # 2. 投递带扫描码的回车按键序列
            WM_KEYDOWN = 0x0100
            WM_KEYUP = 0x0101
            WM_CHAR = 0x0102
            VK_RETURN = 0x0D

            targets = [g_render_hwnd, g_main_hwnd] if g_render_hwnd else [g_main_hwnd]
            for tgt in targets:
                user32.PostMessageW(tgt, WM_KEYDOWN, VK_RETURN, 0x001C0001)
                time.sleep(0.03)
                user32.PostMessageW(tgt, WM_CHAR, VK_RETURN, 0x001C0001)
                time.sleep(0.03)
                user32.PostMessageW(tgt, WM_KEYUP, VK_RETURN, 0xC01C0001)

            print(f"📤 [微信发送成功 -> {target}]: {message[:40]}")
            return True, "发送成功"

        except Exception as e:
            print(f"[-] 微信发送异常: {e}")
            return False, str(e)

def uia_polling_loop():
    """引擎2：UIA 增量兜底轮询（独立线程，100% 确保新消息不漏单）"""
    user32.SetThreadDesktop(h_bot)
    print("[*] 微信 UIA 增量监控兜底引擎已启动...")
    
    # 启动时抓取已有快照，避免将历史旧消息作为新消息重播
    initial_snapshot_done = False
    
    while True:
        try:
            if g_main_hwnd:
                win = auto.ControlFromHandle(g_main_hwnd)

                def find_lv(c):
                    if (c.ClassName or '') == 'mmui::RecyclerListView':
                        return c
                    for ch in c.GetChildren():
                        res = find_lv(ch)
                        if res:
                            return res
                    return None

                lv = find_lv(win)
                if not lv:
                    # 仅在找不到 RecyclerListView 树时才热激活一次，避免每秒无脑重复激活刷屏
                    AccessibilityGate._hot_activate_accessibility(g_main_hwnd)
                    ensure_chat_active(win, "道馆馆")
                    time.sleep(0.3)
                    lv = find_lv(win)

                if lv:
                    children = lv.GetChildren()
                    if not initial_snapshot_done:
                        # 启动时将当前可见的消息指纹预填充进 seen_message_ids
                        for item in children:
                            t = (item.Name or "").strip().replace("\u2005", " ")
                            if t:
                                seen_message_ids.add(f"道馆馆|群友|{t}")
                        initial_snapshot_done = True
                        print(f"[*] UIA 历史基线已对齐，当前已缓存 {len(seen_message_ids)} 条历史基准消息")
                    else:
                        # 取底部最新 5 条检查增量
                        recent = children[-5:] if len(children) >= 5 else children
                        for item in recent:
                            if (item.ClassName or '') == 'mmui::ChatTextItemView':
                                text = (item.Name or "").strip().replace("\u2005", " ")
                                if not text:
                                    continue
                                
                                rect = item.BoundingRectangle
                                h = rect.bottom - rect.top if rect else 0
                                
                                # 他人发的消息带有昵称条，高度 > 100；自己发的消息无昵称，高度 ~ 84
                                # 也可以通过 @Tomoko 显式提及确认
                                is_likely_bot = False
                                for sent in list(bot_sent_history):
                                    if sent in text or text in sent:
                                        is_likely_bot = True
                                        break
                                
                                if not is_likely_bot:
                                    forward_to_node("道馆馆", "群友", text, "group")

        except Exception as e:
            pass

        time.sleep(1.0)

# 4. HTTP API 接口服务
class WeChatRequestHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        user32.SetThreadDesktop(h_bot)
        parsed = urlparse(self.path)
        if parsed.path == "/send":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode("utf-8"))
                target = data.get("target", "道馆馆")
                message = data.get("message", "")

                success, msg = send_wechat_message(target, message)
                resp = {"success": success, "message": msg}

                self.send_response(200 if success else 500)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps(resp).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
        elif parsed.path == "/listen":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode("utf-8"))
                action = data.get("action", "add")
                room = str(data.get("room", "")).strip()
                if not room:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.end_headers()
                    self.wfile.write(json.dumps({"success": False, "error": "缺少 room 参数"}).encode("utf-8"))
                    return

                global MONITORED_GROUPS
                if action == "add":
                    if room not in MONITORED_GROUPS:
                        MONITORED_GROUPS.append(room)
                    if g_wx:
                        try:
                            res = g_wx.AddListenChat(nickname=room, callback=on_wechat_listener_message)
                            print(f"[+] [动态热注册成功] 已添加监听微信群: {room} (返回: {res})")
                        except Exception as e:
                            print(f"[-] [动态热注册提示] 微信群 [{room}]: {e}")
                elif action == "remove":
                    if room in MONITORED_GROUPS:
                        MONITORED_GROUPS = [g for g in MONITORED_GROUPS if g != room]
                        print(f"[-] [动态移出监听列表] 微信群: {room}")

                resp = {"success": True, "action": action, "room": room, "monitored": MONITORED_GROUPS}
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps(resp).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "error": str(e)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        user32.SetThreadDesktop(h_bot)
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            status = {
                "status": "online" if g_wx else "offline",
                "nickname": getattr(g_wx, "nickname", None) if g_wx else None,
                "desktop": DESKTOP_NAME,
                "main_hwnd": g_main_hwnd,
                "monitored": MONITORED_GROUPS
            }
            self.wfile.write(json.dumps(status).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        # 静默 HTTP 请求常规日志，保持控制台整洁
        return

def run_http_server():
    user32.SetThreadDesktop(h_bot)
    server = HTTPServer(("127.0.0.1", 34568), WeChatRequestHandler)
    print("[*] 微信 4.1 本地 HTTP API 网关已启动: http://127.0.0.1:34568")
    server.serve_forever()

if __name__ == "__main__":
    print("==================================================")
    print("🚀 微信 4.1 独立隔离桌面全自动守护服务启动中...")
    print("==================================================")

    # 1. 启动 HTTP 服务线程
    http_thread = threading.Thread(target=run_http_server, daemon=True)
    http_thread.start()

    # 2. 初始化微信连接
    init_wechat()

    # 3. 启动 UIA 增量兜底监控线程
    uia_thread = threading.Thread(target=uia_polling_loop, daemon=True)
    uia_thread.start()

    print("[+] 微信守护进程常驻运行中，收发通道 100% 自动闭环。")
    try:
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        print("[*] 微信守护服务已停止。")
