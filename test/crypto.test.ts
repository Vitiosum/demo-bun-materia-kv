import { describe, expect, test } from "bun:test";
import { ID_PATTERN, lookupHash, newId, seal, unseal } from "../src/crypto";

describe("one-time ids and sealing", () => {
  test("ids are 128-bit base64url and never repeat", () => {
    const ids = new Set(Array.from({ length: 2000 }, newId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(ID_PATTERN);
  });

  test("the KV key is a hash that does not contain the id", () => {
    const id = newId();
    const hash = lookupHash(id);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toBe(lookupHash(id));
    expect(hash).not.toContain(id);
  });

  test("seal and unseal round-trip, ciphertext hides the message", async () => {
    const id = newId();
    const message = "Meet at dawn. <b>Bring the map</b> & the key: é漢🙂";
    const sealed = await seal(id, message);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("dawn");
    expect(await unseal(id, sealed)).toBe(message);
  });

  test("another link cannot open the message", async () => {
    const sealed = await seal(newId(), "for your eyes only");
    await expect(unseal(newId(), sealed)).rejects.toThrow();
  });
});
