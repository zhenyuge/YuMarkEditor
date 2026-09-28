import AppKit

let launchStart = Date()

// Must exist before anything touches NSDocumentController.shared.
_ = RecentDocumentController()

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
