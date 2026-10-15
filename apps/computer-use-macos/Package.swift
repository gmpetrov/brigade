// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "BrigadeComputerUse",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "BrigadeComputerUse", path: "Sources/BrigadeComputerUse")
  ]
)
