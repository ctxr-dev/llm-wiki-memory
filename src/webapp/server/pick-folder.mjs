import { execFile } from "node:child_process";

const CHOOSE_FOLDER_SCRIPT =
  'POSIX path of (choose folder with prompt "Select a folder that contains a .llm-wiki-memory wiki")';

const USER_CANCELED = /User canceled|-128\b/i;

/**
 * True when an osascript error represents the user pressing Cancel. Matches the
 * locale-independent AppleScript error number (-128) as well as the English text,
 * so a cancel on a non-English macOS is not mis-reported as a failure.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isUserCancel(message) {
  return USER_CANCELED.test(String(message));
}

/**
 * `choose folder` returns a POSIX path with a trailing slash; strip it so the path
 * matches what the add-wiki validator expects, while preserving the filesystem root.
 * @param {unknown} stdout
 * @returns {string}
 */
export function normalizePickedPath(stdout) {
  const picked = String(stdout).trim();
  return picked.length > 1 ? picked.replace(/\/+$/, "") : picked;
}

/**
 * Open the OS-native folder chooser and resolve the selected absolute path.
 * macOS only (osascript); the dialog runs on the machine hosting this local
 * server. Resolves "" when the user cancels. Rejects with Error("unsupported")
 * on a non-macOS platform. The AppleScript is a fixed constant (no user input),
 * and execFile passes it as an argument (no shell), so there is no injection surface.
 * @returns {Promise<string>}
 */
export function pickFolderNative() {
  if (process.platform !== "darwin") return Promise.reject(new Error("unsupported"));
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", CHOOSE_FOLDER_SCRIPT], (error, stdout) => {
      if (error) {
        if (isUserCancel(error.message)) return resolve("");
        return reject(error);
      }
      resolve(normalizePickedPath(stdout));
    });
  });
}
