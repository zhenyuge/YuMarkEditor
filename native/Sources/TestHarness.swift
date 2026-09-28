import AppKit
import WebKit

/// Automation for development: `YUMARK_TEST_SCRIPT=/path/test.js YUMARK_TEST_OUT=/dir YuMarkEditor`
/// runs the script's body as an async function in the page, writes its return value to
/// `<out>/result.txt`, snapshots the window to `<out>/snap.png` and quits.
enum TestHarness {
    static let env = ProcessInfo.processInfo.environment
    static var active: Bool { env["YUMARK_TEST_SCRIPT"] != nil }

    static func run(_ c: MainWindowController) {
        guard let scriptPath = env["YUMARK_TEST_SCRIPT"], let script = try? String(contentsOfFile: scriptPath, encoding: .utf8) else { return }
        let out = URL(fileURLWithPath: env["YUMARK_TEST_OUT"] ?? NSTemporaryDirectory())
        let readyMs = Int(Date().timeIntervalSince(launchStart) * 1000)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            c.webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
                var text: String
                switch result {
                case .success(let v): text = "launch→ready \(readyMs)ms\n" + String(describing: v)
                case .failure(let e): text = "SCRIPT ERROR: \(e)"
                }
                try? text.write(to: out.appendingPathComponent("result.txt"), atomically: true, encoding: .utf8)
                if let win = c.window, let img = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(win.windowNumber), [.bestResolution, .boundsIgnoreFraming]) {
                    let rep = NSBitmapImageRep(cgImage: img)
                    try? rep.representation(using: .png, properties: [:])?.write(to: out.appendingPathComponent("window.png"))
                }
                snapshot(c.webView, to: out.appendingPathComponent("snap.png")) {
                    if env["YUMARK_TEST_KEEP"] == nil { NSApp.terminate(nil) }
                }
            }
        }
    }

    static func snapshot(_ wv: WKWebView, to url: URL, done: @escaping () -> Void) {
        wv.takeSnapshot(with: nil) { image, _ in
            if let img = image, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: url)
            }
            done()
        }
    }
}
