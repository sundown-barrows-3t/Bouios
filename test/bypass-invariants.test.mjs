/**
 * bypass-invariants.test.mjs
 *
 * Shell-level invariant tests for the sentinel / enforcement pipeline.
 * Run: node --test test/bypass-invariants.test.mjs
 *
 * Tests:
 *   g1 — pre-tool-enforcement.sh denies D1 reads when sentinel is absent (no auto-arm)
 *   g4 — session-start.sh arms sentinel on HTTP 200 + non-empty body; clears it otherwise
 *   h1 — PostToolUse hook (settings.json) does NOT touch the sentinel (no blanket escape)
 *   h2 — session-start.sh does NOT arm sentinel on HTTP 4xx or empty body
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'bouios-test-'));
  const claude = join(dir, '.claude');
  mkdirSync(claude, { recursive: true });
  return { dir, claude };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ENFORCEMENT_SH = join(REPO_ROOT, '.claude', 'pre-tool-enforcement.sh');
const SESSION_START_SH = join(REPO_ROOT, '.session', 'session-start.sh');
const SETTINGS_JSON = join(REPO_ROOT, '.claude', 'settings.json');

// ---------- g1: pre-tool denies D1 reads without sentinel ----------
test('g1: pre-tool-enforcement denies D1 query when sentinel absent', (t, done) => {
  const { dir, claude } = makeSandbox();

  // Write a minimal enforcement script that honours the sentinel gate
  // We test the REAL script if it exists; skip gracefully if not.
  if (!existsSync(ENFORCEMENT_SH)) {
    t.skip('pre-tool-enforcement.sh not present locally (lives in D1 / ~/.claude at runtime)');
    cleanup(dir);
    done();
    return;
  }

  const input = JSON.stringify({
    tool_name: 'mcp__a7197d33__d1_database_query',
    tool_input: { sql: 'SELECT * FROM rules WHERE domain = "AI"' }
  });

  const result = spawnSync('bash', [ENFORCEMENT_SH], {
    input,
    env: { ...process.env, HOME: dir },
    encoding: 'utf8'
  });

  // Without sentinel the script should exit 2 (deny) and say "not loaded"
  assert.equal(result.status, 2, `Expected exit 2 (deny), got ${result.status}. stderr: ${result.stderr}`);
  assert.match(result.stderr + result.stdout, /not loaded|sentinel|load memory/i,
    'Expected denial message about memory not loaded');

  cleanup(dir);
  done();
});

// ---------- g4: session-start arms sentinel on HTTP 200 ----------
test('g4: session-start.sh arms sentinel on HTTP 200 with body', (t, done) => {
  assert.ok(existsSync(SESSION_START_SH), `session-start.sh missing at ${SESSION_START_SH}`);

  const { dir, claude } = makeSandbox();
  const sentinel = join(claude, 'd1-loaded');
  const tokenFile = join(claude, 'gateway-token');
  writeFileSync(tokenFile, 'test-token');

  // Stub curl to simulate HTTP 200 with body
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'curl'), `#!/bin/bash
args=("$@")
# Find -w flag value to know if this is the status-capture curl
for i in "\${!args[@]}"; do
  if [ "\${args[$i]}" = "-w" ]; then
    echo '{"rules":[],"context":[],"memories":[]}' > "\${args[$((i-1))]}" 2>/dev/null || true
    echo -n "200"
    exit 0
  fi
done
# Hook refresh curls — return dummy content
echo "#!/bin/bash"
exit 0
`, { mode: 0o755 });

  const result = spawnSync('bash', [SESSION_START_SH], {
    env: { ...process.env, HOME: dir, PATH: `${binDir}:${process.env.PATH}` },
    encoding: 'utf8'
  });

  assert.ok(existsSync(sentinel),
    `Sentinel not created after HTTP 200. stdout: ${result.stdout} stderr: ${result.stderr}`);

  cleanup(dir);
  done();
});

// ---------- h1: PostToolUse hook does NOT touch sentinel ----------
test('h1: PostToolUse command in settings.json does not set sentinel', (t, done) => {
  assert.ok(existsSync(SETTINGS_JSON), `settings.json missing at ${SETTINGS_JSON}`);

  const settings = JSON.parse(readFileSync(SETTINGS_JSON, 'utf8'));
  const postHooks = settings?.hooks?.PostToolUse ?? [];

  for (const group of postHooks) {
    for (const hook of (group.hooks ?? [])) {
      const cmd = hook.command ?? '';
      assert.ok(
        !cmd.includes('d1-loaded') && !cmd.includes('touch'),
        `PostToolUse hook must not touch the sentinel. Found: ${cmd}`
      );
    }
  }

  done();
});

// ---------- h2: session-start clears sentinel on non-200 ----------
test('h2: session-start.sh clears sentinel on HTTP 403', (t, done) => {
  assert.ok(existsSync(SESSION_START_SH), `session-start.sh missing at ${SESSION_START_SH}`);

  const { dir, claude } = makeSandbox();
  const sentinel = join(claude, 'd1-loaded');
  const tokenFile = join(claude, 'gateway-token');
  writeFileSync(tokenFile, 'test-token');
  // Pre-arm sentinel to verify it gets cleared
  writeFileSync(sentinel, '');

  // Stub curl to simulate HTTP 403
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'curl'), `#!/bin/bash
args=("$@")
for i in "\${!args[@]}"; do
  if [ "\${args[$i]}" = "-w" ]; then
    echo -n "403"
    exit 0
  fi
done
exit 1
`, { mode: 0o755 });

  const result = spawnSync('bash', [SESSION_START_SH], {
    env: { ...process.env, HOME: dir, PATH: `${binDir}:${process.env.PATH}` },
    encoding: 'utf8'
  });

  assert.ok(!existsSync(sentinel),
    `Sentinel should be cleared after HTTP 403. stdout: ${result.stdout} stderr: ${result.stderr}`);

  cleanup(dir);
  done();
});
