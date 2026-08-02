import fs from "node:fs";
import net from "node:net";

// Process + port primitives for the webapp daemon CLI: liveness probing, the
// pid/port breadcrumb files, and the free-port scan. No knowledge of the CLI's
// commands or config — just the OS-facing parts.

const MAX_PORT_PROBES = 50;

/**
 * Resolve the first free TCP port at or above `startPort` on the loopback host,
 * so a busy configured port transparently rolls to the next one. There is a tiny
 * window between the probe closing and the server binding; the caller writes the
 * resolved port to disk so `status`/the opened URL always reflect the real port.
 * @param {number} startPort
 * @param {number} [maxProbes]
 * @returns {Promise<number>}
 */
export function findFreePort(startPort, maxProbes = MAX_PORT_PROBES) {
  const host = process.env.LWM_WEBAPP_HOST || "127.0.0.1";
  return new Promise((resolve, reject) => {
    let port = startPort;
    let probes = 0;
    const probe = () => {
      const srv = net.createServer();
      srv.once("error", (err) => {
        srv.close();
        if (/** @type {{ code?: string }} */ (err).code === "EADDRINUSE" && probes < maxProbes) {
          probes += 1;
          port += 1;
          probe();
        } else {
          reject(err);
        }
      });
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, host);
    };
    probe();
  });
}

/** @param {number} pid @returns {boolean} */
export function alive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {{ code?: string }} */ (err).code === "EPERM";
  }
}

/** @param {string} pidPath @returns {number} */
export function readPid(pidPath) {
  try {
    return Number(fs.readFileSync(pidPath, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** @param {string} portPath @returns {number} */
export function readPort(portPath) {
  try {
    return Number(fs.readFileSync(portPath, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** @param {string} p */
export function rmQuiet(p) {
  try {
    fs.rmSync(p);
  } catch {
    /* absent is fine */
  }
}

/** @param {number} pid @param {number} ms @returns {boolean} */
export function waitDead(pid, ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    Atomics.wait(buf, 0, 0, 50);
  }
  return !alive(pid);
}
