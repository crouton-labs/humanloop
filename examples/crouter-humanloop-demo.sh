#!/usr/bin/env bash
# crouter ⇄ humanloop demo
# ---------------------------------------------------------------------------
# Demonstrates crouter routing its agent→human surface through the new
# humanloop interaction layer: a real crouter plan artifact flows through
# humanloop's *compiled* validator + inbox scanner and the real `hl` binary
# (display / inbox / ask / propose), with a human resolving it and crouter
# consuming the ResolutionEnvelope to gate the workflow.
#
# Each step is annotated with the exact crouter call site it replaces
# (see ~/.crouter/.../plans/humanloop-interaction-layer/part-2-crouter.md).
#
#   MODE=simulate  (default)  fully headless; the "human" is simulated by
#                             writing response.json per the dir convention.
#   MODE=live                 spawns the real hl tmux panes for you to click.
#
# Usage:  ./crouter-humanloop-demo.sh            # simulate
#         MODE=live ./crouter-humanloop-demo.sh  # interactive (needs tmux)
# ---------------------------------------------------------------------------
set -euo pipefail

MODE="${MODE:-simulate}"
HL_ROOT="/Users/silasrhyneer/Code/cli/humanloop"
HL="node ${HL_ROOT}/dist/cli.js"
HL_LIB="${HL_ROOT}/dist/index.js"
CROUTER_SRC="/Users/silasrhyneer/Code/cli/crouter/src/core/artifact.ts"
REAL_PLAN="$HOME/.crouter/-Users-silasrhyneer-Code-cli/plans/humanloop-interaction-layer/part-2-crouter.md"

if [ -t 1 ]; then B=$(tput bold); D=$(tput dim); C=$(tput setaf 6); G=$(tput setaf 2); Y=$(tput setaf 3); R=$(tput sgr0); else B=; D=; C=; G=; Y=; R=; fi
say()  { printf '\n%s━━ %s ━━%s\n' "$B$C" "$1" "$R"; }
note() { printf '%s  %s%s\n' "$D" "$1" "$R"; }
run()  { printf '%s  $ %s%s\n' "$Y" "$1" "$R"; }

WS="$(mktemp -d /tmp/crouter-hl-demo.XXXXXX)"
IX="$WS/plan-approval"          # one interaction = one dir (hl inbox scans roots)
mkdir -p "$IX"
PLAN="$IX/plan.md"
[ -f "$REAL_PLAN" ] && cp "$REAL_PLAN" "$PLAN" || printf '# Plan: crouter ⇄ humanloop\n\nReplace the bare termrender call with humanloop.display().\n' > "$PLAN"
trap 'rm -rf "$WS"' EXIT

printf '%s\n' "${B}crouter ⇄ humanloop demo${R}  ${D}(mode=${MODE}, workspace=${WS})${R}"

# ── 0. BEFORE: crouter's current human surface ──────────────────────────────
say "0 · Today: crouter shells out to bare termrender"
note "crouter's only human-display path, $CROUTER_SRC :48-80"
if [ -f "$CROUTER_SRC" ]; then
  grep -nE "spawnSync\('termrender'|--tmux|--watch|openInTmuxPane" "$CROUTER_SRC" | head -6 | sed "s/^/${D}    /;s/\$/${R}/"
fi
note "Approval gate today = spawn a fresh Claude reviewer pane → 'crtr agent submit'."
note "Goal: route display + approval through humanloop instead. Termrender is now"
note "internal to humanloop — crouter no longer needs it on \$PATH."

# ── 1. crouter produces a Deck (the 'decks' / 'ask' part) ───────────────────
say "1 · crouter writes a Deck describing what it needs from the human"
cat > "$IX/deck.json" <<'JSON'
{
  "title": "Plan ready: crouter ⇄ humanloop (Part 2)",
  "source": { "askedBy": "crtr plan", "sessionName": "humanloop-interaction-layer" },
  "interactions": [
    {
      "id": "approve",
      "kind": "validation",
      "title": "Approve plan",
      "subtitle": "Swap crouter's bare termrender call for humanloop.display()?",
      "bodyPath": "plan.md",
      "options": [
        { "id": "approve", "label": "Approve — implement it", "shortcut": "a" },
        { "id": "changes", "label": "Request changes", "shortcut": "c" }
      ],
      "allowFreetext": true,
      "freetextLabel": "Reviewer notes"
    },
    {
      "id": "next",
      "kind": "decision",
      "title": "Next part",
      "subtitle": "After this merges, what should crouter queue next?",
      "options": [
        { "id": "part-3", "label": "Part 3 — sisyphus adopts humanloop" },
        { "id": "pause",  "label": "Pause — review in standup" }
      ]
    }
  ]
}
JSON
run "wrote $IX/deck.json  (deck.json + plan.md = a pending interaction dir)"
note "Convention: <dir>/deck.json (request) → response.json (answer) → progress.json (resume)."

# ── 2. Validate the Deck through humanloop's REAL compiled validator ────────
say "2 · humanloop validates crouter's deck (real compiled code path)"
run "node -e \"validateInput(JSON.parse(deck.json))\"  via $HL_LIB"
cat > "$WS/validate.mjs" <<EOF
import { readFileSync } from 'node:fs';
import { validateInput } from '${HL_LIB}';
const deck = JSON.parse(readFileSync('${IX}/deck.json','utf8'));
const v = validateInput(deck);
console.log('  ✓ valid Deck — '+v.interactions.length+' interactions: '+v.interactions.map(i=>i.id+'('+(i.kind||'?')+')').join(', '));
EOF
node "$WS/validate.mjs" | sed "s/^/${G}/;s/\$/${R}/"

# ── 3. Show the plan (replaces termrender call at artifact.ts:48-80) ─────────
say "3 · Show the plan — humanloop.display() replaces the termrender block"
note "Part 2: delete the spawnSync('termrender',…) block; call instead:"
printf "%s    import { display } from '@crouton-kit/humanloop';\n" "$D"
printf "    const { paneId } = display(path, { watch: true, maxPanes: cfg.max_panes_per_window });%s\n" "$R"
if [ "$MODE" = live ]; then
  run "hl display $PLAN"
  $HL display "$PLAN" || note "(display needs tmux; skipped)"
else
  run "hl display $PLAN          # live mode spawns the real tmux pane"
  note "(simulate: pane spawn skipped — termrender provisioning already verified)"
fi

# ── 4. Human resolves it (the 'inbox' / 'ask' part) ─────────────────────────
say "4 · Human sees it in the inbox (real compiled scanInbox)"
cat > "$WS/scan.mjs" <<EOF
import { scanInbox } from '${HL_LIB}';
for (const it of scanInbox(['${WS}']))
  console.log('  ▸ ['+(it.kind||'?')+'] '+(it.title||it.id)+'  — from '+(it.source?.askedBy||'?'));
EOF
run "node -e \"scanInbox(['$WS'])\"  via $HL_LIB"
node "$WS/scan.mjs" | sed "s/^/${C}/;s/\$/${R}/"

if [ "$MODE" = live ]; then
  say "4b · LIVE — answer it in the real humanloop TUI"
  run "hl inbox $WS"
  $HL inbox "$WS"
else
  say "4b · SIMULATE — a human answers via 'hl inbox' (writing response.json)"
  cat > "$IX/response.json" <<JSON
{
  "responses": [
    { "id": "approve", "selectedOptionId": "approve", "freetext": "LGTM — keep the ENOENT hint UX." },
    { "id": "next", "selectedOptionId": "part-3" }
  ],
  "completedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
JSON
  run "wrote $IX/response.json   # what hl writes when the human hits done"
fi

# ── 5. crouter consumes the ResolutionEnvelope to gate the workflow ─────────
say "5 · crouter reads the answer back and gates (replaces 'crtr agent submit')"
run "hl schema response   # the humanloop.response/v2 contract crouter codes to"
$HL schema response | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("  "+j["$id"]+"  required: "+(j.required||Object.keys(j.properties||{})).join(", "))})' | sed "s/^/${D}/;s/\$/${R}/"

if [ -f "$IX/response.json" ]; then
  cat > "$WS/consume.mjs" <<EOF
import { readFileSync } from 'node:fs';
const deck = JSON.parse(readFileSync('${IX}/deck.json','utf8'));
const res = JSON.parse(readFileSync('${IX}/response.json','utf8'));
const lbl = (iid,oid)=>{ const i=deck.interactions.find(x=>x.id===iid); const o=i?.options?.find(x=>x.id===oid); return o?o.label:(oid||'(skipped)'); };
const summary = res.responses.map(r=>{ const i=deck.interactions.find(x=>x.id===r.id);
  return (i?.title||r.id)+': '+lbl(r.id,r.selectedOptionId)+(r.freetext?'  — "'+r.freetext+'"':''); }).join('\\n  ');
const envelope = { summary, responsePath:'${IX}/response.json', schema:'humanloop.response/v2', responses:res.responses, completedAt:res.completedAt };
console.log('\\n  ResolutionEnvelope crouter receives:');
console.log(JSON.stringify(envelope,null,2).split('\\n').map(l=>'    '+l).join('\\n'));
const approve = res.responses.find(r=>r.id==='approve');
const next = res.responses.find(r=>r.id==='next');
console.log('\\n  → crouter gate:');
if (approve?.selectedOptionId==='approve') {
  console.log('     ✓ approved  → crtr proceeds: \`crtr agent implement\` Part 2');
  console.log('     ↳ then queues: '+lbl('next',next?.selectedOptionId));
} else {
  console.log('     ✗ changes requested → crtr re-plans with reviewer notes; no implement.');
}
EOF
  node "$WS/consume.mjs" | sed "s/^/${G}/;s/\$/${R}/"
fi

# ── 6. propose: richer line-anchored review ─────────────────────────────────
say "6 · 'hl propose' — line-anchored review (replaces the read-only reviewer pane)"
if [ "$MODE" = live ]; then
  run "hl propose $PLAN --no-tmux"
  $HL propose "$PLAN" --no-tmux || true
else
  run "hl propose $PLAN        # opens plan READ-ONLY in nvim; comments anchor to lines"
  note "Any quit submits; zero comments ⇒ {approved:true}. Full record → <file>.feedback.json."
  note "crouter would use this instead of spawning a Claude reviewer for human-authored review."
fi

say "done"
note "Mapped to crouter call sites:"
note "  display()  ⇆  artifact.ts:48-80 openInTmuxPane (bare termrender)  [Part 2]"
note "  ask/inbox  ⇆  spawnSidePaneReview + 'crtr agent submit' approval gate"
note "  propose    ⇆  read-only reviewer pane → inline line-anchored feedback"
[ "$MODE" = simulate ] && printf '\n%sRe-run interactively:%s  MODE=live %s\n' "$B" "$R" "$0"
