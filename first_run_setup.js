// first_run_setup.js
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

module.exports = function firstRunSetup() {
  return new Promise((resolve, reject) => {
    const CLI_PATH = path.join(__dirname, "data", "arduino-cli.exe");
    const TARGET_PATH = CLI_PATH;
    const SOURCE_PATH = path.join(__dirname, "tools", "windows", "arduino-cli.exe");

    try {
      if (!fs.existsSync(TARGET_PATH)) {
        fs.copyFileSync(SOURCE_PATH, TARGET_PATH);
      }
      if (!fs.existsSync(path.join(__dirname, "data"))) fs.mkdirSync(path.join(__dirname, "data"));

      exec(`"${CLI_PATH}" config init --config-dir "${path.join(__dirname, "data")}"`, (err) => {
        if (err) return reject(err);

        exec(`"${CLI_PATH}" core install arduino:avr --config-dir "${path.join(__dirname, "data")}"`, (err2) => {
          if (err2) return reject(err2);
          resolve();
        });
      });
    } catch (err) {
      reject(err);
    }
  });
};