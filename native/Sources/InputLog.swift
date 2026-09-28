import Foundation

/// Opt-in input diagnostics: `defaults write com.yumarkeditor.app DebugInput -bool YES`
/// appends title-bar mouse handling to ~/Library/Logs/YuMarkEditor/input.log.
enum InputLog {
    static var enabled: Bool { UserDefaults.standard.bool(forKey: "DebugInput") || TestHarness.active }

    private static let url: URL = {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/YuMarkEditor", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("input.log")
    }()

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    static func write(_ line: String) {
        guard enabled else { return }
        if TestHarness.active { NSLog("[input] %@", line); return }
        let text = "\(stamp.string(from: Date())) \(line)\n"
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(Data(text.utf8))
            try? h.close()
        } else {
            try? Data(text.utf8).write(to: url)
        }
    }
}
