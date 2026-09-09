import { defaultSchema } from "rehype-sanitize";
import { html, svg } from "property-information";

const EVENT_HANDLER = /^on[A-Z]/;

const UNSAFE_PROPERTIES = new Set([
  "xLinkHref",
  "xLinkShow",
  "xLinkActuate",
  "glyphRef",
  "action",
  "formAction",
  "formTarget",
  "background",
  "ping",
  "srcSet",
  "srcDoc",
  "is",
]);

const EXECUTABLE_TAGS = [
  "script",
  "iframe",
  "object",
  "embed",
  "base",
  "link",
  "meta",
  "noscript",
  "template",
  "frame",
  "frameset",
  "applet",
  "param",
  "portal",
  "handler",
  "listener",
  "animate",
  "animateMotion",
  "animateTransform",
  "set",
  "discard",
];

const EXTRA_PROPERTIES = ["dataDiagram"];

const EXTRA_HTML_TAGS = [
  "abbr",
  "address",
  "article",
  "aside",
  "audio",
  "bdi",
  "bdo",
  "big",
  "canvas",
  "center",
  "cite",
  "data",
  "dfn",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hgroup",
  "main",
  "mark",
  "menu",
  "meter",
  "nav",
  "output",
  "picture",
  "progress",
  "source",
  "strike",
  "style",
  "time",
  "track",
  "u",
  "video",
  "wbr",
];

const SVG_TAGS = [
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "switch",
  "desc",
  "metadata",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "marker",
  "pattern",
  "mask",
  "clipPath",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "foreignObject",
  "image",
  "view",
];

function safeProperties(): string[] {
  const names = new Set<string>(EXTRA_PROPERTIES);
  const derived = [
    ...Object.keys(html.property),
    ...Object.keys(svg.property),
    ...(defaultSchema.attributes?.["*"] ?? []).filter(
      (entry): entry is string => typeof entry === "string",
    ),
  ];
  for (const name of derived) {
    if (EVENT_HANDLER.test(name)) continue;
    if (UNSAFE_PROPERTIES.has(name)) continue;
    names.add(name);
  }
  return [...names].sort();
}

function allowedTagNames(): string[] {
  const blocked = new Set(EXECUTABLE_TAGS);
  const names = new Set<string>();
  for (const tag of [...(defaultSchema.tagNames ?? []), ...EXTRA_HTML_TAGS, ...SVG_TAGS]) {
    if (!blocked.has(tag)) names.add(tag);
  }
  return [...names];
}

export const DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml)[;,]/i;

export function isSafeDataImage(url: string): boolean {
  return DATA_IMAGE.test(url.trim());
}

type AttributeMap = NonNullable<typeof defaultSchema.attributes>;

function withoutClassNameRestrictions(source: AttributeMap): AttributeMap {
  const result: AttributeMap = {};
  for (const [tag, list] of Object.entries(source)) {
    result[tag] = (list ?? []).filter(
      (entry) => !(Array.isArray(entry) && entry[0] === "className"),
    );
  }
  return result;
}

export const SANITIZE_SCHEMA: typeof defaultSchema = {
  ...defaultSchema,
  clobberPrefix: "",
  tagNames: allowedTagNames(),
  attributes: {
    ...withoutClassNameRestrictions(defaultSchema.attributes ?? {}),
    "*": safeProperties(),
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "brain"],
    src: ["http", "https", "data"],
    poster: ["http", "https"],
  },
  strip: [...new Set([...(defaultSchema.strip ?? []), ...EXECUTABLE_TAGS])],
};
