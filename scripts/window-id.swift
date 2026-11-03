// Prints the window number of the on-screen window titled exactly <title>
// (for `screencapture -l`). Used by screenshots.sh.
import CoreGraphics
let want = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Tiny Time"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  if let name = w[kCGWindowName as String] as? String, name == want, let id = w[kCGWindowNumber as String] as? Int {
    print(id)
    break
  }
}
