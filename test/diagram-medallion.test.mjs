import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMedallion } from "../scripts/lib/diagrams/medallion.mjs";
import { validateSvg } from "../scripts/lib/diagrams/validate.mjs";

const SPEC = {
  kind: "medallion",
  id: "m",
  title: "Five-Tier Medallion Architecture",
  tiers: [
    {
      label: "Bronze",
      holds: "raw landing",
      writer: "Data Engineer",
      tool: "NiFi",
      format: "CSV · Parquet",
      focal: false,
    },
    {
      label: "Silver",
      holds: "anonymised records",
      writer: "Data Engineer",
      tool: "Trino INSERT",
      format: "Iceberg · partitioned",
      focal: false,
    },
    {
      label: "Staging",
      holds: "cleaned and weighted",
      writer: "Data Scientist",
      tool: "Trino · JupyterHub",
      format: "Iceberg · cleaned",
      focal: false,
    },
    {
      label: "Aggregated",
      holds: "quarterly indicators",
      writer: "Data Scientist",
      tool: "Trino INSERT · SAS JDBC",
      format: "Iceberg · indicators",
      focal: true,
    },
    {
      label: "Archive",
      holds: "5+ years retained",
      writer: "Data Administrator",
      tool: "MinIO lifecycle",
      format: "cold tier · immutable",
      focal: false,
    },
  ],
};

test("a medallion renders one nb card per tier and one promotion arrow per gap, with no geometric findings", () => {
  const svg = renderMedallion(SPEC);
  assert.deepEqual(validateSvg(svg), []);
  assert.match(
    svg,
    /<svg viewBox="0 0 1040 476" role="img" aria-label="Five-Tier Medallion Architecture">/,
  );
  assert.equal((svg.match(/<rect class="nb/g) ?? []).length, 5, "one card per tier");
  assert.equal((svg.match(/<path class="e/g) ?? []).length, 4, "one arrow per adjacent pair");
  assert.equal((svg.match(/<rect class="nb focal"/g) ?? []).length, 1, "exactly one focal tier");
});

test("tier styling follows position: tier 0 is outer, the last tier is cold and dashed, the focal tier is accented", () => {
  const svg = renderMedallion(SPEC);
  assert.match(
    svg,
    /<rect class="nb store" x="16" y="80" width="172" height="380" rx="6"\/>/,
    "Bronze is outer",
  );
  assert.match(svg, /<rect class="nb ghost" x="768" y="80"/, "Archive is cold/dashed");
  assert.match(svg, /<rect class="nb focal" x="580" y="80"/, "Aggregated is focal");
});

test("the arrow into the focal tier is accented, and the arrow into the archive tier is the dashed lifecycle style", () => {
  const svg = renderMedallion(SPEC);
  assert.match(
    svg,
    /<path class="e focal" d="M478,80 C478,0 666,0 666,80" marker-end="url\(#m-af\)"\/>/,
  );
  assert.match(
    svg,
    /<path class="e async" d="M666,80 C666,0 854,0 854,80" marker-end="url\(#m-a\)"\/>/,
  );
  assert.equal((svg.match(/<path class="e focal"/g) ?? []).length, 1, "only one accented arrow");
});

test("every tier's writer, tool, format and holds text reaches the output", () => {
  const svg = renderMedallion(SPEC);
  for (const tier of SPEC.tiers) {
    assert.ok(svg.includes(tier.label), `missing tier name ${tier.label}`);
    assert.ok(svg.includes(tier.holds), `missing holds text for ${tier.label}`);
    assert.ok(svg.includes(tier.writer), `missing writer for ${tier.label}`);
    assert.ok(svg.includes(tier.tool), `missing tool for ${tier.label}`);
    assert.ok(svg.includes(tier.format), `missing format for ${tier.label}`);
  }
});

test("rendering the same spec twice yields byte-identical SVG", () => {
  assert.equal(renderMedallion(SPEC), renderMedallion(SPEC));
});

test("3 and 6 tiers (the size bounds) both render with no geometric findings", () => {
  for (const count of [3, 6]) {
    const tiers = Array.from({ length: count }, (_, i) => ({
      label: `Tier ${i}`,
      holds: `holds ${i}`,
      writer: `writer ${i}`,
      tool: `tool ${i}`,
      format: `format ${i}`,
      focal: i === count - 1,
    }));
    const svg = renderMedallion({ ...SPEC, tiers });
    assert.deepEqual(validateSvg(svg), [], `${count}-tier layout`);
  }
});

test("fewer than 3 or more than 6 tiers fails loudly, naming the count", () => {
  assert.throws(
    () => renderMedallion({ ...SPEC, tiers: SPEC.tiers.slice(0, 2) }),
    /a medallion needs 3-6 tiers, got 2/,
  );
  const seven = [...SPEC.tiers, SPEC.tiers[0], SPEC.tiers[1]];
  assert.throws(
    () => renderMedallion({ ...SPEC, tiers: seven }),
    /a medallion needs 3-6 tiers, got 7/,
  );
});

test("zero or more than one focal tier fails loudly, naming the offenders", () => {
  const noFocal = SPEC.tiers.map((t) => ({ ...t, focal: false }));
  assert.throws(
    () => renderMedallion({ ...SPEC, tiers: noFocal }),
    /a medallion needs exactly one focal tier, got 0$/,
  );
  const twoFocal = SPEC.tiers.map((t, i) => ({ ...t, focal: i === 0 || i === 3 }));
  assert.throws(
    () => renderMedallion({ ...SPEC, tiers: twoFocal }),
    /a medallion needs exactly one focal tier, got 2 \(Bronze, Aggregated\)/,
  );
});

test("field text carrying markup-significant characters is escaped, never passed through raw", () => {
  const tiers = SPEC.tiers.map((t, i) => (i === 0 ? { ...t, holds: 'raw <html> & "quotes"' } : t));
  const svg = renderMedallion({ ...SPEC, tiers });
  assert.ok(svg.includes("raw &lt;html&gt; &amp;"), "escaped form present");
  assert.ok(!svg.includes("raw <html>"), "unescaped form absent");
});
