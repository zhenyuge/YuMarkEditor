import AppKit
import WebKit
import UniformTypeIdentifiers

/// Handles `webkit.messageHandlers.bridge.postMessage({cmd, args})` from the page.
/// Single-argument calls pass the value itself; multi-argument calls pass an array.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var controller: MainWindowController?
    private var menuPick: String?

    typealias Reply = (Any?) -> Void

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            replyHandler(nil, "bad message"); return
        }
        var answered = false
        let reply: Reply = { value in
            guard !answered else { return }
            answered = true
            replyHandler(value ?? NSNull(), nil)
        }
        let fail: (String) -> Void = { msg in
            guard !answered else { return }
            answered = true
            replyHandler(nil, msg)
        }
        do {
            try handle(cmd, body["args"], reply: reply, fail: fail)
        } catch {
            fail(error.localizedDescription)
        }
    }

    private var window: NSWindow? { controller?.window }

    // MARK: argument helpers
    private func str(_ a: Any?) throws -> String {
        guard let s = a as? String else { throw BridgeError("参数错误") }
        return s
    }
    private func list(_ a: Any?) -> [Any] { a as? [Any] ?? [] }
    private func dict(_ a: Any?) -> [String: Any] { a as? [String: Any] ?? [:] }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func handle(_ cmd: String, _ args: Any?, reply: @escaping Reply, fail: @escaping (String) -> Void) throws {
        let fm = FileManager.default
        switch cmd {
        case "ready":
            var session: Any = NSNull()
            if let data = try? Data(contentsOf: AppPaths.session),
               let obj = try? JSONSerialization.jsonObject(with: data) { session = obj }
            var prefs: Any = [String: Any]()
            if let s = UserDefaults.standard.string(forKey: "prefs"), let d = s.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: d) { prefs = obj }
            let delegate = NSApp.delegate as? AppDelegate
            let open = delegate?.pendingOpen ?? []
            delegate?.pendingOpen = []
            reply(["session": session, "prefs": prefs, "openPaths": open,
                   "appSupport": AppPaths.support.path, "home": NSHomeDirectory(), "debugInput": InputLog.enabled])
            controller?.pageDidBecomeReady()

        case "readFile":
            let path = try str(args)
            let r = try TextFiles.read(path)
            if !path.hasPrefix(AppPaths.support.path) {
                NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: path))
            }
            reply(["text": r.text, "bom": r.bom, "mtime": r.mtime])

        case "writeFile":
            let a = list(args)
            let path = try str(a.first)
            let text = try str(a.count > 1 ? a[1] : nil)
            let bom = (a.count > 2 ? a[2] as? Bool : nil) ?? false
            let mtime = try TextFiles.write(path, text: text, bom: bom)
            if path.hasSuffix(".md") || path.hasSuffix(".markdown") {
                NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: path))
            }
            reply(["mtime": mtime])

        case "writeBinary":
            let a = list(args)
            let path = try str(a.first)
            guard let data = Data(base64Encoded: try str(a.count > 1 ? a[1] : nil)) else { throw BridgeError("数据损坏") }
            try TextFiles.writeData(data, to: path)
            reply(nil)

        case "stat":
            let paths = list(args).compactMap { $0 as? String }
            reply(paths.map { p -> [String: Any] in
                var isDir: ObjCBool = false
                let exists = fm.fileExists(atPath: p, isDirectory: &isDir)
                return ["path": p, "exists": exists, "mtime": TextFiles.mtime(p), "dir": isDir.boolValue]
            })

        case "listDir":
            let path = try str(args)
            let url = URL(fileURLWithPath: path)
            let items = try fm.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey, .isPackageKey],
                                                   options: [.skipsHiddenFiles])
            reply(items.map { u -> [String: Any] in
                let v = try? u.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
                let dir = (v?.isDirectory ?? false) && !(v?.isPackage ?? false)
                return ["name": u.lastPathComponent, "path": u.path, "dir": dir]
            })

        case "openDialog":
            let o = dict(args)
            let panel = NSOpenPanel()
            panel.canCreateDirectories = true
            if o["folder"] as? Bool == true {
                panel.canChooseDirectories = true
                panel.canChooseFiles = false
                panel.prompt = "打开"
                panel.message = "选择一个文件夹作为侧边栏的文件树"
            } else {
                panel.canChooseFiles = true
                panel.canChooseDirectories = false
                panel.allowsMultipleSelection = o["multiple"] as? Bool ?? false
                if o["images"] as? Bool == true {
                    panel.allowedContentTypes = [.image]
                } else {
                    panel.allowedContentTypes = Self.textTypes
                }
            }
            let done: (NSApplication.ModalResponse) -> Void = { resp in
                reply(resp == .OK ? panel.urls.map { $0.path } : [])
            }
            if let w = window { panel.beginSheetModal(for: w, completionHandler: done) } else { done(panel.runModal()) }

        case "saveDialog":
            let o = dict(args)
            let panel = NSSavePanel()
            panel.canCreateDirectories = true
            panel.isExtensionHidden = false
            panel.nameFieldStringValue = o["name"] as? String ?? "未命名.md"
            if let dir = o["dir"] as? String, !dir.isEmpty { panel.directoryURL = URL(fileURLWithPath: dir) }
            let ext = o["ext"] as? String ?? "md"
            if let t = UTType(filenameExtension: ext) { panel.allowedContentTypes = [t] }
            panel.allowsOtherFileTypes = ext == "md"
            let done: (NSApplication.ModalResponse) -> Void = { resp in
                reply(resp == .OK ? panel.url?.path : nil)
            }
            if let w = window { panel.beginSheetModal(for: w, completionHandler: done) } else { done(panel.runModal()) }

        case "createFile":
            let a = list(args)
            let path = try str(a.first)
            guard !fm.fileExists(atPath: path) else { throw BridgeError("已存在同名文件") }
            let text = (a.count > 1 ? a[1] as? String : nil) ?? ""
            try Data(text.utf8).write(to: URL(fileURLWithPath: path), options: .withoutOverwriting)
            reply(path)

        case "createDir":
            let path = try str(args)
            try fm.createDirectory(atPath: path, withIntermediateDirectories: false)
            reply(path)

        case "rename":
            let a = list(args)
            let path = try str(a.first)
            let name = try str(a.count > 1 ? a[1] : nil)
            guard !name.contains("/"), !name.isEmpty else { throw BridgeError("名称不合法") }
            let dest = URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(name).path
            if fm.fileExists(atPath: dest) && dest.lowercased() != path.lowercased() { throw BridgeError("已存在名为「\(name)」的项目") }
            try fm.moveItem(atPath: path, toPath: dest)
            reply(dest)

        case "duplicate":
            let path = try str(args)
            let dest = TextFiles.copyPath(path)
            try fm.copyItem(atPath: path, toPath: dest)
            reply(dest)

        case "trash":
            let path = try str(args)
            try fm.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil)
            reply(nil)

        case "moveFile":
            let a = list(args)
            let from = try str(a.first)
            let to = TextFiles.uniquePath(try str(a.count > 1 ? a[1] : nil))
            try fm.createDirectory(at: URL(fileURLWithPath: to).deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.moveItem(atPath: from, toPath: to)
            reply(to)

        case "reveal":
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: try str(args))])
            reply(nil)

        case "openExternal":
            let s = try str(args)
            if let url = URL(string: s), ["http", "https", "mailto", "file", "tel"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            } else if s.hasPrefix("file://") {
                NSWorkspace.shared.open(URL(fileURLWithPath: String(s.dropFirst(7))))
            }
            reply(nil)

        case "saveImage":
            let o = dict(args)
            let dir = try str(o["dir"])
            guard let data = Data(base64Encoded: try str(o["base64"])) else { throw BridgeError("图片数据损坏") }
            let path = try ImageSaver.save(dir: dir, data: data, mime: o["mime"] as? String ?? "", name: o["name"] as? String)
            reply(["path": path])

        case "confirmClose":
            let name = (args as? String) ?? "文稿"
            let alert = NSAlert()
            alert.messageText = "要保存对「\(name)」的更改吗？"
            alert.informativeText = "如果不保存，你的更改将会丢失。"
            alert.addButton(withTitle: "保存")
            let cancel = alert.addButton(withTitle: "取消")
            cancel.keyEquivalent = "\u{1b}"
            let discard = alert.addButton(withTitle: "不保存")
            discard.keyEquivalent = "d"
            discard.keyEquivalentModifierMask = [.command]
            let done: (NSApplication.ModalResponse) -> Void = { r in
                switch r {
                case .alertFirstButtonReturn: reply("save")
                case .alertThirdButtonReturn: reply("discard")
                default: reply("cancel")
                }
            }
            if let w = window { alert.beginSheetModal(for: w, completionHandler: done) } else { done(alert.runModal()) }

        case "alert":
            let o = dict(args)
            let alert = NSAlert()
            alert.messageText = o["message"] as? String ?? ""
            alert.informativeText = o["info"] as? String ?? ""
            alert.alertStyle = (o["style"] as? String) == "warning" ? .warning : .informational
            for b in (o["buttons"] as? [String]) ?? ["好"] { alert.addButton(withTitle: b) }
            let done: (NSApplication.ModalResponse) -> Void = { r in reply(r.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue) }
            if let w = window { alert.beginSheetModal(for: w, completionHandler: done) } else { done(alert.runModal()) }

        case "menu":
            let a = list(args)
            let items = (a.first as? [[String: Any]]) ?? []
            let x = (a.count > 1 ? (a[1] as? NSNumber)?.doubleValue : nil) ?? 0
            let y = (a.count > 2 ? (a[2] as? NSNumber)?.doubleValue : nil) ?? 0
            guard let wv = controller?.webView else { reply(nil); return }
            let menu = buildMenu(items)
            menuPick = nil
            let p = NSPoint(x: x, y: wv.isFlipped ? y : wv.bounds.height - y)
            menu.popUp(positioning: nil, at: p, in: wv)
            reply(menuPick)

        case "setWindow":
            let o = dict(args)
            if let w = window {
                w.title = o["title"] as? String ?? "YuMarkEditor"
                if let p = o["path"] as? String { w.representedURL = URL(fileURLWithPath: p) } else { w.representedURL = nil }
                w.isDocumentEdited = o["dirty"] as? Bool ?? false
            }
            controller?.showWindow()
            reply(nil)

        case "setDragRegions":
            let rects = list(args).compactMap { r -> NSRect? in
                guard let v = r as? [NSNumber], v.count == 4 else { return nil }
                return NSRect(x: v[0].doubleValue, y: v[1].doubleValue, width: v[2].doubleValue, height: v[3].doubleValue)
            }
            controller?.webView.noDragRects = rects
            reply(nil)

        case "setMenuState":
            (NSApp.delegate as? AppDelegate)?.menuState = dict(args)
            reply(nil)

        case "saveSession":
            let json = try str(args)
            try Data(json.utf8).write(to: AppPaths.session, options: .atomic)
            reply(nil)

        case "savePrefs":
            if let data = try? JSONSerialization.data(withJSONObject: args ?? [:]), let s = String(data: data, encoding: .utf8) {
                UserDefaults.standard.set(s, forKey: "prefs")
            }
            reply(nil)

        case "quitReady":
            reply(nil)
            (NSApp.delegate as? AppDelegate)?.finishQuit()

        case "exportPDF":
            let o = dict(args)
            let html = try str(o["html"])
            let path = try str(o["path"])
            _ = PDFExport(html: html, dest: URL(fileURLWithPath: path)) { err in
                if let e = err { fail(e.localizedDescription) } else { reply(path) }
            }

        case "exportImage":
            let o = dict(args)
            let html = try str(o["html"])
            let path = try str(o["path"])
            let width = (o["width"] as? NSNumber)?.doubleValue ?? 750
            _ = ImageExport(html: html, dest: URL(fileURLWithPath: path), cssWidth: CGFloat(width), pixelWidth: 1500) { result in
                switch result {
                case .success(let files): reply(files)
                case .failure(let e): fail(e.localizedDescription)
                }
            }

        case "setDefaultApp":
            let types = ["md", "markdown"].compactMap { UTType(filenameExtension: $0) }
            let group = DispatchGroup()
            var ok = true
            for t in Set(types) {
                group.enter()
                NSWorkspace.shared.setDefaultApplication(at: Bundle.main.bundleURL, toOpen: t) { err in
                    if err != nil { ok = false }
                    group.leave()
                }
            }
            group.notify(queue: .main) { reply(ok) }

        case "testHit" where TestHarness.active:
            // class name of the view that receives a click at each page point
            guard let wv = controller?.webView, let frame = wv.window?.contentView?.superview else { reply([]); return }
            let pts = list(args).compactMap { $0 as? [NSNumber] }
            let rects = wv.noDragRects.map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width))x\(Int($0.height))" }.joined(separator: " ")
            reply([rects] + pts.map { p -> String in
                let inView = NSPoint(x: p[0].doubleValue, y: wv.isFlipped ? p[1].doubleValue : wv.bounds.height - p[1].doubleValue)
                let inFrame = frame.convert(wv.convert(inView, to: nil), from: nil)
                return frame.hitTest(inFrame).map { String(describing: type(of: $0)) } ?? "nil"
            })

        case "testClick" where TestHarness.active:
            // [x, y, {count, inactive, gap}] — synthetic click routed through NSApp like a real one
            guard let wv = controller?.webView, let win = wv.window else { reply(nil); return }
            let a = list(args)
            let x = (a[0] as? NSNumber)?.doubleValue ?? 0, y = (a[1] as? NSNumber)?.doubleValue ?? 0
            let o = a.count > 2 ? dict(a[2]) : [:]
            let count = (o["count"] as? NSNumber)?.intValue ?? 1
            let inactive = o["inactive"] as? Bool ?? false
            let inView = NSPoint(x: x, y: wv.isFlipped ? y : wv.bounds.height - y)
            let loc = wv.convert(inView, to: nil)
            if inactive {
                // really put another app in front, like switching away from the editor
                NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first?.activate()
            } else { NSApp.activate(ignoringOtherApps: true); win.makeKeyAndOrderFront(nil) }
            func send(_ type: NSEvent.EventType, _ n: Int) {
                if let e = NSEvent.mouseEvent(with: type, location: loc, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: win.windowNumber, context: nil, eventNumber: Int.random(in: 1...99999), clickCount: n, pressure: 1) {
                    NSApp.sendEvent(e)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + (inactive ? 0.8 : 0.3)) {
                NSLog("[mouse] app active before click: %d", NSApp.isActive ? 1 : 0)
                send(.leftMouseDown, count)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { send(.leftMouseUp, count); reply(nil) }
            }

        case "testActivationClick" where TestHarness.active:
            // [x, y, alsoDeliver]: pretend the window was just activated by a click at x,y
            guard let c = controller else { reply(nil); return }
            let a = list(args)
            let p = NSPoint(x: (a[0] as? NSNumber)?.doubleValue ?? 0, y: (a[1] as? NSNumber)?.doubleValue ?? 0)
            let deliver = a.count > 2 && (a[2] as? Bool) == true
            var pressedTicks = 8
            c.watchActivationClick(at: p) { pressedTicks -= 1; return pressedTicks > 0 }
            if deliver {
                // the normal path: AppKit hands the mouse-down to the web view as well
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    guard let wv = c.webView as EditorWebView?, let win = wv.window else { return }
                    let loc = wv.convert(NSPoint(x: p.x, y: wv.isFlipped ? p.y : wv.bounds.height - p.y), to: nil)
                    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                        if let e = NSEvent.mouseEvent(with: type, location: loc, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                      windowNumber: win.windowNumber, context: nil, eventNumber: 7, clickCount: 1, pressure: 1) { NSApp.sendEvent(e) }
                    }
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { reply(nil) }

        case "log":
            InputLog.write("page: \(args ?? "")")
            NSLog("[page] %@", String(describing: args ?? ""))
            reply(nil)

        default:
            fail("unknown command \(cmd)")
        }
    }

    static let textTypes: [UTType] = {
        var t: [UTType] = [.plainText]
        for ext in ["md", "markdown", "mdown", "mkd", "mdx", "txt"] {
            if let u = UTType(filenameExtension: ext) { t.append(u) }
        }
        if let md = UTType("net.daringfireball.markdown") { t.append(md) }
        return t
    }()

    // MARK: context menus

    private func buildMenu(_ items: [[String: Any]]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for it in items {
            if it["separator"] as? Bool == true { menu.addItem(.separator()); continue }
            let item = NSMenuItem(title: it["title"] as? String ?? "", action: #selector(pick(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = it["id"] as? String
            item.isEnabled = it["enabled"] as? Bool ?? true
            if it["checked"] as? Bool == true { item.state = .on }
            if let sub = it["submenu"] as? [[String: Any]] { item.submenu = buildMenu(sub); item.action = nil }
            menu.addItem(item)
        }
        return menu
    }

    @objc private func pick(_ sender: NSMenuItem) {
        menuPick = sender.representedObject as? String
    }
}
