import { test, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AskPanel } from "./AskPanel";
import { AskResponseSchema } from "../shared/contract.mjs";

const ANSWER = {
  answer: {
    id: "knowledge/backend/decision/general/postgres.md",
    name: "postgres.md",
    title: "Postgres is the database of record",
    category: "knowledge",
    content: "We use Postgres for durable relational storage.",
  },
  sources: [
    {
      id: "knowledge/backend/decision/general/kafka.md",
      name: "kafka.md",
      title: "Kafka for event streaming",
      location: "Knowledge › Backend › Decision",
      category: "knowledge",
      score: 0.64,
      snippet: "Kafka topics",
    },
    {
      id: "knowledge/backend/decision/general/redis.md",
      name: "redis.md",
      title: "Redis for caching",
      location: "Knowledge › Backend › Decision",
      category: "knowledge",
      score: 0.52,
      snippet: "Redis cache",
    },
  ],
};
const EMPTY = { answer: null, sources: [] };

beforeAll(() => {
  AskResponseSchema.parse(ANSWER);
  AskResponseSchema.parse(EMPTY);
});

function stubAsk(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = String(input);
      const payload = url.includes("/ask") ? body : {};
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload),
      } as unknown as Response);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

function renderPanel(onOpenDoc = vi.fn(), onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AskPanel wikiId="w1" onOpenDoc={onOpenDoc} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onOpenDoc, onClose };
}

const submit = (q: string) => {
  fireEvent.change(screen.getByPlaceholderText(/Ask your memory/), { target: { value: q } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
};

test("submitting a question renders the answer title and its ranked sources", async () => {
  stubAsk(ANSWER);
  renderPanel();
  submit("what database do we use");
  await waitFor(() => expect(screen.getByText("Postgres is the database of record")).toBeTruthy());
  expect(screen.getByText("Sources")).toBeTruthy();
  expect(screen.getByText("Kafka for event streaming")).toBeTruthy();
  expect(screen.getByText(/0\.64/)).toBeTruthy();
});

test("clicking the answer opens its doc and closes the panel", async () => {
  stubAsk(ANSWER);
  const { onOpenDoc, onClose } = renderPanel();
  submit("db");
  await waitFor(() => screen.getByText("Postgres is the database of record"));
  fireEvent.click(screen.getByText("Postgres is the database of record"));
  expect(onOpenDoc).toHaveBeenCalledWith("knowledge/backend/decision/general/postgres.md");
  expect(onClose).toHaveBeenCalled();
});

test("clicking a source opens that source's doc and closes the panel", async () => {
  stubAsk(ANSWER);
  const { onOpenDoc, onClose } = renderPanel();
  submit("db");
  await waitFor(() => screen.getByText("Kafka for event streaming"));
  fireEvent.click(screen.getByText("Kafka for event streaming"));
  expect(onOpenDoc).toHaveBeenCalledWith("knowledge/backend/decision/general/kafka.md");
  expect(onClose).toHaveBeenCalled();
});

test("a question with no match shows the empty state", async () => {
  stubAsk(EMPTY);
  renderPanel();
  submit("nothing matches this");
  await waitFor(() => expect(screen.getByText("No matches found.")).toBeTruthy());
});

test("no request is made until a question is submitted (empty query stays idle)", async () => {
  const fetchSpy = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY) } as unknown as Response),
  );
  vi.stubGlobal("fetch", fetchSpy);
  renderPanel();
  fireEvent.change(screen.getByPlaceholderText(/Ask your memory/), { target: { value: "draft" } });
  await new Promise((r) => setTimeout(r, 50));
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("the close button and Escape both close the panel", async () => {
  stubAsk(EMPTY);
  const { onClose } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("button", { name: "Ask" }).closest("form")!, {
    key: "Escape",
  });
  expect(onClose).toHaveBeenCalledTimes(2);
});
