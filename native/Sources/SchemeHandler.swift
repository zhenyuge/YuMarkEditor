import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves `yumark://app/…` from the bundled web UI and `yumark://app/@fs/<absolute path>`
/// from the local file system (so documents can show their images, same-origin).
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private var stopped = Set<ObjectIdentifier>()
    private let queue = DispatchQueue(label: "yumark.scheme", qos: .userInitiated, attributes: .concurrent)

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "html": return "text/html; charset=utf-8"
        case "json": return "application/json"
        case "woff2": return "font/woff2"
        case "svg": return "image/svg+xml"
        case "md", "markdown", "txt": return "text/plain; charset=utf-8"
        default:
            return UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path
        let fileURL: URL
        if path.hasPrefix("/@fs/") {
            fileURL = URL(fileURLWithPath: String(path.dropFirst(4)))
        } else {
            let rel = path == "/" || path.isEmpty ? "index.html" : String(path.dropFirst())
            let root = AppPaths.webRoot.standardizedFileURL
            let candidate = root.appendingPathComponent(rel).standardizedFileURL
            guard candidate.path.hasPrefix(root.path) else { fail(task, url, 403); return }
            fileURL = candidate
        }
        let id = ObjectIdentifier(task)
        queue.async {
            let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe)
            DispatchQueue.main.async {
                guard !self.stopped.contains(id) else { self.stopped.remove(id); return }
                guard let data = data else { self.fail(task, url, 404); return }
                let headers = [
                    "Content-Type": Self.mimeType(for: fileURL),
                    "Content-Length": String(data.count),
                    "Cache-Control": "no-cache",
                    "Access-Control-Allow-Origin": "*",
                ]
                let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
                task.didReceive(response)
                task.didReceive(data)
                task.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    private func fail(_ task: WKURLSchemeTask, _ url: URL, _ code: Int) {
        let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"])!
        task.didReceive(response)
        task.didReceive(Data())
        task.didFinish()
    }
}
