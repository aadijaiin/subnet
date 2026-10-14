import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { proof, verifyProof } from '../src/protocol/crypto.js';
import { FrameDecoder, frame, jsonFrame, parseEnvelope } from '../src/protocol/framing.js';
import { uniqueNick } from '../src/engine/nick.js';
import { tokenize } from '../src/tui/commands.js';
import { stripControl } from '../src/tui/lines.js';
import { safeName } from '../src/transfer/TransferService.js';
import { parseDuration } from '../src/util/format.js';

describe('framing', () => {
  it('reassembles frames split at arbitrary byte boundaries', () => {
    const wire = Buffer.concat([jsonFrame('msg', { text: 'héllo' }), frame(Buffer.alloc(0)), jsonFrame('ping', { ts: 1 })]);
    for (let step = 1; step <= 7; step++) {
      const dec = new FrameDecoder();
      const out: Buffer[] = [];
      for (let i = 0; i < wire.length; i += step) out.push(...dec.push(wire.subarray(i, i + step)));
      assert.equal(out.length, 3);
      assert.deepEqual(parseEnvelope(out[0]), { t: 'msg', d: { text: 'héllo' } });
      assert.equal(out[1].length, 0);
      assert.equal(parseEnvelope(out[2]).t, 'ping');
    }
  });

  it('rejects oversized frames', () => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(10_000_000);
    assert.throws(() => new FrameDecoder().push(head), /too large/);
  });
});

describe('security helpers', () => {
  it('verifies passcode proofs', () => {
    assert.ok(verifyProof('pw', 'nonce', proof('pw', 'nonce')));
    assert.ok(!verifyProof('pw', 'nonce', proof('nope', 'nonce')));
    assert.ok(!verifyProof('pw', 'nonce', undefined));
  });

  it('neutralises hostile filenames', () => {
    assert.equal(safeName('../../etc/passwd'), 'passwd');
    assert.equal(safeName('..\\..\\win.ini'), 'win.ini');
    assert.equal(safeName('.bashrc'), 'bashrc');
    assert.equal(safeName(''), 'file');
  });

  it('strips terminal escape sequences from remote text', () => {
    assert.equal(stripControl('hi\x1b[2J\x1b]0;pwned\x07 there\x07'), 'hi there');
  });
});

describe('nicknames', () => {
  it('assigns the next free suffix, case-insensitively', () => {
    assert.equal(uniqueNick('bob', []), 'bob');
    assert.equal(uniqueNick('Bob', ['bob']), 'Bob-2');
    assert.equal(uniqueNick('bob', ['bob', 'BOB-2']), 'bob-3');
    assert.equal(uniqueNick('  ', []), 'anon');
  });
});

describe('command parsing', () => {
  it('handles quotes and drag-and-drop escaped spaces', () => {
    assert.deepEqual(tokenize('/send /Users/me/My\\ File.png @bob'), ['/send', '/Users/me/My File.png', '@bob']);
    assert.deepEqual(tokenize(`a "b c" 'd e' ""`), ['a', 'b c', 'd e', '']);
  });

  it('parses durations', () => {
    assert.equal(parseDuration('30m'), 1_800_000);
    assert.equal(parseDuration('1h30m'), 5_400_000);
    assert.equal(parseDuration('soon'), null);
  });
});
