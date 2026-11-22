import { describe, expect, it } from "vitest";
import { EnvValidationError, getPlainHttpWarning, parseEnv } from "@/server/env";

const validKey = Buffer.alloc(32, 1).toString("base64");
const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  GATEWAY_ENCRYPTION_KEY: validKey,
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD: "hunter2-super-secret",
};

describe("parseEnv", () => {
  it("applies defaults for optional variables", () => {
    const env = parseEnv(valid);
    expect(env.MEDIA_STORAGE_DIR).toBe("/data/media");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.PUBLIC_BASE_URL).toBeUndefined();
    expect(env.GATEWAY_DOMAIN).toBeUndefined();
  });

  it("treats empty optional values as unset", () => {
    const env = parseEnv({ ...valid, PUBLIC_BASE_URL: "", LOG_LEVEL: "", MEDIA_STORAGE_DIR: "" });
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.MEDIA_STORAGE_DIR).toBe("/data/media");
  });

  it("reports missing required variables by name", () => {
    try {
      parseEnv({ ...valid, DATABASE_URL: "", ADMIN_USERNAME: undefined });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).missing.sort()).toEqual([
        "ADMIN_USERNAME",
        "DATABASE_URL",
      ]);
    }
  });

  it("flags malformed encryption keys without echoing values", () => {
    try {
      parseEnv({ ...valid, GATEWAY_ENCRYPTION_KEY: "dG9vLXNob3J0" });
      expect.unreachable();
    } catch (error) {
      const failure = error as EnvValidationError;
      expect(failure.invalid).toEqual(["GATEWAY_ENCRYPTION_KEY"]);
      expect(failure.message).not.toContain("dG9vLXNob3J0");
    }
  });

  it("never includes secret values in the error message", () => {
    try {
      parseEnv({ ...valid, DATABASE_URL: "mysql://u:topsecret@host/db" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("topsecret");
      expect((error as Error).message).toContain("DATABASE_URL");
    }
  });

  it("rejects an unknown LOG_LEVEL and a relative PUBLIC_BASE_URL", () => {
    expect(() => parseEnv({ ...valid, LOG_LEVEL: "chatty" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...valid, PUBLIC_BASE_URL: "gateway.example.com" })).toThrow(
      EnvValidationError,
    );
  });
});

describe("getPlainHttpWarning", () => {
  it("warns on http:// with a public host", () => {
    expect(getPlainHttpWarning({ PUBLIC_BASE_URL: "http://gateway.example.com" })).toMatch(
      /plain HTTP|plain http/,
    );
  });

  it("does not warn for https, loopback or unset", () => {
    expect(getPlainHttpWarning({ PUBLIC_BASE_URL: "https://gateway.example.com" })).toBeUndefined();
    expect(getPlainHttpWarning({ PUBLIC_BASE_URL: "http://localhost:3000" })).toBeUndefined();
    expect(getPlainHttpWarning({ PUBLIC_BASE_URL: "http://127.0.0.1:3000" })).toBeUndefined();
    expect(getPlainHttpWarning({ PUBLIC_BASE_URL: undefined })).toBeUndefined();
  });
});
