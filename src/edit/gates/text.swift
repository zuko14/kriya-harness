// QG-10's reader: Apple's Vision text recognition, accurate mode, on this machine;
// no model download, nothing leaves it. Reads every .png in one folder and prints one
// JSON line per image: its recognised lines, top to bottom, with confidences.
import Foundation
import Vision

let folder = URL(fileURLWithPath: CommandLine.arguments[1])
let languages = CommandLine.arguments.count > 2 ? CommandLine.arguments[2].split(separator: ",").map(String.init) : ["en-US"]
let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
for name in names.filter({ $0.hasSuffix(".png") }).sorted() {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  request.recognitionLanguages = languages
  try? VNImageRequestHandler(url: folder.appendingPathComponent(name)).perform([request])
  let lines = (request.results ?? [])
    .sorted { $0.boundingBox.maxY > $1.boundingBox.maxY }
    .compactMap { $0.topCandidates(1).first }
    .map { ["text": $0.string, "c": Double($0.confidence)] as [String: Any] }
  let data = try! JSONSerialization.data(withJSONObject: ["image": name, "lines": lines])
  print(String(data: data, encoding: .utf8)!)
}
