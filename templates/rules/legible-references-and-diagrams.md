# Legible references and self-describing diagrams

A saved leaf is read by someone with none of the context that produced it, usually while they are
looking for one specific thing. Two habits decide whether that reader gets it at a glance or has
to reconstruct it from prose: **how references are written**, and **how much each diagram edge
says**. Both are cheap at authoring time and expensive to retrofit.

This rule applies to every leaf that references another document or contains a diagram — most
directly to `knowledge`, `plans`, `investigations` and `issues`. It complements
`content-quality` (which defines the reference *grammar*) by governing the reference's *presentation*.

## 1. A reference always reads as a title, never as a path

`content-quality` defines two accepted forms for a canonical reference. This rule settles which
to use, and the answer is nearly always the same one:

> **ALWAYS write a reference as a markdown link whose label is the TARGET DOCUMENT'S OWN TITLE**
> (or, when naming an entity in prose, that entity's name):
> `[hodor](brain:knowledge/hodor/reference/general/hodor-service-overview.md)`,
> `[Aerospike CDC bin values may be single- or double-JSON-encoded](brain:knowledge/usher/…)`.
>
> A bare path reference — `` `brain:knowledge/usher/pattern-gotcha/general/knowledge-aerospike-cdc-bin-values-…-2026-06-01-113036153.md` ``
> — is **useless to a reader**. It is 90 characters of machine identifier that says nothing about
> what is on the other end, and it wrecks the line it sits on.

**The label comes from the target, not from your paraphrase.** Read the target leaf's title (its
`focus:` frontmatter, or its top heading) and use it. Inventing a label risks describing the
document as you remember it rather than as it is — the same staleness failure the durability
rules exist to prevent. When a title is unusually long, cut it at a natural clause boundary and
keep the target's own words; do not rewrite it.

**The only exception:** when the path *itself* is the subject — documenting the id scheme,
demonstrating where leaves are placed, or showing a compiler's output. There the path is the
content, so a code span is correct. That case is rare; if you are not deliberately showing a
path, you are writing a link.

Also:

- **Never** paste a raw path into a sentence as if it were prose.
- **Link on first mention per section**, not every occurrence. Linking every instance turns a
  paragraph into a field of underlines and buries the useful links.
- **Never self-link** a leaf to itself.
- A reference is still subject to the durability rules: link to a leaf, never to a filesystem
  path, and never to a document id containing a lifecycle segment.

**Why:** a reference is only useful if it gets followed, and a reader follows a title far more
readily than an identifier. A "Related" list of fifteen bare paths is not a set of onward routes
— it is a wall the reader skips, which means the connections you took the trouble to record are
never actually traversed.

### Ordering a list of references

> **A list of references is ORDERED MOST-RELEVANT FIRST.** "Related", "Topic-specific depth",
> "See also", "Sources" — every such list is ranked, not arbitrary and not alphabetical.

Relevance is judged **from the position of a reader who is on this page right now**, which
usually produces this shape:

1. **Deepest detail on this document's own subject** — the gotcha, decision or root cause that
   changes how someone works with the thing they are currently reading about.
2. **Immediate neighbours** — the direct upstream and downstream, the things it calls and the
   things that call it.
3. **Broader context last** — the platform map, the parent overview, the process guide.

The common mistake is leading with the parent overview because it feels hierarchically first.
It is the *least* specific item in the list: the reader most likely arrived from it, and if they
did not, it is still the entry they need least urgently. Put it at the bottom.

**Deviate deliberately, and only for a stated reason.** Another ordering may genuinely serve the
reader better — grouped by domain when a list spans several subsystems, chronological for a
sequence of decisions, or by lifecycle stage for a pipeline. When you use one of those, make it
visible (a lead-in line, or sub-headings), so the reader knows the order carries meaning.
Alphabetical is almost never the right answer: it encodes nothing.

For a long list, a short lead-in stating the ordering is worth the line — it tells the reader the
top entries are the ones to spend attention on.

## 2. Every diagram edge states what flows across it

An arrow that merely connects two boxes asserts that a relationship exists while withholding
what it is. The reader then has to find the answer in prose — which is the failure this rule
exists to prevent.

> **Every edge between two nodes carries a label naming the transport, the payload, and what
> comes back.** An unlabelled arrow is incomplete, the same way an untyped function signature is.

Label grammar:

- **Synchronous call:** `transport verb: request → response`
  e.g. `gRPC fetch: orderId → prior OrderState`, `HTTP POST /convert: OrderEvent JSON → 200 / 425`
- **Asynchronous hop:** `channel: payload`
  e.g. `Kafka core.fct.captured-order.1: CapturedOrder Avro`, `SQS hodor_async.fifo: SubmissionRequest when interrupted`
- **Storage access:** the operation and what is touched
  e.g. `write raw order + id mapping`, `acquire order lock, 1 min TTL`

Encode the *kind* of relationship in the line style, so synchronous and asynchronous coupling are
distinguishable without reading a single label:

| Style | Meaning |
|---|---|
| solid `-->` | Synchronous call — the caller waits for a response |
| dotted `-.->` | Asynchronous hop — a queue, a topic, a change stream |
| thick `==>` | Storage read or write |

**Put a one-line legend directly above each diagram** (or once per document if it holds several).
A key the reader has to hunt for is a key they will not use.

## 3. A diagram is sufficient on its own — and the prose still stays

The test to apply before saving:

> Could a reader who reads **only** this diagram explain what talks to what, over what, carrying
> what, and in which direction the reply travels? If they would have to drop into the prose to
> answer, the diagram is not finished.

This never licenses deleting the prose. The diagram carries the *shape*; the prose carries the
*why*, the exceptions, the failure modes and the history — the things a diagram cannot hold
without becoming unreadable. Optimising the diagram is additive.

Keep diagrams individually small and focused. One diagram per flow, with labelled edges, beats a
single all-encompassing graph that is technically complete and practically unreadable. When a
diagram grows past roughly a dozen nodes, split it by flow rather than shrinking the labels.

## 4. Verify the diagrams parse before saving

A diagram that fails to render is worse than no diagram: it occupies the place the reader looks
first and yields an error box. Mermaid syntax is easy to get subtly wrong — especially inside
edge labels, which is exactly where this rule adds text.

Parse every diagram before the leaf is saved, using the same renderer version the reading surface
uses. Do not rely on visual inspection.

## Quick reference

| Situation | Do this |
|---|---|
| Naming a service or component that has a leaf, in prose | `[name](brain:<id>)` — label is the entity's name |
| Listing sources under "Related" | `[target's own title](brain:<id>)` — read the title from the target |
| A path in running text | Never — convert it to a titled link |
| You genuinely need to show a path (id scheme, placement demo) | Code span is correct — this is the one exception |
| The same entity named five times in one section | Link the first mention only |
| Drawing an arrow between two nodes | Label it: transport, payload, and what returns |
| Sync vs async distinction | Encode it in the line style, plus a legend |
| Diagram is getting crowded | Split by flow; do not shrink the labels |
| Before saving | Parse every diagram against the real renderer |
