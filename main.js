// main.js
const { app, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const agent = require("./agent"); // starts Express server

let tray = null;

app.whenReady().then(() => {
  // Hide dock icon on macOS so it only appears in the menu bar
  if (process.platform === "darwin") {
    app.dock.hide();
  }

  // Note: You should have an 'icon.png' (or icon.ico for Windows) in your project root.
  // If the file is missing, the tray will still be created but might look like an empty space.
  const iconPath = path.join(__dirname, "icon.png");
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: "Arduino Agent Running", enabled: false },
    { type: "separator" },
    { label: "Quit Agent", click: () => { app.quit(); } }
  ]);

  tray.setToolTip("Arduino Agent");
  tray.setContextMenu(contextMenu);

  console.log("Arduino Agent is running in the background tray.");
});

app.on("window-all-closed", () => {
  // Background agents typically stay alive even if a temporary window is closed.
});