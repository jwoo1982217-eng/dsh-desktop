import AppKit
import Foundation

let destination = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let s = CGFloat(size)
    let rect = NSRect(x: s * 0.06, y: s * 0.06, width: s * 0.88, height: s * 0.88)
    let shape = NSBezierPath(roundedRect: rect, xRadius: s * 0.205, yRadius: s * 0.205)
    NSGradient(starting: NSColor(calibratedRed: 0.36, green: 0.44, blue: 0.99, alpha: 1), ending: NSColor(calibratedRed: 0.24, green: 0.28, blue: 0.82, alpha: 1))!.draw(in: shape, angle: -75)
    let font = NSFont.systemFont(ofSize: s * 0.25, weight: .heavy)
    let text: NSString = "DSH"
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white, .kern: -s * 0.012]
    let textSize = text.size(withAttributes: attributes)
    text.draw(at: NSPoint(x: (s - textSize.width) / 2, y: (s - textSize.height) / 2 + s * 0.02), withAttributes: attributes)
    NSGraphicsContext.restoreGraphicsState()
    let png = bitmap.representation(using: .png, properties: [:])!
    if size <= 512 { try png.write(to: destination.appendingPathComponent("icon_\(size)x\(size).png")) }
    if size >= 32 { try png.write(to: destination.appendingPathComponent("icon_\(size/2)x\(size/2)@2x.png")) }
}
