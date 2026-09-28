import AppKit
import WebKit
import UniformTypeIdentifiers

/// Renders an HTML string in an off-screen web view. Subclasses produce the output.
class OffscreenRender: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    let window: NSWindow
    private var retainSelf: OffscreenRender?
    private var finished = false

    init(html: String, width: CGFloat, height: CGFloat) {
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
        window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: width, height: height),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = webView
        super.init()
        retainSelf = self
        webView.navigationDelegate = self
        webView.loadHTMLString(html, baseURL: URL(string: "about:blank"))
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) { [weak self] in
            self?.finish(BridgeError("导出超时"))
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // off-screen pages get no animation frames: wait with timers, never forever
        let js = """
        const limit = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
        await limit(document.fonts.ready, 3000);
        await limit(Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r }))), 8000);
        await new Promise(r => setTimeout(r, 120));
        return 1;
        """
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] _ in
            self?.pageReady()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error) }

    func pageReady() {}

    /// Subclasses call this exactly once. AppKit / WebKit callbacks (the print
    /// operation's in particular) can arrive on a background thread; window and
    /// web-view teardown must happen on the main thread.
    func finish(_ error: Error?) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.finish(error) }
            return
        }
        guard !finished else { return }
        finished = true
        completed(error)
        window.contentView = nil
        window.close()
        retainSelf = nil
    }

    func completed(_ error: Error?) {}
}

/// Paginated A4 PDF straight to a file — no print panel.
final class PDFExport: OffscreenRender {
    static let paper = NSSize(width: 595.28, height: 841.89)
    static let margin: CGFloat = 50
    let dest: URL
    let done: (Error?) -> Void

    init(html: String, dest: URL, done: @escaping (Error?) -> Void) {
        self.dest = dest
        self.done = done
        super.init(html: html, width: PDFExport.paper.width - PDFExport.margin * 2, height: PDFExport.paper.height)
    }

    override func pageReady() {
        let info = NSPrintInfo()
        info.paperSize = PDFExport.paper
        info.topMargin = PDFExport.margin
        info.bottomMargin = PDFExport.margin
        info.leftMargin = PDFExport.margin
        info.rightMargin = PDFExport.margin
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = dest
        let op = webView.printOperation(with: info)
        op.showsPrintPanel = false
        op.showsProgressPanel = false
        op.view?.frame = webView.bounds
        op.runModal(for: window, delegate: self, didRun: #selector(printDone(_:success:contextInfo:)), contextInfo: nil)
    }

    @objc func printDone(_ op: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        DispatchQueue.main.async { self.finish(success ? nil : BridgeError("PDF 生成失败")) }
    }

    override func completed(_ error: Error?) { done(error) }
}

/// Long image(s): 750 CSS px rendered at 2x = 1500 px wide, split at block boundaries.
final class ImageExport: OffscreenRender {
    let dest: URL
    let cssWidth: CGFloat
    let scale: CGFloat
    let maxSegment: CGFloat = 7500
    let done: (Result<[String], Error>) -> Void
    private var outputs: [String] = []

    init(html: String, dest: URL, cssWidth: CGFloat, pixelWidth: CGFloat, done: @escaping (Result<[String], Error>) -> Void) {
        self.dest = dest
        self.cssWidth = cssWidth
        self.scale = pixelWidth / cssWidth
        self.done = done
        super.init(html: html, width: cssWidth, height: 1000)
    }

    override func pageReady() {
        let js = """
        const body = document.querySelector('.markdown-body');
        const kids = [...body.children];
        const cuts = [];
        for (let i = 0; i < kids.length - 1; i++) {
          const a = kids[i].getBoundingClientRect(), b = kids[i + 1].getBoundingClientRect();
          cuts.push(Math.round((a.bottom + b.top) / 2 + scrollY));
        }
        return { height: Math.ceil(document.documentElement.scrollHeight), cuts };
        """
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            guard case .success(let value) = result, let dict = value as? [String: Any],
                  let height = (dict["height"] as? NSNumber)?.doubleValue else {
                self.finish(BridgeError("无法测量页面高度")); return
            }
            let cuts = ((dict["cuts"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.doubleValue }
            self.render(height: CGFloat(height), cuts: cuts.map { CGFloat($0) })
        }
    }

    private func render(height: CGFloat, cuts: [CGFloat]) {
        // lay out at full height so the whole page is captured
        webView.frame = NSRect(x: 0, y: 0, width: cssWidth, height: height)
        window.setContentSize(NSSize(width: cssWidth, height: height))
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            let config = WKPDFConfiguration()
            config.rect = CGRect(x: 0, y: 0, width: self.cssWidth, height: height)
            self.webView.createPDF(configuration: config) { result in
                switch result {
                case .failure(let e): self.finish(e)
                case .success(let data): self.rasterize(pdf: data, height: height, cuts: cuts)
                }
            }
        }
    }

    private func segments(height: CGFloat, cuts: [CGFloat]) -> [(CGFloat, CGFloat)] {
        var out: [(CGFloat, CGFloat)] = []
        var start: CGFloat = 0
        while start < height - 1 {
            if height - start <= maxSegment { out.append((start, height)); break }
            let limit = start + maxSegment
            let candidates = cuts.filter { $0 > start + 300 && $0 <= limit }
            let end = candidates.max() ?? limit
            out.append((start, end))
            start = end
        }
        return out
    }

    private func rasterize(pdf: Data, height: CGFloat, cuts: [CGFloat]) {
        guard let provider = CGDataProvider(data: pdf as CFData), let doc = CGPDFDocument(provider), doc.numberOfPages >= 1 else {
            finish(BridgeError("无法生成页面快照")); return
        }
        // WebKit may split very tall captures into pages; stack them.
        var pages: [(CGPDFPage, CGRect)] = []
        for i in 1...doc.numberOfPages {
            if let p = doc.page(at: i) { pages.append((p, p.getBoxRect(.mediaBox))) }
        }
        let totalPDF = pages.reduce(0) { $0 + $1.1.height }
        let unit = totalPDF > 0 ? totalPDF / height : 1  // PDF points per CSS px
        let segs = segments(height: height, cuts: cuts)
        let base = dest.deletingPathExtension()
        for (i, seg) in segs.enumerated() {
            let pxW = Int((cssWidth * scale).rounded())
            let pxH = Int(((seg.1 - seg.0) * scale).rounded())
            guard pxH > 0, let ctx = CGContext(data: nil, width: pxW, height: pxH, bitsPerComponent: 8, bytesPerRow: 0,
                                               space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                               bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
            ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: pxW, height: pxH))
            ctx.interpolationQuality = .high
            // draw each PDF page at its vertical offset (pages stacked top to bottom)
            var top: CGFloat = 0  // CSS px from document top
            for (page, box) in pages {
                let pageH = box.height / unit
                let pageTop = top
                top += pageH
                if pageTop >= seg.1 || pageTop + pageH <= seg.0 { continue }
                ctx.saveGState()
                let k = scale / unit
                // bitmap y (from bottom) of this page's bottom edge
                let bottomCSS = pageTop + pageH
                ctx.translateBy(x: 0, y: (seg.1 - bottomCSS) * scale)
                ctx.scaleBy(x: k * (cssWidth * unit / box.width), y: k)
                ctx.translateBy(x: -box.minX, y: -box.minY)
                ctx.drawPDFPage(page)
                ctx.restoreGState()
            }
            guard let img = ctx.makeImage() else { continue }
            let url = segs.count == 1 ? dest : URL(fileURLWithPath: base.path + "-\(i + 1).png")
            guard let d = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { continue }
            CGImageDestinationAddImage(d, img, [kCGImagePropertyDPIWidth: 144, kCGImagePropertyDPIHeight: 144] as CFDictionary)
            if CGImageDestinationFinalize(d) { outputs.append(url.path) }
        }
        finish(outputs.isEmpty ? BridgeError("长图生成失败") : nil)
    }

    override func completed(_ error: Error?) {
        if let e = error { done(.failure(e)) } else { done(.success(outputs)) }
    }
}
