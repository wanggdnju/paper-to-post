// 从论文 PDF 里按 caption 定位，裁出表格区域并渲染成 PNG。
//
// 为什么用 PDFKit 而不是「把 LaTeX 表格转成 HTML 再截图」：
//   后者要自己重写一个 LaTeX 子集解释器（multicolumn / multirow / 分组表头 / 数学符号），
//   每加一种写法就是一个新 bug——eagle 的主表就因为一个贪婪正则整张列错位。
//   论文 PDF 里的表格是排版好的最终结果，裁出来逐字逐行都与原文一致，不存在「解释错」。
//
// 用法（由 scripts/render-table.mjs 调用，不直接暴露给用户）：
//   swift pdf-table.swift <pdf> <页码从1开始> "<caption 前缀，如 Table 1>" <输出 png> [dpi]
//
// 退出码：0 成功；2 没找到 caption；3 表格区域异常（多半是双栏里选错了栏）。
import Foundation
import PDFKit
import AppKit

let argv = CommandLine.arguments
guard argv.count >= 5 else {
  FileHandle.standardError.write("用法: swift pdf-table.swift <pdf> <page> <caption> <out.png> [dpi]\n".data(using: .utf8)!)
  exit(1)
}
let pdfPath = argv[1]
let pageNo = Int(argv[2]) ?? 1
let captionPrefix = argv[3]
let outPath = argv[4]
let dpi = Double(argv.count > 5 ? argv[5] : "300") ?? 300

guard let doc = PDFDocument(url: URL(fileURLWithPath: pdfPath)) else {
  FileHandle.standardError.write("打不开 PDF：\(pdfPath)\n".data(using: .utf8)!)
  exit(1)
}
guard pageNo >= 1, pageNo <= doc.pageCount, let page = doc.page(at: pageNo - 1) else {
  FileHandle.standardError.write("页码越界：\(pageNo) / 共 \(doc.pageCount) 页\n".data(using: .utf8)!)
  exit(1)
}
let pageRect = page.bounds(for: .mediaBox)

/// 一行文字及其外接框（PDF 坐标系，原点左下）
struct Line { let text: String; let rect: CGRect }

var lines: [Line] = []
if let whole = page.selection(for: pageRect) {
  for sel in whole.selectionsByLine() {
    let text = (sel.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { continue }
    let r = sel.bounds(for: page)
    guard r.width > 0, r.height > 0 else { continue }
    lines.append(Line(text: text, rect: r))
  }
}
// PDFKit 的行顺序不稳定（双栏会左右交错），统一按 y 从高到低排
lines.sort { $0.rect.maxY > $1.rect.maxY }

// ---- 1. 找 caption 行 ----
let capRe = try! NSRegularExpression(pattern: "^" + NSRegularExpression.escapedPattern(for: captionPrefix) + "\\b", options: [.caseInsensitive])
func isCaption(_ t: String) -> Bool {
  capRe.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil
}
// 停止判据要认**任何**图表标题，不能只认目标 caption 那个前缀：
// 否则「Table 1」的裁剪会把下面的「Table 2」一起吞进来（实测第一版就是这样，
// 主结果表下面多出一整张 α 表，看起来像我们自己做错了数据）。
let anyCaptionRe = try! NSRegularExpression(pattern: "^(?:Table|Figure|Algorithm)\\s+\\d+\\s*[:：.]", options: [.caseInsensitive])
func startsCaptionedBlock(_ t: String) -> Bool {
  anyCaptionRe.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) != nil
}
let captionHits = lines.filter { isCaption($0.text) }
guard !captionHits.isEmpty else {
  FileHandle.standardError.write("本页没找到 caption「\(captionPrefix)」\n".data(using: .utf8)!)
  exit(2)
}

// 同一个 caption 前缀在一页里可能命中两栏各一个（Table 1 / Table 11 之类按 \b 已排除，
// 但同号表格在两栏重复出现时仍可能撞）。取第一个（自上而下）。
let captionTop = captionHits[0]
let capCenterX = captionTop.rect.midX
let capHalf = captionTop.rect.width / 2

// ---- 2. 逐行向下收集表格本体 ----
// 判据：
//   · 在同一栏（横向中心距 caption 中心不超过 caption 宽度的一半 + 30pt）；
//   · 竖直方向在 caption 下方；
//   · 相邻行间距不超过阈值（caption→表头 的空隙比行间距大，所以对第一行放宽）；
//   · 撞到下一个 caption / 正文段落就停。
var col = [Line]()
for l in lines where l.rect.maxY <= captionTop.rect.maxY + 1 {
  if abs(l.rect.midX - capCenterX) <= capHalf + 30 { col.append(l) }
}

// caption 本身可能占多行（"Table 1: Speedup ratio..." + 两行说明）
var captionLines: [Line] = [captionTop]
var rest = col.filter { $0.rect.maxY < captionTop.rect.maxY - 1 }
for l in rest {
  let gap = captionLines.last!.rect.minY - l.rect.maxY
  if gap > 12 { break }          // caption 段落内部的行距约 9–12
  if startsCaptionedBlock(l.text) { break }
  captionLines.append(l)
}
let captionBottom = captionLines.map { $0.rect.minY }.min()!
rest = rest.filter { $0.rect.maxY < captionBottom - 1 }

var body: [Line] = []
var prevBottom = captionBottom
var started = false
for l in rest {
  let gap = prevBottom - l.rect.maxY
  // caption 与表头之间常有规则线的留白，第一行放宽；进入表格后收紧
  let limit: CGFloat = started ? 24 : 30
  if gap > limit { break }
  // 撞到下一张表/图/算法块，或者正文段落（行宽接近整栏且以句号结尾、词多）
  if startsCaptionedBlock(l.text) { break }
  let looksProse = l.text.count > 80 && l.rect.width > capHalf * 1.1
  if looksProse { break }
  body.append(l)
  prevBottom = l.rect.minY
  started = true
}

guard !body.isEmpty else {
  FileHandle.standardError.write("找到 caption 但没识别出表格行\n".data(using: .utf8)!)
  exit(3)
}

// ---- 3. 算裁切框并渲染 ----
var box = captionTop.rect.union(body.first!.rect)
for l in captionLines + body { box = box.union(l.rect) }
// 边距：横向 8pt，纵向 10pt（PDF 点）
box = box.insetBy(dx: -8, dy: -10)
// 夹在页面内，避免超出页面导致渲染空白边
box = box.intersection(pageRect)

let scale = dpi / 72.0
let pxW = Int((box.width * scale).rounded())
let pxH = Int((box.height * scale).rounded())
guard pxW > 20, pxH > 20, pxW < 20000, pxH < 20000 else {
  FileHandle.standardError.write("裁切框异常：\(pxW)x\(pxH)\n".data(using: .utf8)!)
  exit(3)
}

guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pxW, pixelsHigh: pxH,
                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                 colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
  exit(1)
}
rep.size = NSSize(width: pxW, height: pxH)
guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = ctx
// 白底：论文 PDF 通常没有背景色，不铺白底直接输出会得到透明 PNG，公众号/知乎会显示成黑
ctx.cgContext.setFillColor(NSColor.white.cgColor)
ctx.cgContext.fill(CGRect(x: 0, y: 0, width: pxW, height: pxH))
ctx.cgContext.scaleBy(x: scale, y: scale)
ctx.cgContext.translateBy(x: -box.origin.x, y: -box.origin.y)
page.draw(with: .mediaBox, to: ctx.cgContext)
NSGraphicsContext.restoreGraphicsState()

guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
do {
  try png.write(to: URL(fileURLWithPath: outPath))
} catch {
  FileHandle.standardError.write("写文件失败：\(error)\n".data(using: .utf8)!)
  exit(1)
}

let info: [String: Any] = [
  "png": outPath,
  "page": pageNo,
  "caption": captionTop.text,
  "captionLines": captionLines.count,
  "rows": body.count,
  "pixels": "\(pxW)x\(pxH)",
  "box": [box.origin.x, box.origin.y, box.width, box.height],
]
if let data = try? JSONSerialization.data(withJSONObject: info, options: [.prettyPrinted, .sortedKeys]) {
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
