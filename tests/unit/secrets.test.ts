import { describe, expect, it } from "vitest";
import {
  decryptSecretWithKey,
  encryptSecretWithKey,
  generateEncryptionKey,
  maskSecret,
  parseEncryptionKey,
} from "@/server/crypto/secrets";

const key = generateEncryptionKey();

describe("secrets", () => {
  it("generates 32-byte base64 keys", () => {
    expect(parseEncryptionKey(generateEncryptionKey())).toHaveLength(32);
  });

  it("round-trips plaintext including unicode", () => {
    const plaintext = "sk-test-é中文-1234";
    expect(decryptSecretWithKey(encryptSecretWithKey(plaintext, key), key)).toBe(plaintext);
  });

  it("uses the versioned v1:iv:tag:ciphertext format with a 12-byte IV", () => {
    const blob = encryptSecretWithKey("hello", key);
    const [version, iv, tag, ciphertext] = blob.split(":");
    expect(version).toBe("v1");
    expect(Buffer.from(iv, "base64")).toHaveLength(12);
    expect(Buffer.from(tag, "base64")).toHaveLength(16);
    expect(ciphertext.length).toBeGreaterThan(0);
  });

  it("uses a fresh random IV each time", () => {
    expect(encryptSecretWithKey("same", key)).not.toBe(encryptSecretWithKey("same", key));
  });

  it("detects tampered ciphertext", () => {
    const [version, iv, tag, ciphertext] = encryptSecretWithKey("hello world", key).split(":");
    const bytes = Buffer.from(ciphertext, "base64");
    bytes[0] ^= 0xff;
    const tampered = [version, iv, tag, bytes.toString("base64")].join(":");
    expect(() => decryptSecretWithKey(tampered, key)).toThrow();
  });

  it("detects a tampered auth tag", () => {
    const [version, iv, tag, ciphertext] = encryptSecretWithKey("hello world", key).split(":");
    const bytes = Buffer.from(tag, "base64");
    bytes[0] ^= 0xff;
    expect(() =>
      decryptSecretWithKey([version, iv, bytes.toString("base64"), ciphertext].join(":"), key),
    ).toThrow();
  });

  it("fails with the wrong key", () => {
    const blob = encryptSecretWithKey("hello", key);
    expect(() => decryptSecretWithKey(blob, generateEncryptionKey())).toThrow();
  });

  it("rejects unknown versions and malformed blobs", () => {
    expect(() => decryptSecretWithKey("v2:a:b:c", key)).toThrow(/format/);
    expect(() => decryptSecretWithKey("garbage", key)).toThrow(/format/);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encryptSecretWithKey("x", Buffer.alloc(16).toString("base64"))).toThrow(
      /32 bytes/,
    );
    expect(() => parseEncryptionKey("not base64!!")).toThrow();
  });
});

describe("maskSecret", () => {
  it("keeps a short separator-terminated prefix and the last 4 characters", () => {
    expect(maskSecret("sk-abcdefghijklmnopa1b2")).toBe("sk-…a1b2");
  });

  it("shows no prefix when there is no separator in the first 4 characters", () => {
    expect(maskSecret("AIzaSyABCDEFGHIJ1234")).toBe("…1234");
  });

  it("fully masks short secrets", () => {
    expect(maskSecret("short")).toBe("•".repeat(8));
    expect(maskSecret("")).toBe("•".repeat(8));
  });

  it("never contains the middle of the secret", () => {
    expect(maskSecret("sk-proj-MIDDLEPARTSECRET-9z8y")).not.toContain("MIDDLE");
  });
});
