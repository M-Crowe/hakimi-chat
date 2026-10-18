import ctypes
import os
import sys

user32 = ctypes.windll.user32
h_bot = user32.OpenDesktopW("WeChatBotDesktop", 0, False, 0x10000000)
user32.SetThreadDesktop(h_bot)

from wxauto4.uia import uiautomation as uia

hwnd = 34934520
wechat_ctrl = uia.ControlFromHandle(hwnd)
print(f"[+] 根窗口: Name='{wechat_ctrl.Name}', Class='{wechat_ctrl.ClassName}'")

# 获取直接子控件
children = wechat_ctrl.GetChildren()
print(f"[+] 子控件数量: {len(children)}")
for i, c in enumerate(children):
    print(f"  [{i}] Name='{c.Name}', ControlType='{c.ControlTypeName}', Class='{c.ClassName}', Rect={c.BoundingRectangle}")

# 递归向下找一层找输入框或聊天内容
edit_ctrls = wechat_ctrl.GetChildren()
for c in edit_ctrls:
    sub = c.GetChildren()
    for s in sub:
        if s.ControlTypeName in ['EditControl', 'ListControl', 'ButtonControl', 'TextControl'] and s.Name:
            print(f"    -> Sub: Name='{s.Name}', Type='{s.ControlTypeName}', Rect={s.BoundingRectangle}")
