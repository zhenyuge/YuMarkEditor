import Foundation

struct BridgeError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

/// Text files are read and written in their own encoding: UTF-8 (with or without
/// BOM), UTF-16 with BOM, or GB18030 for legacy Chinese files.
enum TextFiles {
    private static var encodings: [String: String.Encoding] = [:]
    private static let gb18030 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))

    static func mtime(_ path: String) -> Double {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return ((attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
    }

    static func read(_ path: String) throws -> (text: String, bom: Bool, mtime: Double) {
        let url = URL(fileURLWithPath: path)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { throw BridgeError("文件不存在：\(path)") }
        if isDir.boolValue { throw BridgeError("这是一个文件夹") }
        let data = try Data(contentsOf: url)
        if data.count > 64 * 1024 * 1024 { throw BridgeError("文件太大（超过 64 MB）") }
        var bom = false
        var text: String?
        var enc: String.Encoding = .utf8
        if data.starts(with: [0xEF, 0xBB, 0xBF]) {
            bom = true
            text = String(data: data.dropFirst(3), encoding: .utf8)
        } else if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]) {
            enc = .utf16
            text = String(data: data, encoding: .utf16)
            bom = false
        } else if let t = String(data: data, encoding: .utf8) {
            text = t
        } else if let t = String(data: data, encoding: gb18030) {
            enc = gb18030
            text = t
        } else {
            enc = .isoLatin1
            text = String(data: data, encoding: .isoLatin1)
        }
        guard let t = text else { throw BridgeError("无法识别文件编码") }
        encodings[path] = enc
        return (t, bom, mtime(path))
    }

    static func write(_ path: String, text: String, bom: Bool) throws -> Double {
        let enc = encodings[path] ?? .utf8
        var data: Data
        if enc == .utf8 {
            data = Data(text.utf8)
            if bom { data.insert(contentsOf: [0xEF, 0xBB, 0xBF], at: 0) }
        } else if let d = text.data(using: enc) {
            data = d
        } else {
            data = Data(text.utf8)
            encodings[path] = .utf8
        }
        try writeData(data, to: path)
        return mtime(path)
    }

    /// Write via a temporary file and swap it in, keeping the original's metadata.
    static func writeData(_ data: Data, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        let fm = FileManager.default
        if fm.fileExists(atPath: path) {
            let tmpDir = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: url, create: true)
            let tmp = tmpDir.appendingPathComponent(url.lastPathComponent)
            try data.write(to: tmp)
            do {
                _ = try fm.replaceItemAt(url, withItemAt: tmp, backupItemName: nil, options: [])
            } catch {
                try data.write(to: url, options: .atomic)
            }
            try? fm.removeItem(at: tmpDir)
        } else {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        }
    }

    /// "name.md" -> "name 2.md" … until the name is free
    static func uniquePath(_ path: String) -> String {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) { return path }
        let url = URL(fileURLWithPath: path)
        let dir = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let base = url.deletingPathExtension().lastPathComponent
        for i in 2...9999 {
            let name = "\(base) \(i)"
            let candidate = dir.appendingPathComponent(ext.isEmpty ? name : "\(name).\(ext)").path
            if !fm.fileExists(atPath: candidate) { return candidate }
        }
        return path
    }

    /// "name.md" -> "name 副本.md", "name 副本 2.md" …
    static func copyPath(_ path: String) -> String {
        let url = URL(fileURLWithPath: path)
        let ext = url.pathExtension
        let base = url.deletingPathExtension().lastPathComponent + " 副本"
        let first = url.deletingLastPathComponent().appendingPathComponent(ext.isEmpty ? base : "\(base).\(ext)").path
        return uniquePath(first)
    }
}
