import AppKit

// A native, per-user front end. The shared Node installer owns all file changes.
final class Installer: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var status: NSTextField!
    var installButton: NSButton!
    var pathChoice: NSButton!
    let resources = Bundle.main.resourceURL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 580, height: 440),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Install Touba"
        window.center()
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 18
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -32),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 32),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: window.contentView!.bottomAnchor, constant: -32)
        ])
        let title = NSTextField(labelWithString: "Touba")
        title.font = .systemFont(ofSize: 30, weight: .semibold)
        title.textColor = .systemBlue
        stack.addArrangedSubview(title)
        let description = NSTextField(wrappingLabelWithString:
            "Install the Touba language and its runtime for your account. JavaScript and Python SDK archives are included; install either SDK in each project with touba sdk install.\n\nNo administrator password or network download is required. Your projects and their data are not modified.")
        stack.addArrangedSubview(description)
        description.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        pathChoice = NSButton(checkboxWithTitle: "Add Touba to PATH for new zsh terminals", target: nil, action: nil)
        pathChoice.state = .on
        stack.addArrangedSubview(pathChoice)
        status = NSTextField(wrappingLabelWithString: "Location: ~/.touba • Local build, not a signed public release")
        status.textColor = .secondaryLabelColor
        stack.addArrangedSubview(status)
        status.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        installButton = NSButton(title: "Install Touba", target: self, action: #selector(install))
        installButton.bezelStyle = .rounded
        installButton.keyEquivalent = "\r"
        stack.addArrangedSubview(installButton)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc func install() {
        let prefix = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".touba")
        let exists = FileManager.default.fileExists(atPath: prefix.appendingPathComponent("touba-toolchain").path)
        if exists {
            let confirm = NSAlert()
            confirm.messageText = "Update this Touba installation?"
            confirm.informativeText = "The previous build is preserved. Project SDKs, checkpoints and running services are not updated or restarted. Stop your Touba services before proceeding."
            confirm.addButton(withTitle: "Update")
            confirm.addButton(withTitle: "Cancel")
            if confirm.runModal() != .alertFirstButtonReturn { return }
        }
        installButton.isEnabled = false
        pathChoice.isEnabled = false
        status.stringValue = "Installing and checking the toolchain…"
        let addPath = pathChoice.state == .on
        let resourcePath = resources.path
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: resourcePath + "/payload/bin/node")
            process.arguments = [resourcePath + "/support/src/desktop-install.mjs", "--source", resourcePath + "/payload", "--prefix", prefix.path]
                + (exists ? ["--force"] : []) + (addPath ? ["--add-path"] : [])
            let output = Pipe()
            process.standardOutput = output
            process.standardError = output
            do {
                try process.run()
                let data = output.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                let details = String(data: data, encoding: .utf8) ?? ""
                let success = process.terminationStatus == 0
                DispatchQueue.main.async {
                    let alert = NSAlert()
                    alert.messageText = success ? "Touba is installed" : "Installation did not complete"
                    alert.informativeText = success
                        ? "Open a new terminal and run touba version.\n\nIn your project:\ntouba sdk install javascript\nor\ntouba sdk install python\n\nPython 3.11+ or npm is required only for the selected SDK."
                        : String(details.prefix(2000))
                    alert.addButton(withTitle: "OK")
                    alert.runModal()
                    self.status.stringValue = success ? "Installation verified. You can close this window." : "Review the error before trying again."
                    self.installButton.isEnabled = !success
                    self.pathChoice.isEnabled = !success
                }
            } catch {
                DispatchQueue.main.async {
                    self.status.stringValue = "Unable to start the installer: \(error.localizedDescription)"
                    self.installButton.isEnabled = true
                    self.pathChoice.isEnabled = true
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = Installer()
application.delegate = delegate
application.run()
