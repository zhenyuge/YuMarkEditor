import AppKit
import WebKit

/// Web view that turns clicks on empty parts of the HTML title bar into window drags.
final class EditorWebView: WKWebView {
    /// interactive rects of the title bar (buttons, tabs), in page coordinates
    var noDragRects: [NSRect] = []
    var titlebarHeight: CGFloat = 38

    /// mouse-downs that reached this view (tells whether an activating click got through)
    private(set) var mouseDownCount = 0

    private func pagePoint(_ event: NSEvent) -> NSPoint {
        pagePoint(window: event.locationInWindow)
    }

    func pagePoint(window point: NSPoint) -> NSPoint {
        let p = convert(point, from: nil)
        return NSPoint(x: p.x, y: isFlipped ? p.y : bounds.height - p.y)
    }

    func pagePoint(screen point: NSPoint) -> NSPoint? {
        guard let w = window else { return nil }
        return pagePoint(window: w.convertPoint(fromScreen: point))
    }

    /// a tab or button of the HTML title bar
    func isTitlebarControl(_ p: NSPoint) -> Bool {
        p.y >= 0 && p.y < titlebarHeight && noDragRects.contains { $0.contains(p) }
    }

    private func inDragArea(_ event: NSEvent) -> Bool {
        let p = pagePoint(event)
        guard p.y >= 0, p.y < titlebarHeight else { return false }
        return !noDragRects.contains { $0.contains(p) }
    }

    override func mouseDown(with event: NSEvent) {
        mouseDownCount += 1
        InputLog.write(String(format: "mouseDown page=%@ drag=%d key=%d active=%d clicks=%d", NSStringFromPoint(pagePoint(event)),
                              inDragArea(event) ? 1 : 0, window?.isKeyWindow == true ? 1 : 0, NSApp.isActive ? 1 : 0, event.clickCount))
        if inDragArea(event), let window = window {
            if event.clickCount == 2 {
                let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
                if action == "Minimize" { window.performMiniaturize(nil) }
                else if action != "None" { window.performZoom(nil) }
                return
            }
            window.performDrag(with: event)
            return
        }
        super.mouseDown(with: event)
    }

    override var mouseDownCanMoveWindow: Bool { false }

    /// tabs and title-bar buttons react to the very first click, like Safari's tab bar
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        if let e = event, pagePoint(e).y < titlebarHeight { return true }
        return super.acceptsFirstMouse(for: event)
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        // Markdown files / folders dropped on the window open as tabs; images fall through to the page.
        let pb = sender.draggingPasteboard
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            let docs = urls.filter { url in
                var isDir: ObjCBool = false
                FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
                return isDir.boolValue || ["md", "markdown", "mdown", "mkd", "mdx", "txt"].contains(url.pathExtension.lowercased())
            }
            if !docs.isEmpty {
                (NSApp.delegate as? AppDelegate)?.open(urls: docs)
                return true
            }
        }
        return super.performDragOperation(sender)
    }
}

final class MainWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let webView: EditorWebView
    let bridge = Bridge()
    let scheme = SchemeHandler()
    var pageReady = false
    private var shown = false
    private var queued: [(String, Any?)] = []

    init() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: "yumark")
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "bridge")
        config.preferences.isElementFullscreenEnabled = false
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        if ProcessInfo.processInfo.environment["YUMARK_DEVTOOLS"] != nil || UserDefaults.standard.bool(forKey: "DevTools") {
            config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        }
        config.suppressesIncrementalRendering = false
        webView = EditorWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsMagnification = false

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.tabbingMode = .disallowed
        window.minSize = NSSize(width: 460, height: 300)
        window.collectionBehavior = [.fullScreenPrimary]
        window.backgroundColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0x1c / 255, green: 0x1c / 255, blue: 0x1e / 255, alpha: 1)
                : NSColor.white
        }
        window.contentView = webView
        window.title = "YuMarkEditor"
        super.init(window: window)
        window.delegate = self
        if !window.setFrameUsingName("MainWindow") { window.center() }
        window.setFrameAutosaveName("MainWindow")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        bridge.controller = self
        layoutTrafficLights()
    }

    required init?(coder: NSCoder) { fatalError() }

    func load() {
        webView.load(URLRequest(url: URL(string: "yumark://app/index.html")!))
        // show the window even if the page is slow to report in
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.showWindow() }
    }

    func showWindow() {
        guard !shown, let window = window else { return }
        shown = true
        if TestHarness.active {
            window.orderFrontRegardless()
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        layoutTrafficLights()
    }

    /// Called by the bridge once the page has booted.
    func pageDidBecomeReady() {
        pageReady = true
        for (c, a) in queued { dispatch(c, a) }
        queued.removeAll()
        if TestHarness.active { TestHarness.run(self) }
    }

    /// Send a command to the page.
    func dispatch(_ command: String, _ arg: Any? = nil) {
        guard pageReady else { queued.append((command, arg)); return }
        var argJSON = "null"
        if let arg = arg {
            if JSONSerialization.isValidJSONObject([arg]), let data = try? JSONSerialization.data(withJSONObject: [arg]),
               let s = String(data: data, encoding: .utf8) {
                argJSON = String(s.dropFirst().dropLast())
            }
        }
        let cmdJSON = "\"\(command.replacingOccurrences(of: "\"", with: ""))\""
        webView.evaluateJavaScript("window.__jd && window.__jd.dispatch(\(cmdJSON), \(argJSON))", completionHandler: nil)
    }

    // MARK: traffic lights — vertically centred in the 38pt HTML title bar

    func layoutTrafficLights() {
        guard let window = window,
              let close = window.standardWindowButton(.closeButton),
              let container = close.superview?.superview else { return }
        if window.styleMask.contains(.fullScreen) { return }
        let barHeight: CGFloat = 38
        var frame = container.frame
        frame.size.height = barHeight
        frame.origin.y = window.frame.height - barHeight
        container.frame = frame
        let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        var x: CGFloat = 13
        for type in buttons {
            guard let b = window.standardWindowButton(type) else { continue }
            var f = b.frame
            f.origin.x = x
            f.origin.y = (barHeight - f.height) / 2
            b.setFrameOrigin(f.origin)
            x += 20
        }
    }

    func windowDidResize(_ notification: Notification) { layoutTrafficLights() }

    func windowDidBecomeKey(_ notification: Notification) {
        layoutTrafficLights()
        // Became key because of a mouse press? If it landed on a title-bar tab or button,
        // make sure the page gets that click (macOS may spend it on activating the window).
        let pressed = NSEvent.pressedMouseButtons & 1 != 0
        InputLog.write("windowDidBecomeKey pressed=\(pressed)")
        guard pressed, let p = webView.pagePoint(screen: NSEvent.mouseLocation), webView.isTitlebarControl(p) else { return }
        watchActivationClick(at: p) { NSEvent.pressedMouseButtons & 1 != 0 }
    }

    /// Waits for the activating click to finish; replays it into the page only if the
    /// web view never received its mouse-down.
    func watchActivationClick(at p: NSPoint, stillPressed: @escaping () -> Bool) {
        let before = webView.mouseDownCount
        var ticks = 0
        Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            ticks += 1
            if stillPressed() && ticks < 150 { return }
            timer.invalidate()
            if self.webView.mouseDownCount != before {
                InputLog.write("activation click reached the page normally")
                return
            }
            InputLog.write(String(format: "activation click swallowed, replaying at %.0f,%.0f", p.x, p.y))
            self.webView.evaluateJavaScript("window.__jd && window.__jd.replayClick(\(p.x), \(p.y))", completionHandler: nil)
        }
    }
    func windowDidEnterFullScreen(_ notification: Notification) { dispatch("fullscreen", true) }
    func windowDidExitFullScreen(_ notification: Notification) {
        dispatch("fullscreen", false)
        layoutTrafficLights()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // one window: closing it quits (unsaved work is kept in the session, like Notepad)
        NSApp.terminate(nil)
        return false
    }

    // MARK: navigation — the page never navigates away

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "yumark" && action.navigationType != .linkActivated {
            decisionHandler(.allow)
            return
        }
        if action.navigationType == .linkActivated, ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReady = false
        webView.reload()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window!) { _ in completionHandler() }
    }
}
