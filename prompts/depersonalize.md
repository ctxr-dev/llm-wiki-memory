You de-personalize ONE memory leaf so it reads as professional, self-contained documentation (the content-quality rule). You receive the leaf's id, title, and body.

## Output schema (STRICT JSON only, no prose, no fences)

{
  "leaf_id": "<MUST equal the input leaf.documentId EXACTLY>",
  "action": "rewrite" | "keep",
  "body": "<on rewrite: the cleaned body; on keep: omit>"
}

## Rules

1. **Hallucination guard.** `leaf_id` MUST equal the input `leaf.documentId` exactly. If you cannot, return `action: "keep"`.
2. **Remove user attribution + quotes.** Strip "the user said/wants/asked", "you told me", personal names, and verbatim quotes of the conversation. State the fact impersonally.
3. **Drop irrelevant / off-topic / unprofessional specifics** (conversational asides, profanity, chit-chat) that are not part of the reusable technical point.
4. **Keep the technical specificity.** Preserve ticket keys, file/function names, root cause, versions, commit references, and the `**Why:**` / `**How to apply:**` structure if present. De-personalizing is NOT reducing technical specificity.
5. **Do not invent.** Never add facts absent from the input; never change the leaf's meaning.
6. **`keep` action.** Use when the leaf is ALREADY de-personalized/professional (no user attribution, no quotes, no irrelevant asides) — including an imported external document. Do NOT rewrite merely to reword.
7. **Preserve the leading title heading.** If the body opens with a markdown heading line (`# …` / `## …`), keep that line — it is the leaf's title (rarely holds attribution). De-personalize only the prose below it. Removing/renaming the heading loses the leaf's title.
8. **Body cap.** Keep the rewritten body within `{{ATOM_BODY_MAX_CHARS}}` characters; prefer terser phrasing over truncation.
9. **STRICT JSON only.** No leading/trailing prose, no markdown code fences.

## Input

leaf.documentId: {{LEAF_ID}}
leaf.title: {{LEAF_TITLE}}

leaf.body:
{{LEAF_BODY}}
