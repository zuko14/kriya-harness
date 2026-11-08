// L8 face boxes through Apple's Vision framework: no model download, nothing leaves
// the machine. Reads every .jpg in one folder; prints one JSON line per frame, boxes
// normalised with Vision's origin at the bottom left.
import Foundation
import Vision

let folder = URL(fileURLWithPath: CommandLine.arguments[1])
let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
for name in names.filter({ $0.hasSuffix(".jpg") }).sorted() {
  let request = VNDetectFaceRectanglesRequest()
  try? VNImageRequestHandler(url: folder.appendingPathComponent(name)).perform([request])
  let faces = (request.results ?? []).map { face -> [String: Double] in
    let box = face.boundingBox
    return ["x": box.minX, "y": box.minY, "w": box.width, "h": box.height, "c": Double(face.confidence)]
  }
  let data = try! JSONSerialization.data(withJSONObject: ["frame": name, "faces": faces])
  print(String(data: data, encoding: .utf8)!)
}
