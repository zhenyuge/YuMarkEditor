import AppKit
import ImageIO
import UniformTypeIdentifiers

/// Pasted / dropped images are downscaled and stored as WebP in `<dir>/assets/`.
enum ImageSaver {
    static let maxPixelSize = 2400
    static let quality: Float = 80

    static func save(dir: String, data: Data, mime: String, name: String?) throws -> String {
        let assets = URL(fileURLWithPath: dir).appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        let stamp: String = {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyyMMdd-HHmmss"
            return f.string(from: Date())
        }()
        func target(_ ext: String) -> String {
            TextFiles.uniquePath(assets.appendingPathComponent("image-\(stamp).\(ext)").path)
        }
        // keep animations and vector images as they are
        if mime == "image/gif" || mime == "image/svg+xml" {
            let path = target(mime == "image/gif" ? "gif" : "svg")
            try data.write(to: URL(fileURLWithPath: path))
            return path
        }
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { throw BridgeError("无法读取图片") }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { throw BridgeError("无法解码图片") }
        if let webp = encodeWebP(image) {
            let path = target("webp")
            try webp.write(to: URL(fileURLWithPath: path))
            return path
        }
        // fallback: PNG
        let path = target("png")
        guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw BridgeError("无法写入图片")
        }
        CGImageDestinationAddImage(dest, image, nil)
        CGImageDestinationFinalize(dest)
        return path
    }

    static func encodeWebP(_ image: CGImage) -> Data? {
        let w = image.width, h = image.height
        let stride = w * 4
        var pixels = [UInt8](repeating: 0, count: stride * h)
        let hasAlpha: Bool = {
            switch image.alphaInfo {
            case .none, .noneSkipFirst, .noneSkipLast: return false
            default: return true
            }
        }()
        let ok: Bool = pixels.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: stride,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            if !hasAlpha {
                ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
                ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        if hasAlpha {
            // un-premultiply for WebP
            for i in Swift.stride(from: 0, to: pixels.count, by: 4) {
                let a = Int(pixels[i + 3])
                if a > 0 && a < 255 {
                    pixels[i] = UInt8(min(255, Int(pixels[i]) * 255 / a))
                    pixels[i + 1] = UInt8(min(255, Int(pixels[i + 1]) * 255 / a))
                    pixels[i + 2] = UInt8(min(255, Int(pixels[i + 2]) * 255 / a))
                }
            }
        }
        var output: UnsafeMutablePointer<UInt8>? = nil
        let size = pixels.withUnsafeBufferPointer { p in
            WebPEncodeRGBA(p.baseAddress, Int32(w), Int32(h), Int32(stride), quality, &output)
        }
        guard size > 0, let out = output else { return nil }
        defer { WebPFree(out) }
        return Data(bytes: out, count: size)
    }
}
