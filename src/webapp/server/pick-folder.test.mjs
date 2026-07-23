import { test, expect, vi, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { pickFolderNative, isUserCancel, normalizePickedPath } from "./pick-folder.mjs";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

afterEach(() => execFile.mockReset());

async function withPlatform(value, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
}

test("isUserCancel matches the English text and the locale-independent -128 code", () => {
  expect(isUserCancel("execution error: User canceled. (-128)")).toBe(true);
  expect(isUserCancel("erreur d'exécution : opération annulée. (-128)")).toBe(true);
  expect(isUserCancel("osascript: some other failure")).toBe(false);
});

test("normalizePickedPath trims + strips a trailing slash but preserves the filesystem root", () => {
  expect(normalizePickedPath("/Users/me/wiki/\n")).toBe("/Users/me/wiki");
  expect(normalizePickedPath("  /a/b  ")).toBe("/a/b");
  expect(normalizePickedPath("/\n")).toBe("/");
});

test("pickFolderNative rejects with 'unsupported' off macOS (no exec)", async () => {
  await withPlatform("linux", async () => {
    await expect(pickFolderNative()).rejects.toThrow("unsupported");
  });
  expect(execFile).not.toHaveBeenCalled();
});

test("pickFolderNative resolves the normalized path on a successful pick", async () => {
  execFile.mockImplementation((_cmd, _args, cb) => cb(null, "/Users/me/wiki/\n"));
  await withPlatform("darwin", async () => {
    expect(await pickFolderNative()).toBe("/Users/me/wiki");
  });
});

test("pickFolderNative resolves '' when the user cancels", async () => {
  execFile.mockImplementation((_cmd, _args, cb) =>
    cb(new Error("execution error: User canceled. (-128)")),
  );
  await withPlatform("darwin", async () => {
    expect(await pickFolderNative()).toBe("");
  });
});

test("pickFolderNative rejects a genuine osascript error", async () => {
  execFile.mockImplementation((_cmd, _args, cb) => cb(new Error("osascript: command not found")));
  await withPlatform("darwin", async () => {
    await expect(pickFolderNative()).rejects.toThrow(/command not found/);
  });
});
