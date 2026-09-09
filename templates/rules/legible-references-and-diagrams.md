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

## 4. Choosing a diagram type

A diagram is only worth its tokens if the shape it draws matches the relationship you are
describing. Picking the wrong type costs the reader more than prose would.

**First decide whether a diagram is warranted at all.** A list of things is a table. A
before-and-after is a table. One shape is a sentence. Reach for a diagram only when the
RELATIONSHIPS between things carry the meaning.

**Then pick the type from the table below and stop reading.** Do not scan every row; find the
`pick it when` cue that matches what you are describing and use that kind. If two cues fit, the
relationship is probably two diagrams.

<!-- BEGIN GENERATED diagram-kinds (source: scripts/lib/diagrams/registry.mjs; regenerate with
     `node .llm-wiki-memory/src/scripts/cli.mjs render-diagram --list --table`) -->

| kind | use it for | pick it when |
|---|---|---|
| `architecture` | a system overview grouped into tiers or trust boundaries | you need boundary frames drawn around groups of components |
| `bar` | comparing a magnitude across a few named things | the categories have no order and you are ranking them |
| `er` | entities, their fields, and how they relate | the reader needs the field names, not just the boxes |
| `fishbone` | candidate causes of one effect, grouped | you are still diagnosing and the causes group naturally |
| `flow` | services and stores exchanging messages | the edges carry a payload worth naming |
| `flowchart` | branching logic with decisions | a reader has to answer a question to know where they go next |
| `gantt` | work items across a time axis | each item has a start and an end, and overlap matters |
| `high-level` | an end-to-end stack across named phases | you need the whole platform on one page, phase by phase |
| `kanban` | work items grouped by state | a census of what sits where, with no flow between items |
| `layers` | a strict hierarchy of abstraction levels | each band sits ON the one below and nothing skips |
| `line` | how one or more measures move over an ordered axis | the x axis has a direction, usually time |
| `loop` | a cycle where each stage feeds the next | the last stage returns to the first |
| `medallion` | data tiers of the same dataset by quality level | each tier is a refined copy, with a writer and a format |
| `nested` | containment: what runs inside what | the relationship is inside, not talks-to |
| `org-chart` | who owns what: people, teams, or agents | the nodes are owners and the reader needs the invocation path |
| `polar` | magnitude around a cycle | the axis wraps: hours, months, compass headings |
| `pyramid` | stages that shed volume, or a layered hierarchy | each stage is a subset of the one above |
| `quadrant` | placing options on two judgement axes | you are prioritising and the four corners have names |
| `radar` | one or two options scored on the same few criteria | the SHAPE of a trade-off is the point, not exact values |
| `sankey` | quantities flowing and splitting between stages | you need to see where the volume goes, not just the path |
| `scatter` | whether two measures relate | you are looking for correlation, not comparing categories |
| `sequence` | an ordered exchange between a few actors | the ORDER of the steps is the point |
| `state` | a lifecycle: the states a thing can be in | the same entity changes status over time |
| `swimlane` | one process crossing several owners | WHO does each step matters as much as the order |
| `timeline` | dated events along one axis | WHEN each thing happened is the point |
| `tree` | parent-to-child hierarchy, one parent each | no node has two parents; otherwise use flow |
| `treemap` | how a total divides into parts, by area | the relative SIZE of the parts is the message |
| `venn` | two or three sets and what they share | the OVERLAP is the thing you are describing |
| `wardley` | a value chain against how evolved each part is | you are arguing about build versus buy |

<!-- END GENERATED diagram-kinds -->

That table is GENERATED from the renderer registry, so it is always what the engine can actually
draw. `render-diagram --list` prints the same catalogue as JSON at any time; a kind that is not
listed does not exist, and asking for it fails loudly rather than rendering something else.
A drift test fails the build if this copy and the registry disagree, so trust the table.

**Authoring is one command**, and it self-checks:

```
node .llm-wiki-memory/src/scripts/cli.mjs render-diagram --spec <file.mjs> --strict
```

`--strict` refuses to emit a diagram with geometric defects (a label sitting on a box, a run
cutting through an unrelated node, content clipped outside the frame). Use `--html --out <file>`
to produce a page you can actually LOOK at before saving; the mechanical check and the eye catch
different failures, and a diagram that passes one can still be unreadable.

Inline SVG is the default for a wiki leaf. Fall back to a ```mermaid fence only when the diagram
is trivial, when the renderer refuses it, or when the target is not a wiki leaf (a README, a PR
body). **Put prose before the diagram**: a search hit returns a leaf's first 600 characters, so a
leaf that opens with `<svg` returns markup and no information. And state the portability cost
honestly: an SVG leaf renders richly in the wiki app, renders as NOTHING on GitHub (its sanitizer
drops inline `<svg>` outright), and is a screenful of raw markup in a terminal. The legend and the
surrounding prose therefore have to carry the facts on their own.

## 5. Verify the diagrams parse before saving

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
