import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function decodeJwt(token) {
  const raw = String(token || "").replace(/^Bearer\s+/i, "");
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function tokenStatus(session) {
  const accessToken = session?.accessToken || session?.access_token;
  if (!accessToken) return { valid: false, secondsLeft: 0, daysLeft: 0 };
  const decoded = decodeJwt(accessToken);
  let secondsLeft = 0;
  if (decoded?.exp) {
    secondsLeft = decoded.exp - Math.floor(Date.now() / 1000);
  } else if (session.createdAt && session.expiresIn) {
    secondsLeft = Math.floor((session.createdAt + session.expiresIn * 1000 - Date.now()) / 1000);
  }
  return { valid: secondsLeft > 0, secondsLeft, daysLeft: secondsLeft / 86400 };
}

export function loadSession(sessionPath) {
  secureSessionDir(sessionPath);
  const mode = statSync(sessionPath).mode & 0o777;
  if (mode !== 0o600) chmodSync(sessionPath, 0o600);
  const s = JSON.parse(readFileSync(sessionPath, "utf8"));
  if (!s.accessToken && !s.refreshToken && !s.location) throw new Error("No Glovo token or location in session. Run glovo_login first.");
  if ((s.accessToken || s.refreshToken) && typeof (s.accessToken || s.refreshToken) !== "string") throw new Error("Malformed Glovo session. Run glovo_login again.");
  return s;
}

export function saveSession(sessionPath, session) {
  secureSessionDir(sessionPath);
  const tmp = `${sessionPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ ...session, updatedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  chmodSync(tmp, 0o600);
  renameSync(tmp, sessionPath);
  chmodSync(sessionPath, 0o600);
}

function secureSessionDir(sessionPath) {
  const dir = dirname(sessionPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = statSync(dir).mode & 0o777;
  if (mode !== 0o700) chmodSync(dir, 0o700);
}
