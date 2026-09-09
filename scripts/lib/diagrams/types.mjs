// JSDoc type vocabulary for the diagram renderer (type-only, no runtime exports —
// the same pattern as scripts/lib/types.mjs). A spec is authored by hand or by a
// generator and rendered to inline SVG for a wiki leaf.

/**
 * @typedef {"backend" | "store" | "external" | "ghost" | "focal"} NodeKind
 * The visual treatment of a box. Each maps to a `.nb.<kind>` CSS class in
 * `svgStyle()`; `backend` is the default card.
 */

/**
 * @typedef {"sync" | "async" | "store" | "focal"} EdgeKind
 * The line style, which is how a reader tells coupling apart without reading a
 * label: solid = synchronous, dashed = asynchronous, thick = storage.
 */
/**
 * @typedef {"box" | "state" | "diamond" | "terminator" | "dot" | "end"} NodeShape
 * The silhouette, which is what tells a reader the node's ROLE: a rectangle is a
 * step, a diamond a decision, a stadium a start/end terminator, a filled dot an
 * entry or merge point, a ringed dot a final state. Type is never signalled by
 * fill, so the accent stays free for emphasis.
 */

/**
 * @typedef {Object} DiagramNode
 * @property {string} id used by edges and zones to refer to this box
 * @property {string} label
 * @property {string} [sub] second line, rendered in the mono face
 * @property {number} row
 * @property {number} col
 * @property {number} [span] columns to span; widens the box
 * @property {number} [dy] manual vertical nudge
 * @property {boolean} [center] vertically centre between the first and last row
 * @property {NodeKind} [kind]
 * @property {NodeShape} [shape]
 */

/**
 * @typedef {Object} DiagramEdge
 * @property {string} from node id
 * @property {string} to node id
 * @property {string} [label] transport, payload, and what returns
 * @property {EdgeKind} [kind]
 * @property {"v" | "h" | "left"} [side] force the port axis, or bias the label left
 * @property {"v" | "h"} [orient] force the label's axis independently of the run
 * @property {"under" | "over" | "left" | "right"} [route] leave the direct path and take a lane
 * @property {number} [lane] distance from the routing base to the lane
 * @property {boolean} [global] route around the whole diagram, not just the two endpoints
 * @property {string} [d] a hand-written SVG path, overriding all routing
 * @property {number} [lx] absolute label centre x, disabling collision placement
 * @property {number} [ly] absolute label centre y, disabling collision placement
 * @property {number} [dx] label nudge
 * @property {number} [dy] label nudge
 * @property {number} [wrap] label wrap width in characters
 */

/**
 * @typedef {Object} DiagramZone
 * @property {string} label
 * @property {string[]} nodes ids enclosed by the zone
 * @property {number} [pad]
 */

/**
 * @typedef {Object} DiagramNote
 * @property {number} x
 * @property {number} y
 * @property {string} text
 * @property {"start" | "middle" | "end"} [anchor]
 */

/**
 * @typedef {Object} FlowSpec
 * @property {"flow"} [kind]
 * @property {string} id unique per document; namespaces the arrowhead marker ids
 * @property {string} title becomes the SVG's aria-label
 * @property {DiagramNode[]} nodes
 * @property {DiagramEdge[]} [edges]
 * @property {DiagramZone[]} [zones]
 * @property {DiagramNote[]} [notes]
 * @property {number} [colW]
 * @property {number} [colGap]
 * @property {number} [rowGap]
 * @property {number} [padX]
 * @property {number} [padY]
 * @property {number} [headroom] extra space above row 0, for a zone label
 * @property {number} [width] override the computed width
 * @property {number} [height] override the computed height
 * @property {number} [fitPad] padding added around the fitted content bounds
 */

/**
 * @typedef {Object} SequenceActor
 * @property {string} id
 * @property {string} label
 * @property {string} [sub]
 * @property {NodeKind} [kind]
 */

/**
 * @typedef {Object} SequenceStep
 * A message (`from`/`to`/`label`), a spanning note (`note`), or a phase divider
 * (`phase`). Exactly one of those three roles per step.
 * @property {string} [from] actor id
 * @property {string} [to] actor id; equal to `from` renders a self-call
 * @property {string} [label]
 * @property {EdgeKind} [kind]
 * @property {string} [note]
 * @property {string[]} [over] actor ids the note spans; defaults to all
 * @property {string} [phase]
 */

/**
 * @typedef {Object} SequenceSpec
 * @property {"sequence"} kind
 * @property {string} id
 * @property {string} title
 * @property {SequenceActor[]} actors
 * @property {SequenceStep[]} steps
 * @property {number} [actorW]
 * @property {number} [actorGap]
 */

/**
 * @typedef {Object} Layer
 * @property {string} name
 * @property {string} [tag] index eyebrow (`L3`, `07`, `APPLICATION`)
 * @property {string} [note] right-aligned annotation
 * @property {boolean} [focal] the one layer under discussion
 */

/**
 * @typedef {Object} LayerSpec
 * @property {"layers"} kind
 * @property {string} id
 * @property {string} title
 * @property {Layer[]} layers ordered top to bottom
 * @property {"alternating" | "uniform"} [fill]
 * @property {{ label: string, up?: boolean }} [direction] axis indicator in the left margin
 */

/**
 * @typedef {Object} TreeNode
 * @property {string} id
 * @property {string} label
 * @property {string} [sub]
 * @property {string} [parent] omitted for the root
 * @property {NodeKind} [kind]
 */

/**
 * @typedef {Object} TreeSpec
 * @property {"tree"} kind
 * @property {string} id
 * @property {string} title
 * @property {TreeNode[]} nodes
 */

/** @typedef {FlowSpec | SequenceSpec | LayerSpec | TreeSpec} DiagramSpec */

/**
 * @typedef {Object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {Object} Box
 * A laid-out node: its measured text plus its resolved position.
 * @property {DiagramNode} node
 * @property {string[]} lines wrapped label lines
 * @property {string[]} subLines wrapped sub lines
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} cx
 * @property {number} cy
 */

/**
 * @typedef {Object} Geom
 * The endpoints of an edge's run, after port snapping or lane routing.
 * @property {number} sx
 * @property {number} sy
 * @property {number} tx
 * @property {number} ty
 */

/**
 * @typedef {(x: number, y: number, w: number, h: number) => void} Track
 * Records a drawn rectangle so the final viewBox can be fitted to real content
 * rather than to the nominal layout size.
 */

/**
 * @typedef {Object} ZoneBounds
 * @property {number} x
 * @property {number} y
 * @property {number} x2
 * @property {number} y2
 */

export {};
