// The theme block, emitted once per document alongside the diagrams.
//
// Everything resolves through CSS custom properties keyed off the host's `dark`
// class, so one markup payload serves both themes: a diagram authored in light
// mode is legible in dark mode without being re-rendered. Font stacks are all
// system faces on purpose — a remote font link inside a wiki leaf would be a
// network dependency and, in a shared wiki, a third-party request from whoever
// happens to read the page.

/** @returns {string} */
export function svgStyle() {
  return `<style>
.dd{margin:0}
.dd svg{--paper:#f5f5f5;--paper2:#ececec;--card:#ffffff;--ink:#2d3142;--muted:#4f5d75;
--soft:#7a8399;--rule:rgba(45,49,66,.12);--wash:rgba(45,49,66,.04);--zone:rgba(45,49,66,.02);
--zone-line:rgba(45,49,66,.10);--accent:#eb6c36;--accent-tint:rgba(235,108,54,.10);
--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
html.dark .dd svg{--paper:#2d3142;--paper2:#393e53;--card:#39405a;--ink:#f5f5f5;--muted:#bfc0c0;
--soft:#9aa3b6;--rule:rgba(245,245,245,.14);--wash:rgba(245,245,245,.05);--zone:rgba(245,245,245,.03);
--zone-line:rgba(245,245,245,.12);--accent:#f08a59;--accent-tint:rgba(240,138,89,.14)}
.dd .bg{fill:var(--paper)}
.dd .zone{fill:var(--zone);stroke:var(--zone-line);stroke-width:.8}
.dd .zlab{fill:var(--soft);font:500 8px var(--mono);letter-spacing:.16em}
.dd .zmask{fill:var(--paper)}
.dd .nb{fill:var(--card);stroke:var(--ink);stroke-width:1}
.dd .nb.focal{fill:var(--accent-tint);stroke:var(--accent);stroke-width:1.4}
.dd .nb.store{fill:var(--wash);stroke:var(--muted);stroke-width:1}
.dd .nb.external{fill:var(--wash);stroke:var(--rule);stroke-width:1}
.dd .nb.ghost{fill:none;stroke:var(--rule);stroke-width:1;stroke-dasharray:4 3}
.dd .nn{fill:var(--ink);font:600 12px var(--sans)}
.dd .nn.on-focal{fill:var(--ink)}
.dd .ns{fill:var(--soft);font:400 9px var(--mono)}
.dd .e{fill:none;stroke:var(--muted);stroke-width:1.2;stroke-linecap:round}
.dd .e.async{stroke-dasharray:5 4;stroke-width:1}
.dd .e.store{stroke:var(--ink);stroke-width:2.4;opacity:.8}
.dd .e.focal{stroke:var(--accent);stroke-width:1.6}
.dd .el{fill:var(--muted);font:400 8.5px var(--mono);letter-spacing:.04em}
.dd .el.focal{fill:var(--accent)}
.dd .emask{fill:var(--paper)}
.dd .note{fill:var(--soft);font:italic 400 11px var(--sans)}
.dd .life{stroke:var(--rule);stroke-width:1;stroke-dasharray:3 4}
.dd .seqnote{fill:var(--wash);stroke:var(--rule);stroke-width:.8}
.dd .seqdiv{stroke:var(--rule);stroke-width:.8}
.dd .dot{fill:var(--ink)}
.dd .ring{fill:none;stroke:var(--ink);stroke-width:1.2}
.dd .tag{fill:var(--soft);font:500 8.5px var(--mono);letter-spacing:.14em}
.dd .bus{fill:none;stroke:var(--muted);stroke-width:1}
.dd .lay{fill:var(--card);stroke:var(--ink);stroke-width:1}
.dd .lay.alt{fill:var(--paper2)}
.dd .lay.focal{fill:var(--accent-tint);stroke:var(--accent);stroke-width:1.4}
.dd .hair{stroke:var(--rule);stroke-width:1}
.dd .lname{fill:var(--ink);font:600 14px var(--sans)}
.dd .lnote{fill:var(--soft);font:400 9.5px var(--mono)}
.dd .grid{fill:none;stroke:var(--rule);stroke-width:.8;opacity:.55}
.dd .axis{fill:none;stroke:var(--muted);stroke-width:1;opacity:.7}
.dd .tick{fill:var(--soft);font:400 8px var(--mono)}
.dd .clab{fill:var(--ink);font:600 11px var(--sans)}
.dd .atitle{fill:var(--muted);font:500 9px var(--mono);letter-spacing:.12em}
.dd .vlab{fill:var(--muted);font:400 8px var(--mono)}
.dd .vlab.focal{fill:var(--accent)}
.dd .mark{fill:var(--wash);stroke:var(--muted);stroke-width:1}
.dd .mark.focal{fill:var(--accent-tint);stroke:var(--accent);stroke-width:1.4}
.dd .mark.s1{fill:rgba(79,93,117,.18);stroke:var(--muted)}
.dd .mark.s2{fill:rgba(122,131,153,.18);stroke:var(--soft)}
.dd .mark.s3{fill:rgba(45,49,66,.12);stroke:var(--ink)}
.dd .mark.s4{fill:rgba(45,49,66,.06);stroke:var(--rule)}
.dd .ser{fill:none;stroke:var(--muted);stroke-width:1.2;stroke-linejoin:round}
.dd .ser.focal{stroke:var(--accent);stroke-width:1.8}
.dd .ser.s1{stroke:var(--muted)}
.dd .ser.s2{stroke:var(--soft)}
.dd .ser.s3{stroke:var(--ink);opacity:.75}
.dd .ser.s4{stroke:var(--rule)}
.dd .band{fill:var(--accent-tint);opacity:.5}
.dd .flow{fill:var(--muted);opacity:.22}
.dd .flow.focal{fill:var(--accent);opacity:.4}
.dd .swatch{fill:var(--wash);stroke:var(--muted);stroke-width:1}
.dd .swatch.focal{fill:var(--accent);stroke:var(--accent)}
.dd .swatch.s1{fill:rgba(79,93,117,.5)}
.dd .swatch.s2{fill:rgba(122,131,153,.5)}
.dd .swatch.s3{fill:rgba(45,49,66,.35)}
.dd .swatch.s4{fill:rgba(45,49,66,.18)}
</style>`;
}
