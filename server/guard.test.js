import test from "node:test";
import assert from "node:assert/strict";
import { allowedHosts, checkRequest } from "./guard.js";

const hosts = allowedHosts({});
const req = over => ({ method: "GET", host: "127.0.0.1:3000", origin: undefined, contentType: undefined, ...over });

test("local names are allowed, anything else is not (DNS rebinding)", () => {
  for (const host of ["127.0.0.1:3000", "localhost:3000", "[::1]:3000", "LOCALHOST"]) assert.equal(checkRequest(req({ host }), hosts), null);
  for (const host of ["evil.example:3000", "127.0.0.1.evil.example", "", undefined])
    assert.equal(checkRequest(req({ host }), hosts)?.status, 403);
});

test("extra names come from HOST and O2RING_ALLOWED_HOSTS; 0.0.0.0 adds nothing", () => {
  assert.ok(allowedHosts({ HOST: "192.168.1.20" }).has("192.168.1.20"));
  assert.ok(allowedHosts({ HOST: "0.0.0.0", O2RING_ALLOWED_HOSTS: "nas.lan, 10.0.0.5" }).has("nas.lan"));
  assert.equal(allowedHosts({ HOST: "0.0.0.0" }).size, 3);
});

test("writes must be JSON and same-origin", () => {
  const post = over => req({ method: "POST", contentType: "application/json", ...over });
  assert.equal(checkRequest(post({ origin: "http://127.0.0.1:3000" }), hosts), null);
  assert.equal(checkRequest(post({}), hosts), null);                                        // curl / scripts send no Origin
  assert.equal(checkRequest(post({ contentType: undefined }), hosts)?.status, 415);         // body-less cross-site form POST
  assert.equal(checkRequest(post({ contentType: "text/plain" }), hosts)?.status, 415);
  assert.equal(checkRequest(post({ contentType: "application/x-www-form-urlencoded" }), hosts)?.status, 415);
  assert.equal(checkRequest(post({ origin: "https://evil.example" }), hosts)?.status, 403);
  assert.equal(checkRequest(post({ origin: "null" }), hosts)?.status, 403);
  assert.equal(checkRequest(req({ method: "PUT", contentType: "application/json; charset=utf-8" }), hosts), null);
});
