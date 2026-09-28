import AppKit

/// The menu bar. Every command item carries its page command in `representedObject`.
enum MainMenu {
    static func install(target: AppDelegate) {
        let main = NSMenu()

        func cmd(_ title: String, _ command: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command], tag: Int = 0) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: #selector(AppDelegate.menuCommand(_:)), keyEquivalent: key)
            item.keyEquivalentModifierMask = key.isEmpty ? [] : mods
            item.representedObject = command
            item.target = target
            item.tag = tag
            return item
        }
        func std(_ title: String, _ action: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = mods
            return item
        }
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            item.submenu = m
            return item
        }
        let sep = { NSMenuItem.separator() }

        // App
        let appName = "YuMarkEditor"
        let about = NSMenuItem(title: "关于 \(appName)", action: #selector(AppDelegate.showAbout(_:)), keyEquivalent: "")
        about.target = target
        let setDefault = NSMenuItem(title: "设为 .md 文件的默认编辑器", action: #selector(AppDelegate.setAsDefault(_:)), keyEquivalent: "")
        setDefault.target = target
        let services = NSMenuItem(title: "服务", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu(title: "服务")
        services.submenu = servicesMenu
        NSApp.servicesMenu = servicesMenu
        main.addItem(submenu(appName, [
            about, sep(), setDefault, sep(), services, sep(),
            std("隐藏 \(appName)", #selector(NSApplication.hide(_:)), "h"),
            std("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            std("全部显示", #selector(NSApplication.unhideAllApplications(_:))),
            sep(),
            std("退出 \(appName)", #selector(NSApplication.terminate(_:)), "q"),
        ]))

        // File
        let recent = NSMenuItem(title: "打开最近使用", action: nil, keyEquivalent: "")
        let recentMenu = NSMenu(title: "打开最近使用")
        recentMenu.addItem(std("清除菜单", #selector(NSDocumentController.clearRecentDocuments(_:))))
        recent.submenu = recentMenu
        main.addItem(submenu("文件", [
            cmd("新建", "new", "n"),
            cmd("打开…", "open", "o"),
            cmd("打开文件夹…", "openFolder", "o", [.command, .shift]),
            recent,
            sep(),
            cmd("关闭标签页", "close", "w"),
            cmd("重新打开关闭的标签页", "reopenClosed", "t", [.command, .shift]),
            sep(),
            cmd("保存", "save", "s"),
            cmd("另存为…", "saveAs", "s", [.command, .shift]),
            cmd("自动保存", "toggleAutosave"),
            sep(),
            cmd("导出 PDF…", "print", "p"),
            submenu("导出", [
                cmd("PDF…", "exportPDF"),
                cmd("HTML（单文件）…", "exportHTML"),
                cmd("Word…", "exportWord"),
                cmd("长图…", "exportImage"),
            ]),
            sep(),
            cmd("在访达中显示", "reveal", "r", [.command, .shift]),
        ]))

        // Edit
        let emoji = std("表情与符号", #selector(NSApplication.orderFrontCharacterPalette(_:)), " ", [.command, .control])
        main.addItem(submenu("编辑", [
            cmd("撤销", "undo", "z"),
            cmd("重做", "redo", "z", [.command, .shift]),
            sep(),
            std("剪切", #selector(NSText.cut(_:)), "x"),
            std("拷贝", #selector(NSText.copy(_:)), "c"),
            std("粘贴", #selector(NSText.paste(_:)), "v"),
            std("粘贴为纯文本", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            std("全选", #selector(NSText.selectAll(_:)), "a"),
            sep(),
            submenu("查找", [
                cmd("查找…", "find", "f"),
                cmd("查找并替换…", "findReplace", "f", [.command, .option]),
                cmd("查找下一个", "findNext", "g"),
                cmd("查找上一个", "findPrev", "g", [.command, .shift]),
            ]),
            sep(),
            cmd("上移当前块", "moveUp", String(Character(UnicodeScalar(NSUpArrowFunctionKey)!)), [.option]),
            cmd("下移当前块", "moveDown", String(Character(UnicodeScalar(NSDownArrowFunctionKey)!)), [.option]),
            sep(),
            emoji,
        ]))

        // Format
        var headings: [NSMenuItem] = [cmd("正文", "heading", "0", [.command, .option], tag: 0)]
        headings[0].tag = 0
        for i in 1...6 { headings.append(cmd("标题 \(i)", "heading", "\(i)", [.command, .option], tag: i)) }
        main.addItem(submenu("格式", [
            cmd("加粗", "bold", "b"),
            cmd("斜体", "italic", "i"),
            cmd("删除线", "strike", "x", [.command, .shift]),
            cmd("行内代码", "code", "`", [.control]),
            cmd("行内公式", "mathinline", "m", [.control]),
            cmd("链接…", "link", "k"),
            sep(),
        ] + headings + [
            sep(),
            cmd("引用", "quote", "q", [.command, .option]),
            cmd("无序列表", "ul", "u", [.command, .option]),
            cmd("有序列表", "ol", "o", [.command, .option]),
            cmd("任务列表", "task", "x", [.command, .option]),
            sep(),
            cmd("代码块", "codeblock", "c", [.command, .option]),
            cmd("公式块", "mathblock", "m", [.command, .option]),
            cmd("表格", "table", "t", [.command, .option]),
            cmd("分割线", "hr", "-", [.command, .option]),
            cmd("提示块", "callout"),
            cmd("Mermaid 图表", "mermaid"),
            cmd("目录", "toc"),
            cmd("脚注", "footnote"),
            cmd("属性", "frontmatter"),
        ]))

        // View
        main.addItem(submenu("显示", [
            cmd("源码模式", "toggleMode", "e"),
            cmd("侧边栏", "toggleSidebar", "\\"),
            sep(),
            cmd("放大", "zoomIn", "="),
            cmd("缩小", "zoomOut", "-"),
            cmd("实际大小", "zoomReset", "0"),
            sep(),
            std("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ]))

        // Window
        let windowMenu = submenu("窗口", [
            std("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"),
            std("缩放", #selector(NSWindow.performZoom(_:))),
            sep(),
            cmd("下一个标签页", "nextTab", "]", [.command, .shift]),
            cmd("上一个标签页", "prevTab", "[", [.command, .shift]),
            sep(),
            std("前置全部窗口", #selector(NSApplication.arrangeInFront(_:))),
        ])
        main.addItem(windowMenu)
        NSApp.windowsMenu = windowMenu.submenu

        let help = submenu("帮助", [])
        main.addItem(help)
        NSApp.helpMenu = help.submenu

        NSApp.mainMenu = main
    }
}
