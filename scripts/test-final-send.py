import ctypes
from ctypes import wintypes
import time
import win32gui
import uiautomation as auto
import wechatauto
from wechatauto.accessibility import AccessibilityGate

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

hwnd = 590682
render_hwnd = 396592

# 1. 确保 UIA gate 热激活
AccessibilityGate._hot_activate_accessibility(hwnd)

win = auto.ControlFromHandle(hwnd)
print("[+] 微信主窗口 UIA:", win)

target = "道馆馆"
msg = "哈基米智子后台测试：微信4.1 UIA隔离桌面自动收发通道完全打通！"

# 2. 查找输入框；如果未展开，找到会话列表项并点击
def find_ctrl(ctrl, cls_name=None, name_sub=None):
    c_cls = ctrl.ClassName or ""
    c_name = ctrl.Name or ""
    if (cls_name is None or cls_name in c_cls) and (name_sub is None or name_sub in c_name):
        return ctrl
    for child in ctrl.GetChildren():
        res = find_ctrl(child, cls_name, name_sub)
        if res:
            return res
    return None

input_box = find_ctrl(win, "mmui::ChatInputField")
if not input_box:
    print(f"[*] 右侧未打开，正在左侧会话列表中定位 [{target}]...")
    cell = find_ctrl(win, "mmui::ChatSessionCell", target)
    if cell:
        print("[+] 找到会话列表项，执行点击展开:", cell.Name[:30])
        cell.Click(simulateMove=False)
        time.sleep(1)
        win = auto.ControlFromHandle(hwnd)
        input_box = find_ctrl(win, "mmui::ChatInputField")

print("[+] 输入框状态:", input_box)
if input_box:
    vp = input_box.GetValuePattern()
    vp.SetValue(msg)
    time.sleep(0.2)
    print("[+] 已写入输入框，当前文本:", repr(vp.Value))

    # 3. 投递带扫描码的回车
    WM_KEYDOWN = 0x0100
    WM_KEYUP = 0x0101
    WM_CHAR = 0x0102
    VK_RETURN = 0x0D

    for tgt in [render_hwnd, hwnd]:
        user32.PostMessageW(tgt, WM_KEYDOWN, VK_RETURN, 0x001C0001)
        time.sleep(0.04)
        user32.PostMessageW(tgt, WM_CHAR, VK_RETURN, 0x001C0001)
        time.sleep(0.04)
        user32.PostMessageW(tgt, WM_KEYUP, VK_RETURN, 0xC01C0001)

    time.sleep(0.5)
    print("[+] 发送后输入框内容:", repr(vp.Value))

    # 4. 如果仍有残留内容，点击右下角发送按钮兜底
    if vp.Value:
        print("[*] 回车未完全触发，尝试点击右下角发送按钮...")
        send_btn = find_ctrl(win, name_sub="发送")
        if send_btn:
            print("[+] 找到发送按钮:", send_btn)
            send_btn.Click(simulateMove=False)
            time.sleep(0.5)
            print("[+] 再次检查输入框:", repr(vp.Value))
