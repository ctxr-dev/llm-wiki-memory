import { test, expect } from "vitest";
import { render } from "@testing-library/react";
import { Highlight } from "./Highlight";

test("wraps each case-insensitive term match in a mark, preserving the text", () => {
  const { container } = render(<Highlight text="Kafka and kafka topics" query="KAFKA" />);
  expect(container.querySelectorAll("mark").length).toBe(2);
  expect(container.textContent).toBe("Kafka and kafka topics");
});

test("highlights every distinct term in a multi-word query", () => {
  const { container } = render(
    <Highlight text="durable event streaming across services" query="event streaming" />,
  );
  const marks = [...container.querySelectorAll("mark")].map((node) => node.textContent);
  expect(marks).toEqual(["event", "streaming"]);
});

test("renders plain text when the query has no usable terms", () => {
  const { container } = render(<Highlight text="hello world" query="a ," />);
  expect(container.querySelectorAll("mark").length).toBe(0);
  expect(container.textContent).toBe("hello world");
});
