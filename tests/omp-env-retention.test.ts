import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { hasEnv, legacyPiEnvName, readEnv } from "../src/common.ts";
import {
  captureCacheRetentionEnv,
  readCacheRetentionValue,
  requestLongCacheRetention,
  restoreCacheRetentionEnv,
  userRequestedLongCacheRetention,
} from "../src/retention.ts";
import { footerStatsMode, isEnabledEnv, isStatsIncrementalEnabled, resolveFooterStatsMode } from "../src/config.ts";

// OMP 的缓存保留环境变量真值表（OMP_CACHE_RETENTION 为主，镜像 PI_CACHE_RETENTION 供宿主读取）
// 与 OMP_/PI_ 前缀读取规则。全部用显式 env 对象，不碰 process.env。

type Env = Record<string, string | undefined>;
const OMP = "OMP_CACHE_RETENTION";
const PI = "PI_CACHE_RETENTION";

function run(initial: Env): Env {
  const env = { ...initial };
  requestLongCacheRetention(env);
  return env;
}

describe("requestLongCacheRetention truth table", () => {
  test("OMP valid: written to OMP and mirrored to PI (overriding a different PI)", () => {
    assert.deepEqual(run({ [OMP]: "long" }), { [OMP]: "long", [PI]: "long" });
    assert.deepEqual(run({ [OMP]: "short" }), { [OMP]: "short", [PI]: "short" });
    assert.deepEqual(run({ [OMP]: "none" }), { [OMP]: "none", [PI]: "none" });
    assert.deepEqual(run({ [OMP]: " short ", [PI]: "long" }), { [OMP]: "short", [PI]: "short" }, "trimmed, OMP wins over PI");
  });

  test("OMP empty and PI valid: both take the PI value", () => {
    assert.deepEqual(run({ [PI]: "short" }), { [OMP]: "short", [PI]: "short" });
    assert.deepEqual(run({ [PI]: "none" }), { [OMP]: "none", [PI]: "none" });
    assert.deepEqual(run({ [OMP]: "", [PI]: "short" }), { [OMP]: "short", [PI]: "short" });
    assert.deepEqual(run({ [OMP]: "   ", [PI]: " long " }), { [OMP]: "long", [PI]: "long" });
  });

  test("both empty: default to long on both (an explicit short/none is never overridden)", () => {
    assert.deepEqual(run({}), { [OMP]: "long", [PI]: "long" });
    assert.deepEqual(run({ [OMP]: "", [PI]: "" }), { [OMP]: "long", [PI]: "long" });
    assert.deepEqual(run({ [OMP]: "  ", [PI]: undefined }), { [OMP]: "long", [PI]: "long" });
  });

  test("an invalid first non-empty candidate leaves both variables untouched", () => {
    const invalidOmp = { [OMP]: "forever", [PI]: "short" };
    assert.deepEqual(run(invalidOmp), invalidOmp, "invalid OMP, valid PI");
    const invalidPi = { [PI]: "forever" } as Env;
    assert.deepEqual(run(invalidPi), invalidPi, "OMP empty, invalid PI");
    const bothInvalid = { [OMP]: "LONG", [PI]: "x" };
    assert.deepEqual(run(bothInvalid), bothInvalid, "values are case-sensitive");
  });

  test("it is idempotent", () => {
    for (const initial of [{}, { [OMP]: "short" }, { [PI]: "none" }, { [OMP]: "bad" }] as Env[]) {
      const once = run(initial);
      assert.deepEqual(run(once), once);
    }
  });
});

describe("retention snapshot and restore", () => {
  test("captureCacheRetentionEnv records presence and value of both variables", () => {
    assert.deepEqual(captureCacheRetentionEnv({}), { ompWasSet: false, ompValue: undefined, piWasSet: false, piValue: undefined });
    assert.deepEqual(captureCacheRetentionEnv({ [OMP]: "short", [PI]: "long" }), { ompWasSet: true, ompValue: "short", piWasSet: true, piValue: "long" });
    assert.equal(captureCacheRetentionEnv({ [PI]: "" }).piWasSet, true, "an empty string still counts as set");
  });

  test("restore returns each variable to its startup state, including 'was not set'", () => {
    const cases: Env[] = [
      {},
      { [OMP]: "short" },
      { [PI]: "none" },
      { [OMP]: "short", [PI]: "long" },
      { [OMP]: "bogus" },
      { [PI]: "" },
    ];
    for (const initial of cases) {
      const snapshot = captureCacheRetentionEnv(initial);
      const env = { ...initial };
      requestLongCacheRetention(env);
      restoreCacheRetentionEnv(snapshot, env);
      assert.deepEqual(env, initial, `restore of ${JSON.stringify(initial)}`);
      assert.equal(Object.prototype.hasOwnProperty.call(env, OMP), Object.prototype.hasOwnProperty.call(initial, OMP));
      assert.equal(Object.prototype.hasOwnProperty.call(env, PI), Object.prototype.hasOwnProperty.call(initial, PI));
    }
  });
});

describe("retention readers", () => {
  test("readCacheRetentionValue prefers OMP_ and falls back to PI_", () => {
    assert.equal(readCacheRetentionValue({ [OMP]: "short", [PI]: "long" }), "short");
    assert.equal(readCacheRetentionValue({ [PI]: "long" }), "long");
    assert.equal(readCacheRetentionValue({ [OMP]: "  ", [PI]: "none" }), "none");
    assert.equal(readCacheRetentionValue({}), undefined);
  });

  test("userRequestedLongCacheRetention honors OMP_ first, then PI_, from the startup snapshot", () => {
    const snap = (omp?: string, pi?: string) => ({ ompWasSet: omp !== undefined, ompValue: omp, piWasSet: pi !== undefined, piValue: pi });
    assert.equal(userRequestedLongCacheRetention(snap("long")), true);
    assert.equal(userRequestedLongCacheRetention(snap(undefined, "long")), true, "legacy PI_ counts");
    assert.equal(userRequestedLongCacheRetention(snap("long", "short")), true);
    assert.equal(userRequestedLongCacheRetention(snap("short", "long")), false, "OMP_ is consulted first");
    assert.equal(userRequestedLongCacheRetention(snap("none")), false);
    assert.equal(userRequestedLongCacheRetention(snap(undefined, "short")), false);
    assert.equal(userRequestedLongCacheRetention(snap()), false);
    assert.equal(userRequestedLongCacheRetention(snap(" long ")), true, "trimmed");
    // 快照里没有 wasSet 的值不算用户设置。
    assert.equal(userRequestedLongCacheRetention({ ompWasSet: false, ompValue: "long", piWasSet: false }), false);
  });
});

describe("OMP_ / PI_ environment prefix", () => {
  test("legacyPiEnvName maps only OMP_ names", () => {
    assert.equal(legacyPiEnvName("OMP_CACHE_OPTIMIZER_FOOTER_MODE"), "PI_CACHE_OPTIMIZER_FOOTER_MODE");
    assert.equal(legacyPiEnvName("PI_CACHE_OPTIMIZER_FOOTER_MODE"), undefined);
    assert.equal(legacyPiEnvName("HOME"), undefined);
  });

  test("readEnv: OMP_ wins, PI_ is the fallback, neither gives undefined", () => {
    const name = "OMP_CACHE_OPTIMIZER_X";
    assert.equal(readEnv({ [name]: "omp", PI_CACHE_OPTIMIZER_X: "pi" }, name), "omp");
    assert.equal(readEnv({ PI_CACHE_OPTIMIZER_X: "pi" }, name), "pi");
    assert.equal(readEnv({ [name]: "omp" }, name), "omp");
    assert.equal(readEnv({}, name), undefined);
    assert.equal(readEnv({ PI_CACHE_OPTIMIZER_X: "pi" }, "PI_CACHE_OPTIMIZER_X"), "pi", "a PI_ name is read as is");
    assert.equal(hasEnv({ PI_CACHE_OPTIMIZER_X: "pi" }, name), true);
    assert.equal(hasEnv({}, name), false);
  });

  test("footer mode and kill switches follow the same OMP_-then-PI_ rule", () => {
    assert.deepEqual(resolveFooterStatsMode(undefined, { PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }), { mode: "total", source: "env" });
    assert.deepEqual(resolveFooterStatsMode(undefined, { OMP_CACHE_OPTIMIZER_FOOTER_MODE: "process", PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }), { mode: "process", source: "env" });
    assert.deepEqual(resolveFooterStatsMode("session", { OMP_CACHE_OPTIMIZER_FOOTER_MODE: "total" }), { mode: "session", source: "config" });
    assert.equal(footerStatsMode({ PI_CACHE_OPTIMIZER_FOOTER_MODE: "total" }, undefined), "total");
    assert.equal(footerStatsMode({}, undefined), "session");

    assert.equal(isStatsIncrementalEnabled({ PI_CACHE_OPTIMIZER_STATS_INCREMENTAL: "0" }, { version: 3 }), false);
    assert.equal(isStatsIncrementalEnabled({ OMP_CACHE_OPTIMIZER_STATS_INCREMENTAL: "1", PI_CACHE_OPTIMIZER_STATS_INCREMENTAL: "0" }, { version: 3 }), true);
    assert.equal(isStatsIncrementalEnabled({}, { version: 3 }), true);
  });

  test("isEnabledEnv accepts the usual truthy spellings only", () => {
    for (const value of ["1", "true", "YES", " on "]) assert.equal(isEnabledEnv(value), true, value);
    for (const value of ["0", "off", "", "2", undefined]) assert.equal(isEnabledEnv(value), false, String(value));
  });
});
