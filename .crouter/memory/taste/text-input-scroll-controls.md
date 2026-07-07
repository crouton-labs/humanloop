---
kind: preference
when-and-why-to-read: When designing or changing keyboard behavior for a
  terminal text editor/input that sits beside another scrollable surface, this
  preference should be read because Silas wants editing navigation and
  surrounding-context scrolling to have distinct, directly reachable controls.
short-form: "Terminal text inputs: arrow keys navigate/edit the text; use a
  dedicated scroll control for surrounding context, not edge-triggered
  overloads."
system-prompt-visibility: preview
file-read-visibility: none
rationale: Silas rejected an edge-trigger design where Up/Down navigated comment
  text until the top/bottom, then started scrolling the question body; he
  explicitly did not want to be forced to hit a text edge before normal context
  scroll worked.
origin:
  created: 2026-07-07T02:36:30.847Z
  cwd: /Users/silasrhyneer/Code/cli/crouter
  node: mra0of6e-f6389f88
---

In terminal text input surfaces, arrow keys belong to the active text buffer: Up/Down move through multiline text, Left/Right move within the line/text. If the input is displayed alongside another scrollable body (question context, document body, surrounding pane), give that body a separate scroll affordance such as PageUp/PageDown or an explicit modified chord. Do not overload arrow keys so they scroll the surrounding body only after the text cursor reaches the top/bottom; edge-triggered mode changes make scrolling feel indirect and trap the user in cursor gymnastics.
