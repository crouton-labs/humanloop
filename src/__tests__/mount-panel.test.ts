import { mountPanel } from '../index.js';
import type { Deck, InteractionResponse } from '../index.js';
import type { Key } from '../tui/terminal.js';
import assert from 'node:assert/strict';

// ── helpers ───────────────────────────────────────────────────────────────────

function mkKey(partial: Partial<Key>): Key {
  return {
    ctrl: false,
    upArrow: false,
    downArrow: false,
    return: false,
    escape: false,
    tab: false,
    backspace: false,
    ...partial,
  };
}

const RETURN = mkKey({ return: true });
const ESCAPE = mkKey({ escape: true });

// ── fixtures ──────────────────────────────────────────────────────────────────

const deckA: Deck = {
  title: 'Smoke Deck',
  interactions: [
    {
      id: 'q1',
      title: 'Use Postgres',
      subtitle: 'over SQLite',
      options: [
        { id: 'approve', label: 'Approve', shortcut: 'a' },
        { id: 'reject', label: 'Reject', shortcut: 'x' },
      ],
      allowFreetext: true,
    },
    {
      id: 'q2',
      title: 'Migration tool',
      options: [
        { id: 'prisma', label: 'Prisma', shortcut: 'p' },
        { id: 'drizzle', label: 'Drizzle', shortcut: 'd' },
        { id: 'raw', label: 'raw SQL', shortcut: 's' },
      ],
    },
  ],
};

// ── Test 1: render contains deck title or first interaction title ──────────────

const panel = mountPanel({ deck: deckA, cols: 80, rows: 24 });
const lines = panel.render();
const joined = lines.join('\n');
assert.ok(
  joined.includes('Decisions') || joined.includes('Smoke Deck'),
  'render must include deck title or header',
);
assert.ok(joined.includes('Use Postgres'), 'render must include first interaction title');

// ── Test 2: unmount does not throw; subsequent render returns empty array ──────

panel.unmount();
const postUnmount = panel.render();
assert.deepEqual(postUnmount, [], 'render after unmount returns empty array');

// ── Test 3: prevFrame isolation across two concurrent mounts ──────────────────

const panelA = mountPanel({ deck: deckA, cols: 80, rows: 24 });
const panelB = mountPanel({ deck: deckA, cols: 40, rows: 12 });
const linesA1 = panelA.render();
const linesB1 = panelB.render();
panelA.handleResize(80, 24);
panelB.handleResize(40, 12);
const linesA2 = panelA.render();
const linesB2 = panelB.render();
assert.deepEqual(linesA1, linesA2, 'panel A render is stable across panel B activity');
assert.deepEqual(linesB1, linesB2, 'panel B render is stable across panel A activity');
assert.notDeepEqual(linesA1, linesB1, 'two panels with different geometry produce different output');
panelA.unmount();
panelB.unmount();

// ── Test 4: v2 round-trip ─────────────────────────────────────────────────────

const roundTripDeck: Deck = {
  interactions: [
    {
      id: 'i1', title: 'Review PR',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }, { id: 'reject', label: 'Reject', shortcut: 'r' }],
      allowFreetext: true,
      kind: 'validation',
    },
    {
      id: 'i2', title: 'Pick ORM',
      options: [{ id: 'opt-0', label: 'Prisma', shortcut: 'p' }, { id: 'opt-1', label: 'Drizzle', shortcut: 'd' }],
      allowFreetext: true,
      kind: 'decision',
    },
    {
      id: 'i3', title: 'Rate limit',
      options: [],
      allowFreetext: true,
      kind: 'context',
    },
  ],
};

// ── v2 round-trip proper flow ─────────────────────────────────────────────────
let capturedResponses2: InteractionResponse[] = [];
const rtPanel2 = mountPanel({
  deck: roundTripDeck,
  cols: 80,
  rows: 40,
  onComplete: (responses) => { capturedResponses2 = responses; },
});

// overview -> item-review
rtPanel2.handleKey('', RETURN);

// i1: cursor lands on 'approve' (selectedAction=0). Press 'c' → enters comment
// mode WITH 'approve' pre-attached. Type freely (letters never trigger shortcuts).
// Enter submits {selectedOptionId: 'approve', freetext: 'looks good'}.
rtPanel2.handleKey('c', mkKey({})); // enter comment mode w/ 'approve' pre-attached
for (const ch of 'looks good') {
  rtPanel2.handleKey(ch, mkKey({}));
}
rtPanel2.handleKey('', RETURN); // commit option + comment

// Now at i2: press 'd' for Drizzle
rtPanel2.handleKey('d', mkKey({}));

// Now at i3 (freetext-only): press 'r' to open freetext mode
rtPanel2.handleKey('r', mkKey({}));
// Type response
for (const ch of 'rate-limit at 5 rps') {
  rtPanel2.handleKey(ch, mkKey({}));
}
// Submit with enter
rtPanel2.handleKey('', RETURN);
// Now in final phase, press enter to complete
rtPanel2.handleKey('', RETURN);

assert.deepEqual(capturedResponses2, [
  { id: 'i1', selectedOptionId: 'approve', freetext: 'looks good' },
  { id: 'i2', selectedOptionId: 'opt-1' },
  { id: 'i3', freetext: 'rate-limit at 5 rps' },
], 'v2 round-trip responses must match expected');

// ── Test 5: loadDeck smoke ────────────────────────────────────────────────────

const deckB: Deck = {
  title: 'Deck B',
  interactions: [
    { id: 'b1', title: 'First B item', options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }] },
    { id: 'b2', title: 'Second B item', options: [] , allowFreetext: true },
  ],
};

const loadDeckPanel = mountPanel({ deck: deckA, cols: 80, rows: 24 });
const beforeLoad = loadDeckPanel.render().join('\n');
assert.ok(beforeLoad.includes('Use Postgres'), 'before loadDeck: deck A title visible');

loadDeckPanel.loadDeck(deckB);
const afterLoad = loadDeckPanel.render().join('\n');
assert.ok(!afterLoad.includes('Use Postgres'), 'after loadDeck: deck A title gone');
assert.ok(afterLoad.includes('First B item'), 'after loadDeck: deck B first interaction visible');
assert.ok(afterLoad.includes('1/2') || afterLoad.includes('0/2'), 'after loadDeck: position counter reflects deck B');
loadDeckPanel.unmount();

// ── Test 6: canAcceptHostKeys matrix ─────────────────────────────────────────

const deckSingle: Deck = {
  interactions: [
    {
      id: 's1', title: 'Single item',
      options: [{ id: 'opt', label: 'Option', shortcut: 'o' }],
      allowFreetext: true,
    },
    {
      id: 's2', title: 'Second item',
      options: [{ id: 'opt2', label: 'Option2', shortcut: 'o' }],
    },
  ],
};

const ckPanel = mountPanel({ deck: deckSingle, cols: 80, rows: 24 });
assert.equal(ckPanel.canAcceptHostKeys(), true, 'initially (overview): canAcceptHostKeys true');

// overview -> item-review
ckPanel.handleKey('', RETURN);
assert.equal(ckPanel.canAcceptHostKeys(), true, 'item-review without input mode: canAcceptHostKeys true');

// enter comment mode
ckPanel.handleKey('c', mkKey({}));
assert.equal(ckPanel.canAcceptHostKeys(), false, 'in comment input mode: canAcceptHostKeys false');

// cancel
ckPanel.handleKey('', ESCAPE);
assert.equal(ckPanel.canAcceptHostKeys(), true, 'after esc: canAcceptHostKeys true');

// answer both interactions to reach final phase
ckPanel.handleKey('o', mkKey({})); // selects option for s1, advances to s2
ckPanel.handleKey('o', mkKey({})); // selects option for s2, advances to final

// Should be in final phase now — canAcceptHostKeys still true
assert.equal(ckPanel.canAcceptHostKeys(), true, 'final phase: canAcceptHostKeys true');

ckPanel.unmount();
assert.equal(ckPanel.canAcceptHostKeys(), false, 'after unmount: canAcceptHostKeys false');

// ── Test 7: empty Enter in freetext-only mode records response and completes ────
// Regression for: empty buffer caused truthy guard to skip submitOption, so
// responses.size < interactions.length forever and onComplete never fired.

const freetextOnlyDeck: Deck = {
  interactions: [
    { id: 'q1', title: 'Optional notes', options: [], allowFreetext: true },
  ],
};

let capturedFreetextEmpty: InteractionResponse[] = [];
const ftPanel = mountPanel({
  deck: freetextOnlyDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedFreetextEmpty = responses; },
});

// overview → item-review
ftPanel.handleKey('', RETURN);
// Enter input mode ('r' opens freetext)
ftPanel.handleKey('r', mkKey({}));
// Submit with empty buffer (no typing)
ftPanel.handleKey('', RETURN);
// Final phase: press Enter to complete
ftPanel.handleKey('', RETURN);

assert.deepEqual(
  capturedFreetextEmpty,
  [{ id: 'q1', freetext: '' }],
  'empty freetext Enter must record response and fire onComplete',
);
ftPanel.unmount();

// ── Test 8: empty Enter in comment mode (allowFreetext + options) records response ─

const commentDeck: Deck = {
  interactions: [
    {
      id: 'c1', title: 'Approve deploy?',
      options: [{ id: 'yes', label: 'Yes', shortcut: 'y' }],
      allowFreetext: true,
    },
  ],
};

let capturedCommentEmpty: InteractionResponse[] = [];
const cmPanel = mountPanel({
  deck: commentDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedCommentEmpty = responses; },
});

// overview → item-review
cmPanel.handleKey('', RETURN);
// Navigate to [c] row to enter comment mode WITHOUT pre-attaching an option
cmPanel.handleKey('j', mkKey({}));
// Enter comment mode (no option attached — cursor on [c] row)
cmPanel.handleKey('c', mkKey({}));
// Submit empty comment via Enter (no option selected)
cmPanel.handleKey('', RETURN);
// Final phase: press Enter to complete
cmPanel.handleKey('', RETURN);

assert.deepEqual(
  capturedCommentEmpty,
  [{ id: 'c1', freetext: '' }],
  'empty Enter in comment mode must record response and fire onComplete',
);
cmPanel.unmount();

// ── Test 9: option-shortcut letters in comment mode are typed, not shortcuts ──
// Regression: pressing 'y' or 'n' (or any option shortcut) while in comment mode
// must append to the buffer, never submit the option.

const shortcutTypingDeck: Deck = {
  interactions: [
    {
      id: 'q1', title: 'Approve?',
      options: [
        { id: 'yes', label: 'Yes', shortcut: 'y' },
        { id: 'no', label: 'No', shortcut: 'n' },
      ],
      allowFreetext: true,
    },
  ],
};

let capturedShortcutTyping: InteractionResponse[] = [];
const stPanel = mountPanel({
  deck: shortcutTypingDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedShortcutTyping = responses; },
});

// overview → item-review
stPanel.handleKey('', RETURN);
// Navigate to [c] row so 'c' enters comment mode without pre-attaching an option
stPanel.handleKey('j', mkKey({}));
stPanel.handleKey('j', mkKey({}));
// Enter comment mode (no option attached)
stPanel.handleKey('c', mkKey({}));
// Type 'yes no' — both 'y' and 'n' are option shortcuts; must go to buffer.
for (const ch of 'yes no') {
  stPanel.handleKey(ch, mkKey({}));
}
// Submit comment via Enter — must NOT have selectedOptionId
stPanel.handleKey('', RETURN);
stPanel.handleKey('', RETURN); // final → complete

assert.deepEqual(
  capturedShortcutTyping,
  [{ id: 'q1', freetext: 'yes no' }],
  'option-shortcut letters typed in comment mode must append to buffer, not select option',
);
stPanel.unmount();

// ── Test 10: 'c' from option row pre-attaches that option ─────────────────────

const attachDeck: Deck = {
  interactions: [
    {
      id: 'a1', title: 'Approve?',
      options: [
        { id: 'yes', label: 'Yes', shortcut: 'y' },
        { id: 'no', label: 'No', shortcut: 'n' },
      ],
      allowFreetext: true,
    },
  ],
};

let capturedAttach: InteractionResponse[] = [];
const atPanel = mountPanel({
  deck: attachDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedAttach = responses; },
});

atPanel.handleKey('', RETURN); // overview → item-review (selectedAction = 0, on 'yes' row)
atPanel.handleKey('c', mkKey({})); // enter comment with 'yes' pre-attached
for (const ch of 'lgtm') atPanel.handleKey(ch, mkKey({}));
atPanel.handleKey('', RETURN); // submit
atPanel.handleKey('', RETURN); // final → complete

assert.deepEqual(
  capturedAttach,
  [{ id: 'a1', selectedOptionId: 'yes', freetext: 'lgtm' }],
  "'c' from option row must pre-attach that option to the comment",
);
atPanel.unmount();

// ── Test 11: Tab cycles attached option in comment mode ───────────────────────

let capturedTab: InteractionResponse[] = [];
const tabPanel = mountPanel({
  deck: attachDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedTab = responses; },
});

tabPanel.handleKey('', RETURN); // overview → item-review
// Navigate cursor to [c] row (selectedAction = 2 — past both option rows)
tabPanel.handleKey('j', mkKey({}));
tabPanel.handleKey('j', mkKey({}));
tabPanel.handleKey('c', mkKey({})); // enter comment, no option attached
for (const ch of 'meh') tabPanel.handleKey(ch, mkKey({}));
// Tab once: attaches first option ('yes')
tabPanel.handleKey('', mkKey({ tab: true }));
// Tab again: cycles to 'no'
tabPanel.handleKey('', mkKey({ tab: true }));
// Tab again: cycles back to none
tabPanel.handleKey('', mkKey({ tab: true }));
// Tab once more: 'yes'
tabPanel.handleKey('', mkKey({ tab: true }));
tabPanel.handleKey('', RETURN); // submit with 'yes' attached
tabPanel.handleKey('', RETURN); // final → complete

assert.deepEqual(
  capturedTab,
  [{ id: 'a1', selectedOptionId: 'yes', freetext: 'meh' }],
  'Tab in comment mode must cycle attached option (none → opt1 → opt2 → none)',
);
tabPanel.unmount();

console.log('OK');
