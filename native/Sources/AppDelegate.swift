import AppKit
import UniformTypeIdentifiers

/// Routes "Open Recent" (and other document-controller opens) to our own tab model.
final class RecentDocumentController: NSDocumentController {
    override func openDocument(withContentsOf url: URL, display displayDocument: Bool,
                               completionHandler: @escaping (NSDocument?, Bool, Error?) -> Void) {
        (NSApp.delegate as? AppDelegate)?.open(urls: [url])
        completionHandler(nil, false, nil)
    }
    override func noteNewRecentDocumentURL(_ url: URL) {
        guard url.isFileURL, !url.path.hasPrefix(AppPaths.support.path) else { return }
        super.noteNewRecentDocumentURL(url)
    }
}

enum AppPaths {
    static let support: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        var dir = base.appendingPathComponent("YuMarkEditor", isDirectory: true)
        if let custom = ProcessInfo.processInfo.environment["YUMARK_SUPPORT"] {
            dir = URL(fileURLWithPath: custom, isDirectory: true)
        } else {
            migrateFromJotdown(base: base, to: dir)
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()
    static var session: URL { support.appendingPathComponent("session.json") }

    /// The app used to be called Jotdown: carry its session (unsaved documents,
    /// pasted images) and preferences over on first launch.
    private static func migrateFromJotdown(base: URL, to dir: URL) {
        let fm = FileManager.default
        let old = base.appendingPathComponent("Jotdown", isDirectory: true)
        guard fm.fileExists(atPath: old.path), !fm.fileExists(atPath: dir.path) else { return }
        guard (try? fm.moveItem(at: old, to: dir)) != nil else { return }
        let session = dir.appendingPathComponent("session.json")
        if let text = try? String(contentsOf: session, encoding: .utf8) {
            try? text.replacingOccurrences(of: old.path, with: dir.path).write(to: session, atomically: true, encoding: .utf8)
        }
        if UserDefaults.standard.string(forKey: "prefs") == nil,
           let prefs = UserDefaults(suiteName: "app.jotdown.editor")?.string(forKey: "prefs") {
            UserDefaults.standard.set(prefs, forKey: "prefs")
        }
    }
    static var webRoot: URL { Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true) }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    var controller: MainWindowController!
    /// files handed to us before the page was ready
    var pendingOpen: [[String: Any]] = []
    var quitRequested = false
    var menuState: [String: Any] = [:]

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
        MainMenu.install(target: self)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = MainWindowController()
        controller.load()
        // `YuMarkEditor file.md folder/` from a shell
        var args = Array(CommandLine.arguments.dropFirst())
        var files: [URL] = []
        while !args.isEmpty {
            let a = args.removeFirst()
            if a.hasPrefix("-") {
                // AppKit style "-Key value" defaults arguments
                if (a.hasPrefix("-NS") || a.hasPrefix("-Apple")), let next = args.first, !next.hasPrefix("-") { args.removeFirst() }
                continue
            }
            let url = URL(fileURLWithPath: a, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)).standardizedFileURL
            if FileManager.default.fileExists(atPath: url.path) { files.append(url) }
        }
        if !files.isEmpty { open(urls: files) }
    }

    // MARK: opening files

    func application(_ application: NSApplication, open urls: [URL]) {
        open(urls: urls)
    }

    func open(urls: [URL]) {
        let items: [[String: Any]] = urls.filter { $0.isFileURL }.map { url in
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
            if !isDir.boolValue { NSDocumentController.shared.noteNewRecentDocumentURL(url) }
            return ["path": url.path, "dir": isDir.boolValue]
        }
        guard !items.isEmpty else { return }
        if let c = controller, c.pageReady {
            c.dispatch("openPaths", items)
            c.window?.makeKeyAndOrderFront(nil)
        } else {
            pendingOpen.append(contentsOf: items)
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        controller?.window?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationDidBecomeActive(_ notification: Notification) {
        controller?.dispatch("focus")
    }

    // MARK: quitting — the page stores unsaved work first (no "save changes?" prompt on quit)

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let c = controller, c.pageReady, !quitRequested else { return .terminateNow }
        quitRequested = true
        c.dispatch("prepareQuit")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.finishQuit()
        }
        return .terminateLater
    }

    private var replied = false
    func finishQuit() {
        guard quitRequested, !replied else { return }
        replied = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    // MARK: menu actions

    @objc func menuCommand(_ sender: NSMenuItem) {
        guard let cmd = sender.representedObject as? String else { return }
        var arg: Any? = nil
        if sender.tag != 0 { arg = sender.tag }
        controller?.dispatch(cmd, arg)
    }

    @objc func showAbout(_ sender: Any?) {
        NSApp.orderFrontStandardAboutPanel(options: [
            .credits: NSAttributedString(string: "一个纯粹的 Markdown 编辑器。\n没有笔记库，没有 AI，没有后台进程。",
                                         attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]),
        ])
    }

    @objc func setAsDefault(_ sender: Any?) {
        controller?.dispatch("setDefaultApp")
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        guard let cmd = item.representedObject as? String else { return true }
        switch cmd {
        case "toggleMode": item.state = (menuState["mode"] as? String) == "source" ? .on : .off
        case "toggleAutosave": item.state = (menuState["autosave"] as? Bool) == true ? .on : .off
        case "toggleSidebar": item.state = (menuState["sidebar"] as? Bool) == true ? .on : .off
        case "reveal": return (menuState["hasPath"] as? Bool) == true
        default: break
        }
        return controller?.pageReady ?? false
    }
}
