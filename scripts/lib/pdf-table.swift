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
// 第 7 个参数：caption 在表格的哪一侧。"below" 表示 ACL 那种 caption 后置表格——
// 这类表从 caption 向上收集表格本体，否则会顺着 caption 下方的正文一路裁
// （DFlare Table 2 实测：caption 在下，结果把右栏三段正文都裁进来了）。
let captionBelow = argv.count > 6 && argv[6] == "below"

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
if captionBelow {
  // caption 后置：表格本体在 caption **上方**，且按 y 从低到高（靠近 caption 的在下）
  for l in lines where l.rect.minY >= captionTop.rect.minY - 1 {
    if abs(l.rect.midX - capCenterX) <= capHalf + 30 { col.append(l) }
  }
  col.reverse()   // 变成「离 caption 近的在前」，后面的循环逻辑就不用改
} else {
  for l in lines where l.rect.maxY <= captionTop.rect.maxY + 1 {
    if abs(l.rect.midX - capCenterX) <= capHalf + 30 { col.append(l) }
  }
}

// caption 本身可能占多行（"Table 1: Speedup ratio..." + 两行说明）
//
// 阈值不能用固定值 12：这里量的是**行框之间的空白**，不是基线间距。
// 实测 caption 内部空白 ≈2pt（D-cut Table 1 的三行 caption 是 1.9/1.9/2.0），
// 而 caption 到表头之间有一道 \toprule 的留白 ≈11pt。用 12 会把表头整行并进
// caption（`Model Method GSM8K …` 被当成 caption 的第四行），captionBottom 一路
// 掉到表格底部，body 为空，最后报「找到 caption 但没识别出表格行」。
//
// 改成**相对**阈值：以 caption 前两行的实际空白为基准，明显变大就认为是表格。
var captionLines: [Line] = [captionTop]
// caption 后置时，caption 的多行说明在表格**上方**，过滤方向要反过来。
var rest = captionBelow
  ? col.filter { $0.rect.minY > captionTop.rect.minY + 1 }
  : col.filter { $0.rect.maxY < captionTop.rect.maxY - 1 }
// 基准取 caption 第 1 行 → 下一行的空白。**不能取 rest[0]→rest[1]**：
// rest[0] 往往已经是表头，那样算出来的是「caption→表头」的大留白，
// 阈值被撑到 19.8pt，整张表都会被并进 caption（2026-11-20 dspine Table 1 实测：
// caption 内空白 2.1pt，caption→表头 15.8pt，倒着取就把表的 8 行全吃了）。
var intraGap: CGFloat = 2
if let first = rest.first {
  intraGap = captionBelow
    ? max(0, first.rect.minY - captionTop.rect.maxY)
    : max(0, captionTop.rect.minY - first.rect.maxY)
}
// 首行可能是表头（gap 大），此时退回 2pt 的通用段落内空白。
if intraGap > 8 { intraGap = 2 }
let capGapLimit = max(4, intraGap + 4)
for l in rest {
  let gap = captionBelow
    ? l.rect.minY - captionLines.last!.rect.maxY
    : captionLines.last!.rect.minY - l.rect.maxY
  if gap > capGapLimit { break }
  if startsCaptionedBlock(l.text) { break }
  captionLines.append(l)
}
// caption 区块的「远端」边界：above 时是最低的那条（minY），below 时是最高的（maxY）
let captionBottom: CGFloat = captionBelow
  ? captionLines.map { $0.rect.maxY }.max()!
  : captionLines.map { $0.rect.minY }.min()!
rest = captionBelow
  ? rest.filter { $0.rect.minY > captionBottom + 1 }
  : rest.filter { $0.rect.maxY < captionBottom - 1 }

var body: [Line] = []
var prevBottom = captionBottom
var started = false
// 记下让循环终止的那一行。算裁切框时要用它把 10pt 外边距夹住——
// 表格底部与下一张图的 caption 之间常常只有 15pt 左右，`insetBy(dy:-10)`
// 一扩就把 "Figure 5:" 那几行吞进图里（D-cut Table 2 实测）。
var stopLine: Line? = nil
// gaps[i] = body[i] 与上一条之间的垂直空白（body[0] 记 0，占位对齐）
var gaps: [CGFloat] = []
for l in rest {
  // caption 后置时 rest 已按「离 caption 由近到远」排好（col 反转过），
  // 间距一律取正向差值。
  let gap = captionBelow ? l.rect.minY - prevBottom : prevBottom - l.rect.maxY
  // caption 与表头之间常有规则线的留白，第一行放宽；进入表格后放宽到 24。
  //
  // 真正的截断不在这里做：表格下方紧跟的图，其坐标轴刻度（`0 1000 2000`、
  // `bs=4 bs=8 …`）是独立文字行、间距和表行一样小，任何固定阈值都会连它一起收进来。
  // 先宽松收集，循环结束后再按「间距突变」回溯（见下面的 trimAtGapJump）。
  let limit: CGFloat = started ? 24 : 30
  if gap > limit { stopLine = l; break }
  // 撞到下一张表/图/算法块，或者正文段落。
  //
  // 「正文段落」不能只按「字符多 + 差不多占满整栏」判：**宽表的数据行正好长这样**
  // （D-cut Table 1 每行 ~110 字符、宽 372pt，远超半栏），于是第一行数据就被当成
  // 散文截断，整张表只剩表头。表行的真正特征是数字占比高、且不以句号收尾，
  // 两个条件都满足才算散文。
  if startsCaptionedBlock(l.text) { stopLine = l; break }
  let numericChars = l.text.reduce(0) { $1.isNumber ? $0 + 1 : $0 }
  let mostlyNumbers = numericChars * 4 >= l.text.count
  let endsSentence = l.text.hasSuffix(".") || l.text.hasSuffix("。") || l.text.hasSuffix(":")
  let looksProse = l.text.count > 80 && l.rect.width > capHalf * 1.1 && !mostlyNumbers && endsSentence
  if looksProse { stopLine = l; break }
  // 跨栏正文：单栏论文里，表格下方的正文段落会横跨整页宽度（> pageRect 的 80%），
  // 而表格行再宽也只在栏内。双栏版面里表格可能占满整栏，所以用「比 caption 所在的
  // 栏宽出很多」来判断——Domino Table 2 底部就粘了三行 `Table 3 shows a clear…`。
  let spansBothColumns = l.rect.width > pageRect.width * 0.8 && captionTop.rect.width < pageRect.width * 0.7
  if spansBothColumns && l.text.count > 40 { stopLine = l; break }
  body.append(l)
  gaps.append(body.count == 1 ? 0 : gap)
  prevBottom = captionBelow ? l.rect.maxY : l.rect.minY
  started = true
}

/// 回溯截断：表格内部行间距小而稳定，一旦跨到下一张图的坐标轴刻度，
/// 间距会出现一次明显跳变（D-cut Table 2 实测：表内 3.4pt，表→图轴 19.8pt）。
/// 取已收间距的中位数 m，从第一处 gap > min(22, max(9, 4m)) 切断——只保留表格本体。
func trimAtGapJump(_ lines: [Line], _ gs: [CGFloat]) -> [Line] {
  guard lines.count > 2, gs.count == lines.count else { return lines }
  // gaps[i] 是 lines[i] 与上一条之间的间距。
  // 丢掉前两条：第一条是 caption→表头的大留白（规则线），第二条是表头首行，
  // 两者都不代表表内的稳定行距，留在基准里会把中位数抬高、导致整表被截。
  guard gs.count > 4 else { return lines }
  let valid = Array(gs.dropFirst(2))
  let sorted = valid.sorted()
  let m = sorted[sorted.count / 2]
  // 表内行距小而稳，跨到图轴的间距通常是它的 4 倍以上。上限夹到 22pt，
  // 避免中位数本身偏大时阈值失效。
  let limit = min(22, max(9, 4 * m))
  for i in 2..<gs.count where gs[i] > limit {
    return Array(lines.prefix(i))
  }
  return lines
}
body = trimAtGapJump(body, gaps)

guard !body.isEmpty else {
  FileHandle.standardError.write("找到 caption 但没识别出表格行\n".data(using: .utf8)!)
  exit(3)
}

// ---- 3. 算裁切框并渲染 ----
var box = captionTop.rect.union(body.first!.rect)
for l in captionLines + body { box = box.union(l.rect) }
// 上边界（caption 顶部）放心外扩，下面没有别的内容；底边界要夹住。
// 表格底边到下一张图 caption 的空白常只有 15–20pt，直接外扩 10pt 会把它吞进来。
let padX: CGFloat = 8
// 底线：优先用终止行；循环自然跑完时退回「下一行」（rest 里紧接 body 尾部的那行），
// 两者都拿不到就老实留 10pt。
// 底边**从表格最后一行算**，不从 box.minY 算：box 是 caption 与所有 body 行的并集，
// 而 body 里可能混进图的坐标轴刻度（`bs=4 bs=8 …` / `0 1000 2000 3000` 这类
// 短标签既不像散文、也挨得够近，行坐标上无法与表行区分）。用最后一行压住底线，
// 至少不会把下一张图的 caption 连同正文一起裁进来。
let lastRow = body.last!
// 底线留白固定 4pt：表格最后一行到下方内容之间常有图的刻度线/坐标轴标签，
// 那些是矢量图形、没有独立的文字行，行坐标拦不住。留白越小越安全，
// 4pt 足够让最后一行文字不与边框贴死。
let padBottom: CGFloat = 4
if captionBelow {
  // caption 后置：lastRow 是**最靠上**的那一行（离 caption 最远），
  // 因此要夹的是上边界而不是下边界。
  let topY = lastRow.rect.maxY + padBottom
  box = CGRect(x: box.minX - padX, y: box.minY,
               width: box.width + padX * 2, height: topY - box.minY)
} else {
  // 高度也按最后一行重算，避免坐标轴刻度把底边顶下去。
  let bottomY = lastRow.rect.minY - padBottom
  box = CGRect(x: box.minX - padX, y: bottomY,
               width: box.width + padX * 2, height: box.maxY - bottomY)
}
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
