import { mountPanel } from '../index.js';
import type { Deck, InteractionResponse } from '../index.js';
import type { Key } from '../tui/terminal.js';
import { parseKeypress } from '../tui/terminal.js';
import assert from 'node:assert/strict';

// ── helpers ───────────────────────────────────────────────────────────────────

function mkKey(partial: Partial<Key>): Key {
  return {
    ctrl: false,
    meta: false,
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
      options: [{ id: 'opt-0', label: 'Prisma', shortcut: 'p' }, { id: 'opt-1', label: 'Drizzle', shortcut: 'z' }],
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

// Now at i2: press 'z' for Drizzle
rtPanel2.handleKey('z', mkKey({}));

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

// Single-item deck starts directly in item-review (no overview). 'r' opens freetext.
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

// Single-item deck starts directly in item-review. Navigate to [c] row WITHOUT pre-attaching.
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

// Single-item deck starts directly in item-review. Navigate to [c] row.
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

// Single-item deck starts directly in item-review (selectedAction = 0, on 'yes' row)
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

// Single-item deck starts directly in item-review. Navigate to [c] row.
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

// ── Test 12: multi-select — Space/shortcut toggle, Enter confirms set ─────────

const multiDeck: Deck = {
  interactions: [
    {
      id: 'ms1', title: 'Pick toppings', multiSelect: true,
      options: [
        { id: 'mush', label: 'Mushroom', shortcut: 'a' },
        { id: 'onion', label: 'Onion', shortcut: 'b' },
        { id: 'olive', label: 'Olive', shortcut: 'x' },
      ],
    },
  ],
};

let capturedMulti: InteractionResponse[] = [];
const msPanel = mountPanel({
  deck: multiDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedMulti = responses; },
});

// Single-item deck starts in item-review, cursor on option 0 ('mush').
msPanel.handleKey(' ', mkKey({}));          // toggle 'mush' on
msPanel.handleKey('j', mkKey({}));          // cursor → 'onion'
msPanel.handleKey(' ', mkKey({}));          // toggle 'onion' on
msPanel.handleKey(' ', mkKey({}));          // toggle 'onion' back off
const midRender = msPanel.render().join('\n');
assert.ok(
  midRender.includes('[x]') && midRender.includes('[ ]'),
  'multi-select must render checked [x] and unchecked [ ] boxes',
);
msPanel.handleKey('x', mkKey({}));          // shortcut toggles 'olive' on (no advance)
msPanel.handleKey('', RETURN);              // confirm set + advance → final
msPanel.handleKey('', RETURN);              // final → complete

assert.deepEqual(
  capturedMulti,
  [{ id: 'ms1', selectedOptionIds: ['mush', 'olive'] }],
  'multi-select must accumulate toggled options and return them as selectedOptionIds',
);
msPanel.unmount();

// ── Test 13: preAnswered seeds responses and renders with ◆ marker ────────────

const preAnsweredDeck: Deck = {
  interactions: [
    {
      id: 'r1', title: 'Carry-over requirement',
      options: [
        { id: 'approve', label: 'Approve', shortcut: 'a' },
        { id: 'reject',  label: 'Reject',  shortcut: 'r' },
      ],
      allowFreetext: true,
      preAnswered: { selectedOptionId: 'approve', label: 'Previously approved' },
    },
    {
      id: 'r2', title: 'Fresh requirement',
      options: [
        { id: 'approve', label: 'Approve', shortcut: 'a' },
        { id: 'reject',  label: 'Reject',  shortcut: 'r' },
      ],
    },
  ],
};

const paPanel = mountPanel({ deck: preAnsweredDeck, cols: 80, rows: 24 });
const paOverview = paPanel.render().join('\n');
assert.ok(
  paOverview.includes('◆'),
  'overview must render ◆ marker for preAnswered interaction',
);
assert.ok(
  paOverview.includes('1/2'),
  'overview must count preAnswered as answered (1/2)',
);
paPanel.unmount();

// ── Test 14: currentIndex starts on first unanswered ──────────────────────────

const skipStartDeck: Deck = {
  interactions: [
    {
      id: 's1', title: 'Carried-1',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
      preAnswered: { selectedOptionId: 'approve' },
    },
    {
      id: 's2', title: 'Carried-2',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
      preAnswered: { selectedOptionId: 'approve' },
    },
    {
      id: 's3', title: 'Needs answer',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
    },
  ],
};

const startPanel = mountPanel({ deck: skipStartDeck, cols: 80, rows: 24 });
// Enter overview → item-review. Cursor should already be on s3 (first unanswered).
startPanel.handleKey('', RETURN);
const startReview = startPanel.render().join('\n');
assert.ok(
  startReview.includes('Needs answer'),
  'cursor lands on first unanswered interaction at mount, not the first preAnswered',
);
assert.ok(
  startReview.includes('3/3'),
  'item-review position counter shows 3/3 — third of three',
);
startPanel.unmount();

// ── Test 15: post-answer submit skips pre-answered, lands on next unanswered ──

const skipMidDeck: Deck = {
  interactions: [
    {
      id: 'm1', title: 'Fresh-1',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
    },
    {
      id: 'm2', title: 'Carried',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
      preAnswered: { selectedOptionId: 'approve' },
    },
    {
      id: 'm3', title: 'Fresh-2',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
    },
  ],
};

let capturedSkip: InteractionResponse[] = [];
const skipMidPanel = mountPanel({
  deck: skipMidDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedSkip = responses; },
});

// overview → item-review on m1 (first unanswered).
skipMidPanel.handleKey('', RETURN);
// Answer m1 with shortcut 'a' — post-submit advance should skip m2, land on m3.
skipMidPanel.handleKey('a', mkKey({}));
const afterFirst = skipMidPanel.render().join('\n');
assert.ok(
  afterFirst.includes('Fresh-2'),
  'after answering m1, post-submit advance must skip preAnswered m2 and land on m3',
);
// Answer m3 with 'a' — should now exit to final.
skipMidPanel.handleKey('a', mkKey({}));
skipMidPanel.handleKey('', RETURN); // final → complete
assert.deepEqual(
  capturedSkip,
  [
    { id: 'm1', selectedOptionId: 'approve' },
    { id: 'm2', selectedOptionId: 'approve' },
    { id: 'm3', selectedOptionId: 'approve' },
  ],
  'preAnswered response carried through to onComplete output',
);
skipMidPanel.unmount();

// ── Test 16: n/p still steps onto pre-answered (no skip) ──────────────────────

const npReachDeck: Deck = {
  interactions: [
    {
      id: 'n1', title: 'Fresh',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
    },
    {
      id: 'n2', title: 'Carried',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
      preAnswered: { selectedOptionId: 'approve', label: 'Previously approved' },
    },
    {
      id: 'n3', title: 'Also fresh',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
    },
  ],
};

const npPanel = mountPanel({ deck: npReachDeck, cols: 80, rows: 24 });
npPanel.handleKey('', RETURN);          // overview → item-review on n1 (first unanswered)
npPanel.handleKey('n', mkKey({}));      // raw 'n' should step to n2 even though it's pre-answered
const onPreAnswered = npPanel.render().join('\n');
assert.ok(
  onPreAnswered.includes('Carried'),
  'raw n must reach the pre-answered interaction (no skip on single-step nav)',
);
assert.ok(
  onPreAnswered.includes('Previously approved'),
  'item-review of pre-answered shows the preAnswered.label marker',
);
npPanel.handleKey('p', mkKey({}));      // raw 'p' steps back to n1
const backToFirst = npPanel.render().join('\n');
assert.ok(
  backToFirst.includes('Fresh') && !backToFirst.includes('Carried'),
  'raw p steps back single-step',
);
npPanel.unmount();

// ── Test 17: user override clears preAnsweredIds and updates response ─────────

const overrideDeck: Deck = {
  interactions: [
    {
      id: 'o1', title: 'Carried, may override',
      options: [
        { id: 'approve', label: 'Approve', shortcut: 'a' },
        { id: 'reject',  label: 'Reject',  shortcut: 'r' },
      ],
      preAnswered: { selectedOptionId: 'approve', label: 'Previously approved' },
    },
    {
      id: 'o2', title: 'Fresh',
      options: [{ id: 'approve', label: 'Approve', shortcut: 'a' }],
    },
  ],
};

let capturedOverride: InteractionResponse[] = [];
const ovPanel = mountPanel({
  deck: overrideDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedOverride = responses; },
});

// Cursor lands on o2 (first unanswered). Step back to o1 with 'p'.
ovPanel.handleKey('', RETURN);
ovPanel.handleKey('p', mkKey({}));
// Override: pick 'reject' via shortcut.
ovPanel.handleKey('r', mkKey({}));
// Post-submit advance lands on o2 (next unanswered).
ovPanel.handleKey('a', mkKey({}));
ovPanel.handleKey('', RETURN); // final → complete

assert.deepEqual(
  capturedOverride,
  [
    { id: 'o1', selectedOptionId: 'reject' },
    { id: 'o2', selectedOptionId: 'approve' },
  ],
  'user override of preAnswered must replace the seeded selectedOptionId',
);
ovPanel.unmount();

// ── Test 18: multi-select per-option comments via 'c' on focused option ──────
// 'c' on a focused option enters comment mode pre-attached to that option;
// Enter saves to optionComments[id], auto-checks the option, stays on the same
// interaction so further options can be commented. The [c] freetext row still
// produces an overall comment.

const optCommentDeck: Deck = {
  interactions: [
    {
      id: 'oc1', title: 'Pick toppings (with notes)', multiSelect: true,
      allowFreetext: true,
      options: [
        { id: 'mush', label: 'Mushroom', shortcut: 'a' },
        { id: 'onion', label: 'Onion', shortcut: 'b' },
        { id: 'olive', label: 'Olive', shortcut: 'x' },
      ],
    },
  ],
};

let capturedOpt: InteractionResponse[] = [];
const ocPanel = mountPanel({
  deck: optCommentDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { capturedOpt = responses; },
});

// Single-item deck starts in item-review, cursor on 'mush'.
// 'c' on 'mush' → enter comment mode pre-attached.
ocPanel.handleKey('c', mkKey({}));
ocPanel.handleKey('y', mkKey({}));
ocPanel.handleKey('u', mkKey({}));
ocPanel.handleKey('m', mkKey({}));
ocPanel.handleKey('', RETURN); // save per-option comment, auto-check 'mush'
// Should still be on the same interaction, NOT advanced to final.
const afterOptComment = ocPanel.render().join('\n');
assert.ok(
  afterOptComment.includes('Pick toppings'),
  'after submitting a per-option comment, stay on the same interaction',
);
assert.ok(
  afterOptComment.includes('yum'),
  'per-option comment renders inline under the option',
);
// Move cursor to 'onion' and comment without auto-checking via different path:
ocPanel.handleKey('j', mkKey({})); // cursor → 'onion'
ocPanel.handleKey('c', mkKey({}));
ocPanel.handleKey('m', mkKey({}));
ocPanel.handleKey('e', mkKey({}));
ocPanel.handleKey('h', mkKey({}));
ocPanel.handleKey('', RETURN); // save + auto-check 'onion'
// Now confirm the multi-select set with Enter on a checked option row.
// Cursor is still on 'onion'. Enter confirms accumulated set + advances.
ocPanel.handleKey('', RETURN); // commit multi → advance to final
ocPanel.handleKey('', RETURN); // final → complete

assert.deepEqual(
  capturedOpt,
  [{
    id: 'oc1',
    selectedOptionIds: ['mush', 'onion'],
    optionComments: { mush: 'yum', onion: 'meh' },
  }],
  'per-option comments accumulate under optionComments and auto-check their options',
);
ocPanel.unmount();

// ── Test 19: multi-select requires explicit confirm (no auto-finalize on 1st Enter) ──
// Regression for: a single-interaction multiSelect deck auto-finalized the
// instant the set was confirmed, with no Summary/confirm pause. Now the first
// Enter lands on the Summary screen; a second deliberate Enter submits.

const confirmDeck: Deck = {
  interactions: [
    {
      id: 'cs1', title: 'Pick toppings', multiSelect: true,
      options: [
        { id: 'mush', label: 'Mushroom', shortcut: 'a' },
        { id: 'onion', label: 'Onion', shortcut: 'b' },
      ],
    },
  ],
};

let confirmFired = false;
let confirmResponses: InteractionResponse[] = [];
const confirmPanel = mountPanel({
  deck: confirmDeck,
  cols: 80,
  rows: 24,
  onComplete: (responses) => { confirmFired = true; confirmResponses = responses; },
});

// Single-item deck starts in item-review, cursor on 'mush'.
confirmPanel.handleKey(' ', mkKey({})); // toggle 'mush' on
confirmPanel.handleKey('', RETURN);     // confirm set → lands on Summary, must NOT finalize
assert.equal(
  confirmFired,
  false,
  'multi-select first Enter must NOT auto-finalize (lands on the confirm screen)',
);
const confirmScreen = confirmPanel.render().join('\n');
assert.ok(
  confirmScreen.includes('Summary'),
  'after confirming a multi-select set, the deck shows the Summary/confirm screen',
);
// Second deliberate Enter on the Summary screen finalizes.
confirmPanel.handleKey('', RETURN);
assert.equal(
  confirmFired,
  true,
  'second Enter on the Summary screen finalizes the multi-select deck',
);
assert.deepEqual(
  confirmResponses,
  [{ id: 'cs1', selectedOptionIds: ['mush'] }],
  'confirmed multi-select set returned on finalize',
);
confirmPanel.unmount();

// ── Test 20: empty multi-select Enter is a no-op (does not finalize or advance) ──
// Regression for: Enter with zero options toggled committed {selectedOptionIds:[]}
// and finalized the deck. Now it's a no-op with an inline hint; the deck is not
// stuck — picking an option and confirming still works.

const emptyDeck: Deck = {
  interactions: [
    {
      id: 'es1', title: 'Pick toppings', multiSelect: true,
      options: [
        { id: 'mush', label: 'Mushroom', shortcut: 'a' },
        { id: 'onion', label: 'Onion', shortcut: 'b' },
      ],
    },
  ],
};

let emptyFired = false;
const emptyPanel = mountPanel({
  deck: emptyDeck,
  cols: 80,
  rows: 24,
  onComplete: () => { emptyFired = true; },
});

// Cursor on 'mush', nothing toggled. Enter must be a no-op.
emptyPanel.handleKey('', RETURN);
assert.equal(emptyFired, false, 'Enter with an empty multi-select set must NOT finalize');
const stillReview = emptyPanel.render().join('\n');
assert.ok(
  stillReview.includes('Pick toppings'),
  'after empty Enter, still on the interaction (no advance)',
);
assert.ok(
  !stillReview.includes('Summary'),
  'after empty Enter, the deck did NOT advance to the Summary screen',
);
assert.ok(
  stillReview.toLowerCase().includes('select at least one'),
  'empty multi-select Enter surfaces an inline hint',
);
// Prove the deck is not trapped: pick an option, then confirm.
emptyPanel.handleKey('a', mkKey({})); // shortcut toggles 'mush' on
emptyPanel.handleKey('', RETURN);     // confirm → Summary
emptyPanel.handleKey('', RETURN);     // second Enter → finalize
assert.equal(emptyFired, true, 'after picking an option, the multi-select deck can still be confirmed');
emptyPanel.unmount();

// ── Test 21: Alt+Backspace deletes the previous word in freetext input ────────
// Required deliverable: Option/Alt+Backspace arrives as ESC+DEL (\x1b\x7f) /
// ESC+BS (\x1b\b), parsed by parseKeypress into key.meta+key.backspace, and
// deletes back over any trailing whitespace + the preceding word — matching
// macOS text-input behavior. The freetext buffer is end-anchored (no mid-string
// cursor), so forward word-delete (Option+Delete) and word-motion
// (Option+Left/Right) are deferred: they'd require introducing a cursor index.

const ALT_BACKSPACE = mkKey({ backspace: true, meta: true });

function freetextAfter(typed: string, ops: Key[]): string | undefined {
  const deck: Deck = {
    interactions: [{ id: 'w1', title: 'Notes', options: [], allowFreetext: true }],
  };
  let captured: InteractionResponse[] = [];
  const p = mountPanel({ deck, cols: 80, rows: 24, onComplete: (r) => { captured = r; } });
  p.handleKey('r', mkKey({}));                 // single-item deck → item-review; 'r' opens freetext
  for (const ch of typed) p.handleKey(ch, mkKey({}));
  for (const op of ops) p.handleKey('', op);
  p.handleKey('', RETURN);                     // submit freetext
  p.handleKey('', RETURN);                     // final → complete
  p.unmount();
  return captured[0]?.freetext;
}

assert.equal(
  freetextAfter('hello world foo', [ALT_BACKSPACE]),
  'hello world ',
  'Alt+Backspace deletes the trailing word, leaving the separating space',
);
assert.equal(
  freetextAfter('alpha beta   ', [ALT_BACKSPACE]),
  'alpha ',
  'Alt+Backspace deletes trailing whitespace then the preceding word',
);
assert.equal(
  freetextAfter('one two three', [ALT_BACKSPACE, ALT_BACKSPACE]),
  'one ',
  'repeated Alt+Backspace deletes successive words',
);
assert.equal(
  freetextAfter('solo', [ALT_BACKSPACE, ALT_BACKSPACE]),
  '',
  'Alt+Backspace at start-of-buffer is a no-op (no underflow past empty)',
);

// ── Test 22: raw iTerm2 control bytes drive word-delete / line-clear ──────────────
// iTerm2 maps Option+Backspace → bare 0x17 (Ctrl-W) and Cmd+Backspace → bare
// 0x15 (Ctrl-U), with no ESC prefix. These are fed through the real
// parseKeypress so the terminal-layer mapping is exercised end-to-end, not just
// the synthetic meta+backspace key tested above.

function freetextRaw(typed: string, rawOps: string[]): string | undefined {
  const deck: Deck = {
    interactions: [{ id: 'w2', title: 'Notes', options: [], allowFreetext: true }],
  };
  let captured: InteractionResponse[] = [];
  const p = mountPanel({ deck, cols: 80, rows: 24, onComplete: (r) => { captured = r; } });
  p.handleKey('r', mkKey({}));                 // single-item deck → item-review; 'r' opens freetext
  for (const ch of typed) p.handleKey(ch, mkKey({}));
  for (const raw of rawOps) {
    const { input, key } = parseKeypress(Buffer.from(raw, 'utf8'));
    p.handleKey(input, key);
  }
  p.handleKey('', RETURN);                     // submit freetext
  p.handleKey('', RETURN);                     // final → complete
  p.unmount();
  return captured[0]?.freetext;
}

assert.equal(
  freetextRaw('hello world foo', ['\x17']),
  'hello world ',
  'bare 0x17 (Ctrl-W, iTerm2 Option+Backspace) deletes the trailing word',
);
assert.equal(
  freetextRaw('alpha beta   ', ['\x17']),
  'alpha ',
  '0x17 deletes trailing whitespace then the preceding word',
);
assert.equal(
  freetextRaw('one two three', ['\x17', '\x17']),
  'one ',
  'repeated 0x17 deletes successive words',
);
assert.equal(
  freetextRaw('clear me out', ['\x15']),
  '',
  'bare 0x15 (Ctrl-U, iTerm2 Cmd+Backspace) deletes to line start (clears buffer)',
);
assert.equal(
  freetextRaw('keep', ['\x15', '\x15']),
  '',
  '0x15 on an already-empty buffer is a no-op',
);

console.log('OK');
